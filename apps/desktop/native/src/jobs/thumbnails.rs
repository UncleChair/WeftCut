//! Thumbnail extraction. Pulls 10 evenly-spaced frames from a video at
//! 320 px wide (height auto-scaled to keep aspect). One ffmpeg invocation
//! per media item — `-vf fps=N/D,scale=320:-2`. The fps filter rounds, so
//! we cap at exactly N frames with `-frames:v N`.
//!
//! Cache layout: `<cache>/thumbnails/<file_hash>/000.jpg .. 009.jpg`.
//! Skip-if-cached: directory exists AND has 10 non-zero-byte JPGs.

use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{Context, Result, anyhow};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use tokio::process::Command;

use crate::cache::{CacheLayout, cached_ok};
use crate::state::MediaItem;

const THUMB_COUNT: usize = 10;
const THUMB_WIDTH: u32 = 320;
/// Below this, the fps filter pushes too high and ffmpeg refuses (or emits
/// fewer than N frames). Skip thumbnail generation for these.
const MIN_DURATION_US: i64 = 100_000;

pub async fn run(cache: &CacheLayout, media: &MediaItem) -> Result<PathBuf> {
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg not installed; cannot generate thumbnails");
    }
    let duration_us = media
        .metadata
        .duration_us
        .ok_or_else(|| anyhow!("media has no duration; cannot space thumbnails"))?;
    if duration_us < MIN_DURATION_US {
        anyhow::bail!(
            "media duration {duration_us}us is below thumbnail minimum {MIN_DURATION_US}us"
        );
    }

    let hash = &media.file_hash_blake3;
    let dest_dir = cache.thumbnails(hash);

    if all_thumbnails_present(cache, hash) {
        return Ok(dest_dir);
    }

    // Fresh + temp dir alongside, atomic-ish: write into `<dest>.tmp/` then
    // rename. We don't use `cache::temp_path` directly because that's for
    // single files; for a directory of N JPGs we manage the .tmp dir
    // ourselves.
    let tmp_dir = {
        let mut s = dest_dir.as_os_str().to_owned();
        s.push(".tmp");
        PathBuf::from(s)
    };

    // Cleanup any prior interrupted attempt.
    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .with_context(|| format!("create thumbnails tmp dir {}", tmp_dir.display()))?;

    let duration_s = duration_us as f64 / 1_000_000.0;
    let fps = THUMB_COUNT as f64 / duration_s;

    let pattern = tmp_dir.join("%03d.jpg");

    // -an drops audio (we only want frames). -q:v 5 = mid-quality JPG, ~30 KB
    // per thumbnail at 320px. -vsync vfr / -fps_mode passthrough so the fps
    // filter's output isn't second-guessed.
    let status = Command::new(ffmpeg_path())
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
            "-an",
            "-vf",
            &format!("fps={fps:.6},scale={THUMB_WIDTH}:-2"),
            "-frames:v",
            &THUMB_COUNT.to_string(),
            "-q:v",
            "5",
            "-fps_mode",
            "passthrough",
        ])
        .arg(&pattern)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .context("spawn ffmpeg for thumbnails")?;

    if !status.success() {
        let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
        anyhow::bail!("ffmpeg exited with {status} for thumbnail extraction");
    }

    // Verify ffmpeg actually produced N non-empty thumbnails before promoting.
    for i in 0..THUMB_COUNT {
        let p = tmp_dir.join(format!("{:03}.jpg", i + 1));
        if !cached_ok(&p) {
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            anyhow::bail!(
                "ffmpeg produced incomplete thumbnail set at {}",
                tmp_dir.display()
            );
        }
    }

    // ffmpeg's %03d pattern is 1-indexed; rename to 0-indexed for stable
    // public layout.
    for i in 0..THUMB_COUNT {
        let from = tmp_dir.join(format!("{:03}.jpg", i + 1));
        let to = tmp_dir.join(format!("{:03}.jpg", i));
        if from != to {
            tokio::fs::rename(&from, &to)
                .await
                .with_context(|| format!("rename {} -> {}", from.display(), to.display()))?;
        }
    }

    // Promote: dest_dir might exist as a stale partial — wipe + rename.
    let _ = tokio::fs::remove_dir_all(&dest_dir).await;
    tokio::fs::rename(&tmp_dir, &dest_dir)
        .await
        .with_context(|| {
            format!("promote {} -> {}", tmp_dir.display(), dest_dir.display())
        })?;

    Ok(dest_dir)
}

fn all_thumbnails_present(cache: &CacheLayout, hash: &str) -> bool {
    (0..THUMB_COUNT).all(|i| cached_ok(&cache.thumbnail(hash, i)))
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

    /// Generate a tiny 1-second mp4 via lavfi `testsrc` so the smoke test
    /// has real bytes to operate on without committing a video fixture.
    async fn make_test_video(dest: &std::path::Path) -> Result<()> {
        let status = Command::new("ffmpeg")
            .args([
                "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi",
                "-i", "testsrc=duration=1:size=320x180:rate=10",
                "-pix_fmt", "yuv420p",
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-t", "1",
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
    async fn thumbnails_roundtrip_against_real_ffmpeg() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping thumbnails smoke");
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
                duration_us: Some(1_000_000),
                video: None,
                audio: None,
                ..Default::default()
            },
            proxy_path: None,

            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "deadbeef".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let dir = run(&cache, &media).await.expect("thumbnails run");
        for i in 0..THUMB_COUNT {
            let p = dir.join(format!("{:03}.jpg", i));
            assert!(cached_ok(&p), "missing thumbnail {p:?}");
        }
    }

    #[tokio::test]
    async fn skip_when_already_cached() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping thumbnails skip-cache smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        // Pre-populate the cache with the 10 non-zero JPGs the run expects.
        let hash = "preexist";
        let dir = cache.thumbnails(hash);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        for i in 0..THUMB_COUNT {
            tokio::fs::write(dir.join(format!("{:03}.jpg", i)), b"fake")
                .await
                .unwrap();
        }

        let media = MediaItem {
            id: new_id(),
            label: None,
            path_abs: tmp.path().join("nope.mp4"), // never read because cache hits
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(1_000_000),
                video: None,
                audio: None,
                ..Default::default()
            },
            proxy_path: None,

            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: hash.into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let returned = run(&cache, &media).await.expect("cache hit");
        assert_eq!(returned, dir);
    }

    #[tokio::test]
    async fn rejects_below_minimum_duration() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        let media = MediaItem {
            id: new_id(),
            label: None,
            path_abs: tmp.path().join("tiny.mp4"),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(50_000), // 50ms — below MIN_DURATION_US
                video: None,
                audio: None,
                ..Default::default()
            },
            proxy_path: None,

            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "tiny".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let err = run(&cache, &media).await.expect_err("too-short clip");
        assert!(
            format!("{err:#}").contains("below thumbnail minimum"),
            "wrong error: {err:#}"
        );
    }
}
