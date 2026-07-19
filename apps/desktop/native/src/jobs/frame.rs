//! On-demand frame extraction for `media://{id}/frame/{t_us}` MCP reads.
//!
//! Different shape from the import-time pipeline: there's no fixed set of
//! derivatives to generate up front. Agents fan out across the timeline
//! ("show me t=2.5s, then t=5.0s, then..."), so we lazy-cache each
//! requested frame at `<cache>/frames/<hash>/<t_us>.jpg`. Repeat hits skip
//! ffmpeg entirely.

use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{Context, Result};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use tokio::process::Command;

use crate::process::NoConsoleWindow;

use crate::cache::{cached_ok, discard_temp, promote_temp, temp_path, CacheLayout};
use crate::state::{MediaItem, MediaKind, TimeUs};

const FRAME_WIDTH: u32 = 640;

/// Extract a single frame at `t_us` and return the cached JPG path. Hits the
/// disk cache when the same `(hash, t_us)` was requested before.
pub async fn extract(cache: &CacheLayout, media: &MediaItem, t_us: TimeUs) -> Result<PathBuf> {
    if !matches!(media.kind, MediaKind::Video | MediaKind::Image) {
        anyhow::bail!("frame extract only valid for Video / Image media");
    }
    if t_us < 0 {
        anyhow::bail!("t_us must be >= 0");
    }
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg not installed; cannot extract frame");
    }

    let dest = cache.frame(&media.file_hash_blake3, t_us);
    if cached_ok(&dest) {
        return Ok(dest);
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("create frame cache dir {}", parent.display()))?;
    }

    let tmp = temp_path(&dest);
    let _ = tokio::fs::remove_file(&tmp).await;

    let t_seconds = (t_us as f64) / 1_000_000.0;

    // -ss BEFORE -i is the fast seek (decode-from-keyframe-then-walk-to-time).
    // Accuracy is keyframe-bounded but for a thumbnail-grade extract that's
    // fine and ~10x faster than putting -ss after -i.
    // -frames:v 1 grabs exactly one frame. -update 1 + -f image2 forces ffmpeg
    // to overwrite a single output (otherwise it complains about the lack
    // of a `%d` pattern).
    let output = Command::new(ffmpeg_path())
        .no_console_window()
        .args([
            "-y",
            "-hide_banner",
            "-nostats",
            "-loglevel",
            "error",
            "-ss",
            &format!("{t_seconds}"),
            "-i",
        ])
        .arg(&media.path_abs)
        .args([
            "-frames:v",
            "1",
            "-vf",
            &format!("scale={FRAME_WIDTH}:-2"),
            "-q:v",
            "3",
            "-update",
            "1",
            "-f",
            "image2",
        ])
        .arg(&tmp)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .context("spawn ffmpeg for frame extract")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        discard_temp(&dest);
        anyhow::bail!(
            "ffmpeg exited with {} for frame extract: {}",
            output.status,
            stderr.trim()
        );
    }
    if !cached_ok(&tmp) {
        discard_temp(&dest);
        anyhow::bail!(
            "ffmpeg returned success but frame is missing or zero bytes at {}",
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

    use crate::state::{new_id, DecodeRoute, MediaKind, MediaMetadata};

    fn ffmpeg_available() -> bool {
        StdCommand::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    async fn make_test_video(dest: &std::path::Path) -> Result<()> {
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=2:size=640x360:rate=30",
                "-pix_fmt",
                "yuv420p",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-t",
                "2",
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
    async fn extract_then_cache_hit() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping frame smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        let video = tmp.path().join("source.mp4");
        make_test_video(&video).await.expect("test fixture");

        let media = MediaItem {
            id: new_id(),
            label: None,
            path_abs: video,
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(2_000_000),
                video: None,
                audio: None,
                ..Default::default()
            },
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "frame-test".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let p1 = extract(&cache, &media, 1_000_000)
            .await
            .expect("first extract");
        assert!(cached_ok(&p1));
        let len_before = tokio::fs::metadata(&p1).await.unwrap().len();

        // Second call should hit the disk cache (path returned without
        // re-running ffmpeg). We can't directly observe "didn't run ffmpeg"
        // but we can observe the file is unchanged.
        let p2 = extract(&cache, &media, 1_000_000)
            .await
            .expect("cached extract");
        assert_eq!(p1, p2);
        let len_after = tokio::fs::metadata(&p2).await.unwrap().len();
        assert_eq!(len_before, len_after);
    }

    #[tokio::test]
    async fn rejects_negative_t() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();
        let media = MediaItem {
            id: new_id(),
            label: None,
            path_abs: tmp.path().join("nope.mp4"),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata::default(),
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "x".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };
        let err = extract(&cache, &media, -1).await.expect_err("negative t");
        assert!(format!("{err:#}").contains("t_us must be"));
    }

    #[tokio::test]
    async fn rejects_audio_kind() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();
        let media = MediaItem {
            id: new_id(),
            label: None,
            path_abs: tmp.path().join("nope.wav"),
            path_rel: None,
            kind: MediaKind::Audio,
            metadata: MediaMetadata::default(),
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "x".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };
        let err = extract(&cache, &media, 0).await.expect_err("audio kind");
        assert!(format!("{err:#}").contains("Video / Image"));
    }
}
