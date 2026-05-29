//! Proxy generation. Transcodes a video to a 1080p-capped H.264/AAC mp4
//! that the PixiJS + WebCodecs renderer decodes for both preview and
//! export. Output sits at `<cache>/proxies/<file_hash>.mp4`.
//!
//! Encoder: libx264 -preset fast -crf 22 + AAC 128k, capped at 1080p
//! height (sources shorter stay native; never upscale). Software
//! encode is intentional — proxies should be portable across machines,
//! and the real HW-encoder selection is reserved for the user's
//! exports.
//!
//! GOP size scales with source fps so the proxy is always ~1
//! source-second per IDR. This bounds the WebCodecs decoder's
//! seek-to-IDR-then-decode-forward tail to ~1 s regardless of the
//! source's frame rate (a constant 30-frame GOP would be 0.5 s on
//! 60 fps source — see ADR 0003).

use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{Context, Result};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use tokio::process::Command;

use crate::cache::{CacheLayout, cached_ok, discard_temp, promote_temp, temp_path};
use crate::jobs::hwaccel;
use crate::state::MediaItem;

/// Maximum proxy height. Sources taller than this scale down; sources
/// shorter stay at native resolution (no upscaling).
const PROXY_HEIGHT_CAP: u32 = 1080;

/// Bump whenever the proxy ffmpeg args change in a way that affects
/// playback / scrub behavior. `io::load_from_dir` compares each
/// `MediaItem.proxy_format_version` against this constant on open
/// and invalidates older proxies so the existing background job
/// re-encodes them. See `docs/pixi-renderer-plan.md` (P1).
///
/// Versions:
///   0 — pre-versioning / legacy. ~8 s GOP from libx264 defaults.
///   1 — `-g 30 -keyint_min 30` for ~1 s keyframe spacing; 540p cap.
///   2 — 1080p cap (replaces 540p) for the PixiJS + WebCodecs renderer
///       which uses the proxy as the master decode source for preview
///       AND export. High profile / Level 4.2 / yuv420p so WebCodecs'
///       `avc1.640028` config decodes universally.
///   3 — GOP scales with source fps (`-g <round(fps)>`) so 60 fps
///       source proxies stay at 1 s GOP, not 0.5 s. See ADR 0003.
///   4 — `-bf 0` disables B-frames in the proxy. Preset-fast's default
///       3 B-frames carries a 2-frame CTS reorder offset through to
///       the proxy: the proxy's last frame's PTS lands ~67 ms past
///       the source's mvhd duration (which is what ffprobe reports
///       as `format.duration` and what `MediaItem.duration_us` /
///       layer `t_end_us` are sized to). The renderer's auto-pause
///       snap then targets the source-time corresponding to
///       `t_end_us − 1 µs`, which falls in the THIRD-to-last frame's
///       interval because the trailing two frames sit past the
///       clip's playable range. Disabling B-frames in the proxy
///       eliminates the reorder offset entirely — every frame's
///       PTS equals its DTS, the proxy's last frame lands inside
///       `t_end_us`, and the snap correctly paints it. Proxies are
///       local-only preview artifacts so the ~10–20 % size hit is
///       acceptable.
pub const PROXY_FORMAT_VERSION: u32 = 4;

pub async fn run(cache: &CacheLayout, media: &MediaItem) -> Result<PathBuf> {
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg not installed; cannot generate proxy");
    }

    let dest = cache.proxy(&media.file_hash_blake3);
    if cached_ok(&dest) {
        return Ok(dest);
    }
    let tmp = temp_path(&dest);
    // Wipe any prior interrupted attempt.
    let _ = tokio::fs::remove_file(&tmp).await;

    // -vf scale=-2:'min(ih,N)' caps height at PROXY_HEIGHT_CAP without
    // upscaling sources that are already smaller; width auto-rounded to
    // even (libx264 requires even dims). High profile + Level 4.2 +
    // yuv420p gives WebCodecs a universally-decodable `avc1.640028`
    // stream. GOP = round(source_fps) keeps every proxy at ~1 source-
    // second per IDR, bounding the `VideoDecoder` seek-to-IDR-then-
    // decode-forward tail to ~1 s regardless of source frame rate.
    // -movflags +faststart puts the moov atom up front so mp4box.js
    // demuxes the file before it's fully written.
    let scale_filter = format!("scale=-2:'min(ih,{PROXY_HEIGHT_CAP})'");
    let gop = gop_size_for(media).to_string();
    let input = media.path_abs.clone();
    let tmp = tmp.clone();

    let output = hwaccel::output_with_hw_decode_fallback("full proxy", |hw, cmd| {
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
            "fast",
            "-crf",
            "22",
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
            "128k",
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
    .context("full proxy transcode")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        discard_temp(&dest);
        anyhow::bail!(
            "ffmpeg exited with {} for proxy generation: {}",
            output.status,
            stderr.trim()
        );
    }

    if !cached_ok(&tmp) {
        discard_temp(&dest);
        anyhow::bail!(
            "ffmpeg returned success but proxy output is missing or zero bytes at {}",
            tmp.display()
        );
    }

    promote_temp(&dest)?;
    Ok(dest)
}

/// GOP size in frames for `media`'s proxy: `round(source_fps)` so the
/// proxy carries one IDR per source-second, clamped to a safe range
/// to avoid pathological encoder behavior on missing or absurd
/// metadata. Falls back to 30 when video metadata is absent (should
/// not happen — proxy generation is gated on `MediaKind::Video` —
/// but keeps the call infallible).
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
    use chrono::Utc;
    use std::process::Command as StdCommand;
    use tempfile::TempDir;

    use crate::state::{MediaKind, MediaMetadata, new_id};

    fn ffmpeg_available() -> bool {
        StdCommand::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    async fn make_test_video(dest: &std::path::Path) -> Result<()> {
        // Video-only fixture (no audio) — keeps the test focused on video
        // proxy generation; the proxy job's audio handling is a feature
        // not the contract under test here.
        //
        // 6 seconds at 30 fps so the keyframe-density assertion below
        // can distinguish "-g 30 applied" (~6 keyframes) from
        // "default libx264 -g 250" (1 keyframe for the full clip).
        let status = Command::new("ffmpeg")
            .args([
                "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi",
                "-i", "testsrc=duration=6:size=640x360:rate=30",
                "-pix_fmt", "yuv420p",
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-t", "6",
            ])
            .arg(dest)
            .status()
            .await?;
        if !status.success() {
            anyhow::bail!("test fixture ffmpeg failed: {status}");
        }
        Ok(())
    }

    #[tokio::test]
    async fn proxy_roundtrip_against_real_ffmpeg() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping proxy smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        let video = tmp.path().join("source.mp4");
        make_test_video(&video).await.expect("test fixture");

        let media = MediaItem {
            id: new_id(),
            label: Some("source.mp4".into()),
            path_abs: video,
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(6_000_000),
                video: None,
                audio: None,
            },
            proxy_path: None,

            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "deadbeef".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let proxy_path = run(&cache, &media).await.expect("proxy run");
        assert!(cached_ok(&proxy_path), "proxy file missing or empty");
        // Sanity check it's actually a real mp4 — re-probe with ffprobe.
        let out = Command::new("ffprobe")
            .args([
                "-v", "quiet", "-print_format", "json", "-show_format",
            ])
            .arg(&proxy_path)
            .output()
            .await
            .expect("ffprobe");
        assert!(out.status.success(), "ffprobe rejected the proxy output");

        // `docs/preview-scrub.md` S.1/S.7 — verify the GOP density.
        // libx264 default `-g 250` would yield 1 keyframe for a 6 s
        // / 30 fps (180-frame) source — the entire clip in one GOP.
        // With `-g 30 -keyint_min 30` we expect ~6 keyframes (one
        // per second). Lower bound at 4 to absorb edge-case encoder
        // choices (e.g. ffmpeg dropping the final near-end keyframe).
        let kf = Command::new("ffprobe")
            .args([
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "frame=pict_type",
                "-of", "csv=p=0",
            ])
            .arg(&proxy_path)
            .output()
            .await
            .expect("ffprobe keyframe count");
        assert!(kf.status.success(), "ffprobe keyframe scan failed");
        let stdout = String::from_utf8_lossy(&kf.stdout);
        let i_frames = stdout.lines().filter(|l| l.trim() == "I").count();
        assert!(
            i_frames >= 4,
            "proxy should have >= 4 keyframes for 6s @ 30fps with -g 30 (got {i_frames}); \
             default GOP would produce 1. Means scrub-friendly keyframe density isn't being applied.\n{stdout}"
        );
        // PROXY_FORMAT_VERSION 4: `-bf 0` must produce a B-frame-free
        // stream. Without it, libx264's preset-fast default of 3 B-
        // frames pushes the proxy's last frame's PTS past mvhd duration,
        // and the renderer's auto-pause snap lands on the third-to-last
        // frame.
        let b_frames = stdout.lines().filter(|l| l.trim() == "B").count();
        assert_eq!(
            b_frames, 0,
            "proxy should have 0 B-frames with -bf 0 (got {b_frames}). \
             Preserving B-frames carries the CTS reorder offset into the proxy."
        );
    }

    #[tokio::test]
    async fn skip_when_proxy_cached() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        let hash = "preexist";
        let dest = cache.proxy(hash);
        tokio::fs::create_dir_all(dest.parent().unwrap()).await.unwrap();
        tokio::fs::write(&dest, b"already here").await.unwrap();

        let media = MediaItem {
            id: new_id(),
            label: None,
            path_abs: tmp.path().join("nope.mp4"),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(1_000_000),
                video: None,
                audio: None,
            },
            proxy_path: None,

            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: hash.into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let returned = run(&cache, &media).await.expect("cache hit");
        assert_eq!(returned, dest);
        // File untouched.
        assert_eq!(tokio::fs::read(&dest).await.unwrap(), b"already here");
    }

    fn media_with_fps(num: u32, den: u32) -> MediaItem {
        use crate::state::VideoStreamMeta;
        MediaItem {
            id: new_id(),
            label: None,
            path_abs: "x.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(1),
                video: Some(VideoStreamMeta {
                    width: 640,
                    height: 360,
                    fps_num: num,
                    fps_den: den,
                    codec: "h264".into(),
                    pix_fmt: "yuv420p".into(),
                }),
                audio: None,
            },
            proxy_path: None,
            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "x".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        }
    }

    #[test]
    fn gop_size_scales_with_fps() {
        assert_eq!(gop_size_for(&media_with_fps(30, 1)), 30);
        assert_eq!(gop_size_for(&media_with_fps(60, 1)), 60);
        // 59.94 fps (NTSC 60) — rounds to 60.
        assert_eq!(gop_size_for(&media_with_fps(60_000, 1_001)), 60);
        // 23.976 fps — rounds to 24.
        assert_eq!(gop_size_for(&media_with_fps(24_000, 1_001)), 24);
        // 120 fps high-speed source.
        assert_eq!(gop_size_for(&media_with_fps(120, 1)), 120);
    }

    #[test]
    fn gop_size_falls_back_when_metadata_missing() {
        let mut media = media_with_fps(30, 1);
        media.metadata.video = None;
        assert_eq!(gop_size_for(&media), 30);
    }

    #[test]
    fn gop_size_falls_back_on_zero_denominator() {
        // fps_den == 0 would divide-by-zero; fall back to default.
        assert_eq!(gop_size_for(&media_with_fps(60, 0)), 30);
    }

    #[test]
    fn gop_size_clamps_pathological_fps() {
        // Some files report ridiculous fps; clamp to a safe upper bound.
        assert_eq!(gop_size_for(&media_with_fps(10_000, 1)), 240);
    }
}
