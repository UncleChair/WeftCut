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

use crate::process::NoConsoleWindow;

use crate::cache::{cached_ok, claim_temp, discard_temp, promote_temp_retry, CacheLayout};
use crate::jobs::hwaccel;
use crate::state::MediaItem;

const QUICK_PROXY_HEIGHT_CAP: u32 = 720;

/// `source_gop_secs` is the source's largest keyframe interval in seconds, or
/// `None` if unknown. A long-GOP source is NOT remuxed (which would carry the
/// long GOP through and scrub badly) — it's transcoded to a short GOP so this
/// preview proxy is scrub-friendly.
pub async fn run(
    cache: &CacheLayout,
    media: &MediaItem,
    source_gop_secs: Option<f64>,
) -> Result<PathBuf> {
    // Cache hit before the ffmpeg check: adopting an already-landed proxy
    // needs no encoder.
    let dest = cache.quick_proxy(&media.file_hash_blake3);
    if cached_ok(&dest) {
        return Ok(dest);
    }
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg not installed; cannot generate quick proxy");
    }
    // Fails while another writer holds the temp — see proxy::run.
    let tmp = claim_temp(&dest)?;

    let result = if can_remux(media, source_gop_secs) {
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

    promote_temp_retry(&dest).await?;
    Ok(dest)
}

fn can_remux(media: &MediaItem, source_gop_secs: Option<f64>) -> bool {
    let Some(video) = media.metadata.video.as_ref() else {
        return false;
    };
    crate::jobs::proxy_decision::codec_is_h264(&video.codec)
        && crate::jobs::proxy_decision::pix_fmt_is_browser_friendly(&video.pix_fmt)
        && video.height <= 1080
        // A long-GOP source must be transcoded to a short GOP for scrub, not
        // remuxed (remux keeps the source's long GOP).
        && crate::jobs::proxy_decision::gop_is_scrub_friendly(source_gop_secs)
}

async fn run_remux(media: &MediaItem, tmp: &PathBuf) -> Result<()> {
    let output = Command::new(ffmpeg_path())
        .no_console_window()
        // Reap the child if this future is dropped (runtime shutdown) — an
        // orphan would keep writing the shared `<dest>.tmp`; see hwaccel.rs.
        .kill_on_drop(true)
        .args(["-y", "-hide_banner", "-nostats", "-loglevel", "error", "-i"])
        .arg(&media.path_abs)
        .args([
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c",
            "copy",
            // +write_colr: emit the mp4 colr atom from the input's parsed VUI
            // (color flags don't apply under -c copy). mediabunny reads only
            // colr, so a remuxed quick proxy is otherwise color-untagged to it.
            "-movflags",
            "+faststart+write_colr",
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
    // Short GOP so this preview proxy is scrub-friendly (ADR 0008), matching
    // the full proxy. The quick proxy is the scrub source for DirectExport /
    // long-GOP-demoted sources.
    let gop = crate::jobs::proxy::PROXY_GOP_FRAMES.to_string();
    let input = media.path_abs.clone();
    let tmp = tmp.clone();

    let color_args = crate::jobs::proxy::source_color_args(media);
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
            "+faststart+write_colr",
            "-f",
            "mp4",
        ]);
        // Source color tags → VUI AND (with +write_colr) the mp4 colr atom;
        // see `proxy::source_color_args`.
        cmd.args(&color_args);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{new_id, DecodeRoute, MediaKind, MediaMetadata, VideoStreamMeta};
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
                    start_pts_us: None,
                    nb_frames: None,
                    color_matrix: None,
                    color_range: None,
                    color_primaries: None,
                    color_transfer: None,
                }),
                audio: None,
                ..Default::default()
            },
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "abc".into(),
            file_size: 1,
            file_mtime: 0,
            imported_at: Utc::now(),
        }
    }

    #[test]
    fn remuxes_friendly_short_gop_h264_1080p() {
        assert!(can_remux(
            &video("h264", "yuv420p", 1920, 1080, 30, 1),
            Some(0.2)
        ));
    }

    #[test]
    fn transcodes_long_gop_h264() {
        // Friendly H.264 that would otherwise remux — but a long GOP must be
        // transcoded to a short GOP for scrub, never remuxed (remux keeps it).
        assert!(!can_remux(
            &video("h264", "yuv420p", 1920, 1080, 30, 1),
            Some(6.0)
        ));
    }

    #[test]
    fn transcodes_hevc_source() {
        assert!(!can_remux(
            &video("hevc", "yuv420p", 1920, 1080, 30, 1),
            Some(0.2)
        ));
    }

    #[test]
    fn transcodes_h264_above_1080p() {
        assert!(!can_remux(
            &video("h264", "yuv420p", 3840, 2160, 30, 1),
            Some(0.2)
        ));
    }

    #[test]
    fn remuxes_full_range_yuvj420p_h264() {
        // Full-range "J" 4:2:0 remuxes like yuv420p; +write_colr derives the
        // colr atom from the input VUI so the remuxed quick proxy stays
        // color-readable to mediabunny.
        assert!(can_remux(
            &video("h264", "yuvj420p", 1920, 1080, 30, 1),
            Some(0.2)
        ));
    }

    #[test]
    fn transcodes_h264_with_unfriendly_pix_fmt() {
        assert!(!can_remux(
            &video("h264", "yuv420p10le", 1920, 1080, 30, 1),
            Some(0.2)
        ));
    }

    #[test]
    fn unknown_gop_does_not_remux() {
        // Probe-failure: don't remux (would carry an unknown, possibly long
        // GOP through); transcode to a short GOP instead. Mirrors the
        // None-GOP flip in proxy_decision.
        assert!(!can_remux(
            &video("h264", "yuv420p", 1920, 1080, 30, 1),
            None
        ));
    }
}
