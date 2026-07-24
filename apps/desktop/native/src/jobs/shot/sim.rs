//! Pairwise frame similarity: a DCT perceptual hash (`phash`) plus MSSIM, fused
//! into the `similar` verdict `compare_frames` returns. Pure math over decoded
//! RGB frames — no ffmpeg, no cache, no I/O; the `compare_frames` MCP tool owns
//! frame extraction and feeds two `RgbImage`s in.
//!
//! Not owned here: cut detection / per-shot stats (the parent `shot` module) and
//! the VSHOT cache (compare_frames is deliberately cacheless — a pure function).
//! See `.scratch/scene-content-analysis/issues/02-compare-frames.md`.

use image::imageops::{self, FilterType};
use image::RgbImage;
use serde::Serialize;

/// Near-duplicate cutoff on the 64-bit pHash: `similar` requires at most this
/// many differing bits. 0–5 is effectively the same frame; a re-encode / rescale
/// of one frame moves only a handful of low-frequency bits, so ≤10 still reads as
/// the same content while genuinely different scenes sit well above it.
const PHASH_MAX_HAMMING: u32 = 10;

/// Structural floor: `similar` also requires MSSIM at least this high. pHash is
/// the strong discriminator; MSSIM is the secondary guard against a pHash
/// false-positive, so the floor is deliberately loose. A real 1080p source frame
/// vs its lossy 360p proxy of the SAME instant measures ~0.68 (heavy downscale +
/// compression legitimately drop MSSIM), while genuinely different frames of the
/// same clip measure ~0.07 and unrelated clips ~0.04 — so 0.5 sits in a wide gap
/// that keeps proxy-vs-source similar yet rejects different scenes. Far looser
/// than the shot detector's freeze test (0.985, adjacent frames of ONE stream),
/// which never crosses encodes or resolutions.
const SSIM_MIN: f64 = 0.5;

/// pHash working grid: the frame is reduced to `PHASH_DCT_SIZE`² luma samples
/// before the DCT, so the hash is resolution- and aspect-independent.
const PHASH_DCT_SIZE: usize = 32;

/// Edge of the low-frequency DCT block the hash bits are cut from (top-left
/// `PHASH_LOW_FREQ`² coefficients → 64 bits when it is 8).
const PHASH_LOW_FREQ: usize = 8;

/// Fixed square both frames are resized to before MSSIM (MSSIM needs matching
/// dimensions and cross-clip frames rarely share a resolution). Applied to both
/// sides, so for frames of the SAME aspect ratio it is a fair comparison.
/// CAVEAT: two frames of DIFFERENT aspect ratios get different vertical scale
/// factors, so their structures no longer align and the MSSIM is only
/// approximate — fine for the primary use (dedup within one clip, one AR);
/// cross-AR pairs lean on the pHash (aspect-independent) instead.
const SSIM_COMPARE_DIM: u32 = 256;

/// The comparison verdict `compare_frames` returns, serialized as the tool's
/// JSON result `{ phash_hamming, ssim, similar }`.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct FrameComparison {
    /// Hamming distance between the two frames' 64-bit perceptual hashes (0 =
    /// identical hash, 64 = maximally different).
    pub phash_hamming: u32,
    /// MSSIM structural similarity in [0,1] (1.0 = structurally identical).
    pub ssim: f64,
    /// `phash_hamming <= PHASH_MAX_HAMMING && ssim >= SSIM_MIN` — both the
    /// perceptual hash and the structural score must agree it is the same frame.
    pub similar: bool,
}

/// Compare two decoded frames: perceptual-hash Hamming distance + MSSIM, fused
/// into the `similar` verdict. Dimension-agnostic — pHash normalizes to a fixed
/// grid and the MSSIM path squares both frames first.
pub(crate) fn compare_frames(a: &RgbImage, b: &RgbImage) -> FrameComparison {
    let phash_hamming = hamming(phash(a), phash(b));
    let ssim = structural_similarity(a, b);
    FrameComparison {
        phash_hamming,
        ssim,
        similar: phash_hamming <= PHASH_MAX_HAMMING && ssim >= SSIM_MIN,
    }
}

/// DCT-based perceptual hash: reduce to a `PHASH_DCT_SIZE`² luma grid, take the
/// low-frequency corner of its 2D DCT, and set one bit per coefficient above the
/// block median. The low frequencies survive scaling / compression, so a
/// re-encode of the same frame lands on a near-identical hash.
pub(crate) fn phash(img: &RgbImage) -> u64 {
    let small = imageops::resize(
        img,
        PHASH_DCT_SIZE as u32,
        PHASH_DCT_SIZE as u32,
        FilterType::Triangle,
    );
    let mut luma = [[0f64; PHASH_DCT_SIZE]; PHASH_DCT_SIZE];
    for y in 0..PHASH_DCT_SIZE {
        for x in 0..PHASH_DCT_SIZE {
            let p = small.get_pixel(x as u32, y as u32);
            luma[y][x] = 0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64;
        }
    }
    let freq = dct_2d(&luma);

    // Median over the low-freq block EXCLUDING the DC term ([0][0]): its
    // magnitude dwarfs the AC coefficients and would drag the threshold. DC is
    // still hashed below — it always lands above the median, so its bit is a
    // constant that contributes nothing to the Hamming distance between hashes.
    let mut ac = Vec::with_capacity(PHASH_LOW_FREQ * PHASH_LOW_FREQ - 1);
    for v in 0..PHASH_LOW_FREQ {
        for u in 0..PHASH_LOW_FREQ {
            if u != 0 || v != 0 {
                ac.push(freq[v][u]);
            }
        }
    }
    let median = median(&mut ac);

    let mut hash = 0u64;
    let mut bit = 0u32;
    for v in 0..PHASH_LOW_FREQ {
        for u in 0..PHASH_LOW_FREQ {
            if freq[v][u] > median {
                hash |= 1u64 << bit;
            }
            bit += 1;
        }
    }
    hash
}

fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// MSSIM in [0,1]; 1.0 == structurally identical. Squares both frames to a common
/// size first (MSSIM requires equal dimensions). Same `image_compare` MSSIM the
/// shot detector and the conformance harness use; a compare error degrades to 0.0
/// rather than panicking.
fn structural_similarity(a: &RgbImage, b: &RgbImage) -> f64 {
    let a = imageops::resize(a, SSIM_COMPARE_DIM, SSIM_COMPARE_DIM, FilterType::Triangle);
    let b = imageops::resize(b, SSIM_COMPARE_DIM, SSIM_COMPARE_DIM, FilterType::Triangle);
    image_compare::rgb_similarity_structure(&image_compare::Algorithm::MSSIMSimple, &a, &b)
        .map(|r| r.score)
        .unwrap_or(0.0)
}

/// Separable 2D DCT-II: rows then columns. Full `PHASH_DCT_SIZE`² transform even
/// though only the low-freq corner is read — the grid is tiny (~65k mults), so
/// the naive form is cheaper to keep correct than a partial one.
fn dct_2d(input: &[[f64; PHASH_DCT_SIZE]; PHASH_DCT_SIZE]) -> [[f64; PHASH_DCT_SIZE]; PHASH_DCT_SIZE] {
    let mut rows = [[0f64; PHASH_DCT_SIZE]; PHASH_DCT_SIZE];
    for y in 0..PHASH_DCT_SIZE {
        rows[y] = dct_1d(&input[y]);
    }
    let mut out = [[0f64; PHASH_DCT_SIZE]; PHASH_DCT_SIZE];
    for x in 0..PHASH_DCT_SIZE {
        let mut col = [0f64; PHASH_DCT_SIZE];
        for (y, c) in col.iter_mut().enumerate() {
            *c = rows[y][x];
        }
        let transformed = dct_1d(&col);
        for (y, o) in out.iter_mut().enumerate() {
            o[x] = transformed[y];
        }
    }
    out
}

fn dct_1d(v: &[f64; PHASH_DCT_SIZE]) -> [f64; PHASH_DCT_SIZE] {
    let mut out = [0f64; PHASH_DCT_SIZE];
    let n = PHASH_DCT_SIZE as f64;
    for (k, o) in out.iter_mut().enumerate() {
        let mut sum = 0.0;
        for (idx, &x) in v.iter().enumerate() {
            sum += x * (std::f64::consts::PI / n * (idx as f64 + 0.5) * k as f64).cos();
        }
        *o = sum;
    }
    out
}

fn median(values: &mut [f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = values.len();
    if n % 2 == 1 {
        values[n / 2]
    } else {
        (values[n / 2 - 1] + values[n / 2]) / 2.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame-like test pattern: a sum of several distinct low spatial
    /// frequencies (`phase` shifts them to make a *different* scene). Real
    /// low-freq structure spread across the DCT block — so the pHash bits are
    /// stable under resampling, unlike a plain gradient whose block is ~2 spikes
    /// atop a cloud of near-zero coefficients that flip on any perturbation.
    fn pattern(w: u32, h: u32, phase: f64) -> RgbImage {
        use std::f64::consts::PI;
        RgbImage::from_fn(w, h, |x, y| {
            let fx = x as f64 / w as f64;
            let fy = y as f64 / h as f64;
            let v = 128.0
                + 70.0 * (2.0 * PI * fx + phase).cos()
                + 50.0 * (2.0 * PI * fy).cos()
                + 35.0 * (4.0 * PI * fx + phase).cos()
                + 25.0 * (6.0 * PI * fy).cos()
                + 20.0 * (2.0 * PI * (fx + fy)).cos();
            let r = v.clamp(0.0, 255.0) as u8;
            let g = (v * 0.9).clamp(0.0, 255.0) as u8;
            let b = (255.0 - v).clamp(0.0, 255.0) as u8;
            image::Rgb([r, g, b])
        })
    }

    /// A mild proxy-grade rescale of the same frame: half-res round-trip through
    /// a bilinear resize (scale + resample, standing in for a proxy re-encode).
    fn rescaled(a: &RgbImage) -> RgbImage {
        let (w, h) = (a.width(), a.height());
        let down = imageops::resize(a, w / 2, h / 2, FilterType::Triangle);
        imageops::resize(&down, w, h, FilterType::Triangle)
    }

    #[test]
    fn phash_of_identical_frame_has_zero_hamming() {
        let a = pattern(200, 150, 0.0);
        assert_eq!(hamming(phash(&a), phash(&a)), 0);
    }

    #[test]
    fn phash_survives_scale_and_resample() {
        // A proxy-grade rescale barely moves the low-freq bits.
        let a = pattern(320, 240, 0.0);
        let d = hamming(phash(&a), phash(&rescaled(&a)));
        assert!(d <= PHASH_MAX_HAMMING, "scaled/resampled hamming too large: {d}");
    }

    #[test]
    fn compare_identical_frames_is_similar() {
        let a = pattern(256, 192, 0.0);
        let c = compare_frames(&a, &a);
        assert_eq!(c.phash_hamming, 0);
        assert!((c.ssim - 1.0).abs() < 1e-6, "identical ssim should be ~1.0, got {}", c.ssim);
        assert!(c.similar);
    }

    #[test]
    fn compare_scaled_copy_is_similar() {
        // A proxy-grade rescale of the SAME frame must still read as similar
        // (ticket acceptance: proxy vs source at one timestamp).
        let a = pattern(320, 240, 0.0);
        let c = compare_frames(&a, &rescaled(&a));
        assert!(c.phash_hamming <= PHASH_MAX_HAMMING, "hamming {}", c.phash_hamming);
        assert!(c.ssim >= SSIM_MIN, "ssim {}", c.ssim);
        assert!(c.similar);
    }

    #[test]
    fn compare_different_frames_is_not_similar() {
        // Two unrelated scenes (phase-shifted pattern) → the gate must reject.
        let a = pattern(256, 256, 0.0);
        let b = pattern(256, 256, std::f64::consts::PI);
        let c = compare_frames(&a, &b);
        assert!(!c.similar, "phase-shifted patterns must not be similar: {c:?}");
    }

    #[test]
    fn compare_flat_field_against_pattern_is_not_similar() {
        // A flat mid-gray field vs real structure: low ssim → rejected.
        let a = pattern(256, 256, 0.0);
        let flat = RgbImage::from_pixel(256, 256, image::Rgb([128, 128, 128]));
        let c = compare_frames(&a, &flat);
        assert!(!c.similar, "pattern vs flat must not be similar: {c:?}");
        assert!(c.ssim < SSIM_MIN, "expected low ssim, got {}", c.ssim);
    }

    #[test]
    fn median_odd_and_even() {
        assert_eq!(median(&mut [3.0, 1.0, 2.0]), 2.0);
        assert_eq!(median(&mut [4.0, 1.0, 3.0, 2.0]), 2.5);
        assert_eq!(median(&mut []), 0.0);
    }
}
