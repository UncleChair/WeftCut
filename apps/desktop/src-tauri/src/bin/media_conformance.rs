//! `media_conformance` — verifies an exported MP4 against its source: frame
//! alignment (windowed best-match SSIM over the burned-in counter) + app-only
//! conversion loss (SSIM/PSNR of output vs decoded source, same index).
//!
//!   media_conformance --output <mp4> --source <mp4> --samples N1,N2,... \
//!     [--window 2] [--ssim-min 0.95]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result};
use ffmpeg_sidecar::paths::ffmpeg_path;

/// Decode `mp4` and return frame at 0-based decode index `n` as PNG bytes.
/// `select=eq(n,N)` + `-frames:v 1` decodes from the start (fine for the
/// short conformance clips) and is frame-accurate, unlike a `-ss` time seek.
fn extract_frame_png(mp4: &Path, n: u64) -> Result<Vec<u8>> {
    if !mp4.exists() {
        anyhow::bail!("mp4 not found: {}", mp4.display());
    }
    let tmp = tempfile_path("png");
    let status = Command::new(ffmpeg_path())
        .args(["-y", "-hide_banner", "-nostats", "-loglevel", "error", "-i"])
        .arg(mp4)
        .args([
            "-vf",
            &format!("select=eq(n\\,{n})"),
            "-frames:v",
            "1",
            "-vsync",
            "0",
            "-f",
            "image2",
            "-c:v",
            "png",
        ])
        .arg(&tmp)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .context("spawn ffmpeg")?;
    if !status.status.success() {
        anyhow::bail!(
            "ffmpeg failed for frame {n} of {}: {}",
            mp4.display(),
            String::from_utf8_lossy(&status.stderr).trim()
        );
    }
    let bytes = std::fs::read(&tmp).context("read extracted png")?;
    let _ = std::fs::remove_file(&tmp);
    if bytes.is_empty() {
        anyhow::bail!("ffmpeg wrote 0 bytes for frame {n}");
    }
    Ok(bytes)
}

/// A unique temp path with the given extension under the OS temp dir.
fn tempfile_path(ext: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    use std::sync::atomic::{AtomicU64, Ordering};
    static CTR: AtomicU64 = AtomicU64::new(0);
    let id = CTR.fetch_add(1, Ordering::Relaxed);
    p.push(format!("weftcut-mc-{}-{id}.{ext}", std::process::id()));
    p
}

fn main() {
    // Real arg parsing + report land in Task 3; a stub keeps `cargo build` happy.
    eprintln!("media_conformance: run with --output/--source/--samples (see Task 3)");
    std::process::exit(2);
}

#[cfg(test)]
mod tests {
    use super::*;

    // Uses the committed tiny clip; extracting the same index from the same
    // file twice must yield byte-identical PNGs (deterministic decode).
    #[test]
    fn extract_frame_is_deterministic() {
        let clip = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/media/tiny.mp4");
        let a = extract_frame_png(std::path::Path::new(clip), 5).expect("extract a");
        let b = extract_frame_png(std::path::Path::new(clip), 5).expect("extract b");
        assert!(!a.is_empty());
        assert_eq!(a, b, "same index from same file must be identical");
    }
}
