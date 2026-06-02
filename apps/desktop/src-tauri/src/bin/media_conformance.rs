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

use image::ImageReader;
use std::io::Cursor;

fn decode_rgb8(png: &[u8]) -> Result<image::RgbImage> {
    Ok(ImageReader::new(Cursor::new(png))
        .with_guessed_format()
        .context("guess png")?
        .decode()
        .context("decode png")?
        .to_rgb8())
}

/// MSSIM in [0,1]; 1.0 == identical. Errors if dimensions disagree (a fixture
/// mismatch, not a regression).
fn ssim_pngs(a_png: &[u8], b_png: &[u8]) -> Result<f64> {
    let a = decode_rgb8(a_png)?;
    let b = decode_rgb8(b_png)?;
    if a.dimensions() != b.dimensions() {
        anyhow::bail!(
            "dims disagree: {}x{} vs {}x{}",
            a.width(), a.height(), b.width(), b.height()
        );
    }
    let r = image_compare::rgb_similarity_structure(
        &image_compare::Algorithm::MSSIMSimple, &a, &b,
    )
    .context("ssim")?;
    Ok(r.score)
}

/// Peak SNR in dB over RGB. Higher is better; identical frames clamp to 100.0.
fn psnr_pngs(a_png: &[u8], b_png: &[u8]) -> Result<f64> {
    let a = decode_rgb8(a_png)?;
    let b = decode_rgb8(b_png)?;
    if a.dimensions() != b.dimensions() {
        anyhow::bail!("dims disagree for psnr");
    }
    let mut sse: f64 = 0.0;
    for (pa, pb) in a.pixels().zip(b.pixels()) {
        for c in 0..3 {
            let d = pa.0[c] as f64 - pb.0[c] as f64;
            sse += d * d;
        }
    }
    let n = (a.width() as f64) * (a.height() as f64) * 3.0;
    let mse = sse / n;
    if mse <= f64::EPSILON {
        return Ok(100.0);
    }
    Ok(10.0 * (255.0_f64 * 255.0 / mse).log10())
}

/// Over source indices `[center-window, center+window]`, return the index whose
/// frame best-matches `out_png` (highest SSIM) and that score. This is the
/// alignment primitive: a correctly-aligned output frame best-matches its OWN
/// source index, because the burned-in counter makes neighbors distinct.
fn best_match_index(
    out_png: &[u8],
    source: &Path,
    center: u64,
    window: u64,
) -> Result<(u64, f64)> {
    let lo = center.saturating_sub(window);
    let hi = center + window;
    let mut best = (center, f64::MIN);
    for m in lo..=hi {
        let src = extract_frame_png(source, m)?;
        let s = ssim_pngs(out_png, &src)?;
        if s > best.1 {
            best = (m, s);
        }
    }
    Ok(best)
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

    #[test]
    fn ssim_identity_is_one() {
        let clip = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/media/tiny.mp4");
        let png = extract_frame_png(std::path::Path::new(clip), 10).unwrap();
        let s = ssim_pngs(&png, &png).unwrap();
        assert!(s > 0.999, "identical frames should score ~1.0, got {s}");
    }

    #[test]
    fn best_match_of_self_is_same_index() {
        // Using the same clip as both "output" and "source", frame 10's best
        // match within a +/-2 window must be index 10 (identity alignment).
        let clip = std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fixtures/media/tiny.mp4"
        ));
        let out10 = extract_frame_png(clip, 10).unwrap();
        let (best, score) = best_match_index(&out10, clip, 10, 2).unwrap();
        assert_eq!(best, 10, "self best-match must be the same index");
        assert!(score > 0.999);
    }
}
