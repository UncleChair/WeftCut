//! Proxy generation. Transcodes a video to a 1080p-capped H.264/AAC mp4
//! that the PixiJS + WebCodecs renderer decodes for both preview and
//! export. Output sits at `<cache>/proxies/<file_hash>.mp4`.
//!
//! Encoder: libx264 -preset fast -crf 22 + AAC 128k, capped at 1080p
//! height (sources shorter stay native; never upscale). Software
//! encode is intentional — proxies should be portable across machines,
//! and the real HW-encoder selection is reserved for the user's
//! exports.

use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{Context, Result};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use tokio::process::Command;

use crate::cache::{CacheLayout, cached_ok, discard_temp, promote_temp, temp_path};
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
pub const PROXY_FORMAT_VERSION: u32 = 2;

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
    // stream. Dense 1 s GOP (`-g 30 -keyint_min 30`) bounds the
    // `VideoDecoder` seek-to-IDR-then-decode-forward tail to ~30 frames.
    // -movflags +faststart puts the moov atom up front so mp4box.js
    // demuxes the file before it's fully written.
    let scale_filter = format!("scale=-2:'min(ih,{PROXY_HEIGHT_CAP})'");
    let output = Command::new(ffmpeg_path())
        .args([
            "-y",
            "-hide_banner",
            "-nostats",
            "-loglevel",
            "error",
            "-i",
        ])
        .arg(&media.path_abs)
        .args([
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
            "30",
            "-keyint_min",
            "30",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            // Output is `<dest>.mp4.tmp` — ffmpeg can't infer format from the
            // double extension, so force mp4 muxer explicitly.
            "-f",
            "mp4",
        ])
        .arg(&tmp)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .context("spawn ffmpeg for proxy")?;

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
}
