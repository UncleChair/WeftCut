//! On-demand filmstrip tile extraction for the timeline clip preview.
//!
//! Unlike the import-time thumbnail job (10 posters per media), tiles are
//! extracted lazily per (lod, index) time-grid key as the timeline scrolls
//! and zooms, and cached at `<cache>/filmstrip/<hash>/<tag>/<lod>/<index:06>.jpg`.
//! Repeat hits skip ffmpeg entirely. Deliberately NOT behind `ffmpeg_sem()`:
//! interactive tile extracts must not queue behind proxy transcodes (same
//! stance as `jobs/frame.rs`); the renderer caps its own in-flight fetches.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result};
use ffmpeg_sidecar::{command::ffmpeg_is_installed, paths::ffmpeg_path};
use tokio::process::Command;

use crate::process::NoConsoleWindow;

use crate::cache::{cached_ok, discard_temp, promote_temp, temp_path, CacheLayout};

/// Time-grid base spacing. Twin: renderer FilmstripTileProducer.ts
/// `FILMSTRIP_BASE_SPACING_US` / `spacingUs` — both sides pin the same
/// endpoints in tests.
pub const FILMSTRIP_BASE_SPACING_US: i64 = 250_000;
pub const FILMSTRIP_MAX_LOD: u32 = 12;
/// Canonical decode height: lane height / zoom never changes a cache key.
pub const FILMSTRIP_TILE_HEIGHT: u32 = 256;
/// `-ss` at/past the final frame emits zero frames; clamp tail requests this
/// far inside the source instead of erroring.
const TAIL_SLACK_US: i64 = 100_000;

pub fn spacing_us(lod: u32) -> i64 {
    FILMSTRIP_BASE_SPACING_US << lod
}

pub fn validate_lod(lod: u32) -> Result<()> {
    anyhow::ensure!(
        lod <= FILMSTRIP_MAX_LOD,
        "lod {lod} out of range 0..={FILMSTRIP_MAX_LOD}"
    );
    Ok(())
}

/// Extract the tile at grid key `(lod, index)` from `src` and return the
/// cached JPG path. `src` is the already-resolved decode source (original or
/// proxy — the command layer applies the proxy-wait rule before calling).
pub async fn extract_tile(
    cache: &CacheLayout,
    src: &Path,
    src_tag: crate::cache::FilmstripSrc,
    hash: &str,
    duration_us: Option<i64>,
    lod: u32,
    index: u32,
) -> Result<PathBuf> {
    validate_lod(lod)?;

    // Cache hit first: an already-extracted tile must stay reachable even
    // when the ffmpeg sidecar is broken — only the miss path needs ffmpeg.
    let dest = cache.filmstrip_tile(hash, src_tag, lod, index);
    if cached_ok(&dest) {
        crate::cache::touch_if_stale(&dest);
        return Ok(dest);
    }
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg not installed; cannot extract filmstrip tile");
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("create filmstrip cache dir {}", parent.display()))?;
    }

    let mut t_us = spacing_us(lod).saturating_mul(index as i64);
    if let Some(d) = duration_us {
        t_us = t_us.min((d - TAIL_SLACK_US).max(0));
    }
    let t_seconds = (t_us as f64) / 1_000_000.0;

    let tmp = temp_path(&dest);
    let _ = tokio::fs::remove_file(&tmp).await;

    // -ss BEFORE -i = fast keyframe seek (keyframe-bounded accuracy is fine
    // for thumbnail-grade tiles). scale=-2:256 keeps aspect at the canonical
    // height. -update 1 -f image2 forces a single-image output without a %d
    // pattern (same incantation as jobs/frame.rs).
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
        .arg(src)
        .args([
            "-frames:v",
            "1",
            "-vf",
            &format!("scale=-2:{FILMSTRIP_TILE_HEIGHT}"),
            "-q:v",
            "5",
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
        .context("spawn ffmpeg for filmstrip tile")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        discard_temp(&dest);
        anyhow::bail!(
            "ffmpeg exited with {} for filmstrip tile: {}",
            output.status,
            stderr.trim()
        );
    }
    if !cached_ok(&tmp) {
        discard_temp(&dest);
        anyhow::bail!(
            "ffmpeg returned success but tile is missing or zero bytes at {}",
            tmp.display()
        );
    }
    promote_temp(&dest)?;
    cache.notify_write();
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;
    use tempfile::TempDir;

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

    #[test]
    fn spacing_grid_is_pinned() {
        // Twin: renderer/timeline/tileEngine/FilmstripTileProducer.ts `spacingUs`.
        // Both sides pin the same endpoints so drift fails a test, not a user.
        assert_eq!(spacing_us(0), 250_000);
        assert_eq!(spacing_us(1), 500_000);
        assert_eq!(spacing_us(12), 1_024_000_000);
    }

    #[tokio::test]
    async fn extract_then_cache_hit() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping filmstrip smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        let video = tmp.path().join("source.mp4");
        make_test_video(&video).await.expect("test fixture");

        // lod=2 -> spacing_us(2) = 1_000_000; index=1 -> t = 1_000_000 us.
        let p1 = extract_tile(
            &cache,
            &video,
            crate::cache::FilmstripSrc::Orig,
            "filmstrip-test",
            Some(2_000_000),
            2,
            1,
        )
        .await
        .expect("first extract");
        assert!(cached_ok(&p1));
        let len_before = tokio::fs::metadata(&p1).await.unwrap().len();

        // Second call should hit the disk cache (path returned without
        // re-running ffmpeg). We can't directly observe "didn't run ffmpeg"
        // but we can observe the file is unchanged.
        let p2 = extract_tile(
            &cache,
            &video,
            crate::cache::FilmstripSrc::Orig,
            "filmstrip-test",
            Some(2_000_000),
            2,
            1,
        )
        .await
        .expect("cached extract");
        assert_eq!(p1, p2);
        let len_after = tokio::fs::metadata(&p2).await.unwrap().len();
        assert_eq!(len_before, len_after);
    }

    #[tokio::test]
    async fn tail_index_clamps_into_source() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping filmstrip smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        let video = tmp.path().join("source.mp4");
        make_test_video(&video).await.expect("test fixture");

        // spacing_us(3) = 2_000_000; index=1 -> raw t = 2_000_000 us, which is
        // >= the 2s fixture's duration. With duration_us = Some(2_000_000) the
        // request must clamp into the source instead of erroring.
        let p = extract_tile(
            &cache,
            &video,
            crate::cache::FilmstripSrc::Orig,
            "filmstrip-tail-test",
            Some(2_000_000),
            3,
            1,
        )
        .await
        .expect("clamped extract");
        assert!(cached_ok(&p));
    }

    #[test]
    fn rejects_lod_out_of_range() {
        assert!(validate_lod(13).is_err());
        assert!(validate_lod(12).is_ok());
    }

    #[tokio::test]
    async fn cache_hit_refreshes_stale_mtime() {
        use std::time::{Duration, SystemTime};
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();
        let dest = cache.filmstrip_tile("h", crate::cache::FilmstripSrc::Orig, 2, 1);
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(&dest, b"jpg").unwrap();
        let f = std::fs::File::options().write(true).open(&dest).unwrap();
        f.set_times(
            std::fs::FileTimes::new()
                .set_modified(SystemTime::now() - Duration::from_secs(2 * 3600)),
        )
        .unwrap();
        drop(f);

        // Hit path returns before any ffmpeg concern: src may not exist.
        let p = extract_tile(
            &cache,
            Path::new("missing.mp4"),
            crate::cache::FilmstripSrc::Orig,
            "h",
            None,
            2,
            1,
        )
        .await
        .expect("cache hit");
        assert_eq!(p, dest);
        let m = std::fs::metadata(&dest).unwrap().modified().unwrap();
        assert!(
            m > SystemTime::now() - Duration::from_secs(60),
            "hit must touch the LRU clock"
        );
    }
}
