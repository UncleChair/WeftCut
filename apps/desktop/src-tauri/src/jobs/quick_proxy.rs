//! Fast preview-first proxy generation.
//!
//! This proxy is allowed to trade quality for speed. Preview can use it as
//! soon as it exists; export must continue to ignore it and wait for either a
//! bypassed source or the full proxy.

use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{Context, Result};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use tokio::process::Command;

use crate::cache::{cached_ok, discard_temp, promote_temp, temp_path, CacheLayout};
use crate::jobs::hwaccel;
use crate::state::MediaItem;

const QUICK_PROXY_HEIGHT_CAP: u32 = 720;

pub async fn run(cache: &CacheLayout, media: &MediaItem) -> Result<PathBuf> {
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg not installed; cannot generate quick proxy");
    }

    let dest = cache.quick_proxy(&media.file_hash_blake3);
    if cached_ok(&dest) {
        return Ok(dest);
    }
    let tmp = temp_path(&dest);
    let _ = tokio::fs::remove_file(&tmp).await;

    let result = if can_remux(media) {
        run_remux(media, &tmp).await
    } else {
        run_fast_transcode(media, &tmp).await
    };

    if let Err(e) = result {
        discard_temp(&dest);
        return Err(e);
    }

    if !cached_ok(&tmp) {
        discard_temp(&dest);
        anyhow::bail!(
            "ffmpeg returned success but quick proxy output is missing or zero bytes at {}",
            tmp.display()
        );
    }

    promote_temp(&dest)?;
    Ok(dest)
}

fn can_remux(media: &MediaItem) -> bool {
    let Some(video) = media.metadata.video.as_ref() else {
        return false;
    };
    crate::jobs::proxy_decision::codec_is_h264(&video.codec)
        && crate::jobs::proxy_decision::pix_fmt_is_browser_friendly(&video.pix_fmt)
        && video.height <= 1080
}

async fn run_remux(media: &MediaItem, tmp: &PathBuf) -> Result<()> {
    let output = Command::new(ffmpeg_path())
        .args(["-y", "-hide_banner", "-nostats", "-loglevel", "error", "-i"])
        .arg(&media.path_abs)
        .args([
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
        ])
        .arg(tmp)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .context("spawn ffmpeg for quick proxy remux")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!(
            "ffmpeg exited with {} for quick proxy remux: {}",
            output.status,
            stderr.trim()
        );
    }
    Ok(())
}

async fn run_fast_transcode(media: &MediaItem, tmp: &PathBuf) -> Result<()> {
    let scale_filter = format!("scale=-2:'min(ih,{QUICK_PROXY_HEIGHT_CAP})'");
    let gop = gop_size_for(media).to_string();
    let input = media.path_abs.clone();
    let tmp = tmp.clone();

    let output = hwaccel::output_with_hw_decode_fallback("quick proxy", |hw, cmd| {
        cmd.args(["-y", "-hide_banner", "-nostats", "-loglevel", "error"]);
        if hw {
            hwaccel::push_hwaccel_args(cmd);
        }
        cmd.arg("-i").arg(&input).args([
            "-vf",
            &scale_filter,
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "30",
            "-profile:v",
            "high",
            "-level:v",
            "4.2",
            "-g",
            &gop,
            "-keyint_min",
            &gop,
            "-bf",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
        ]);
        cmd.arg(&tmp)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
    })
    .await
    .context("quick proxy transcode")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!(
            "ffmpeg exited with {} for quick proxy transcode: {}",
            output.status,
            stderr.trim()
        );
    }
    Ok(())
}

fn gop_size_for(media: &MediaItem) -> u32 {
    let fps = media
        .metadata
        .video
        .as_ref()
        .and_then(|v| {
            if v.fps_den == 0 {
                None
            } else {
                Some((v.fps_num as f64 / v.fps_den as f64).round() as i64)
            }
        })
        .filter(|f| *f > 0)
        .unwrap_or(30);
    fps.clamp(1, 240) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{new_id, MediaKind, MediaMetadata, VideoStreamMeta};
    use chrono::Utc;

    fn video(
        codec: &str,
        pix_fmt: &str,
        width: u32,
        height: u32,
        fps_num: u32,
        fps_den: u32,
    ) -> MediaItem {
        MediaItem {
            id: new_id(),
            label: None,
            path_abs: "clip.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(10_000_000),
                video: Some(VideoStreamMeta {
                    width,
                    height,
                    fps_num,
                    fps_den,
                    codec: codec.into(),
                    pix_fmt: pix_fmt.into(),
                }),
                audio: None,
            },
            proxy_path: None,
            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "abc".into(),
            file_size: 1,
            file_mtime: 0,
            imported_at: Utc::now(),
        }
    }

    #[test]
    fn remuxes_friendly_h264_1080p() {
        assert!(can_remux(&video("h264", "yuv420p", 1920, 1080, 30, 1)));
    }

    #[test]
    fn transcodes_hevc_source() {
        assert!(!can_remux(&video("hevc", "yuv420p", 1920, 1080, 30, 1)));
    }

    #[test]
    fn transcodes_h264_above_1080p() {
        assert!(!can_remux(&video("h264", "yuv420p", 3840, 2160, 30, 1)));
    }

    #[test]
    fn transcodes_h264_with_unfriendly_pix_fmt() {
        assert!(!can_remux(&video("h264", "yuv420p10le", 1920, 1080, 30, 1)));
    }

    #[test]
    fn gop_follows_source_fps() {
        assert_eq!(gop_size_for(&video("h264", "yuv420p", 1920, 1080, 60, 1)), 60);
    }

    #[test]
    fn gop_defaults_to_30_when_fps_unknown() {
        let mut m = video("h264", "yuv420p", 1920, 1080, 0, 0);
        assert_eq!(gop_size_for(&m), 30);
        m.metadata.video = None;
        assert_eq!(gop_size_for(&m), 30);
    }
}
