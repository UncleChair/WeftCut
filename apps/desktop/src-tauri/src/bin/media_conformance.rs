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

/// Generalized Goertzel: DFT magnitude (amplitude estimate) at an arbitrary
/// `freq` over `samples`. `freq` need not land on a bin. ~O(n), no FFT.
fn goertzel(samples: &[f32], freq: f64, sample_rate: f64) -> f64 {
    let n = samples.len();
    if n == 0 {
        return 0.0;
    }
    let w = 2.0 * std::f64::consts::PI * freq / sample_rate;
    let coeff = 2.0 * w.cos();
    let (mut s_prev, mut s_prev2) = (0.0_f64, 0.0_f64);
    for &x in samples {
        let s = x as f64 + coeff * s_prev - s_prev2;
        s_prev2 = s_prev;
        s_prev = s;
    }
    let power = s_prev2 * s_prev2 + s_prev * s_prev - coeff * s_prev * s_prev2;
    power.max(0.0).sqrt() * 2.0 / (n as f64)
}

/// Decode `mp4` and return frame at 0-based decode index `n` as PNG bytes.
/// `select=eq(n,N)` + `-frames:v 1` decodes from the start (fine for the
/// short conformance clips) and is frame-accurate, unlike a `-ss` time seek.
fn extract_frame_png(mp4: &Path, n: u64) -> Result<Vec<u8>> {
    extract_frame_png_ex(mp4, n, None, None, false)
}

/// Decode frame `n` of `mp4` to a PNG, optionally forcing the input YUV->RGB
/// matrix/range (ignoring stream tags) and choosing 8- or 16-bit RGB. Pinning
/// the matrix at decode is what makes color comparison valid.
fn extract_frame_png_ex(
    mp4: &Path,
    n: u64,
    in_matrix: Option<&str>,
    in_range: Option<&str>,
    depth16: bool,
) -> Result<Vec<u8>> {
    if !mp4.exists() {
        anyhow::bail!("mp4 not found: {}", mp4.display());
    }
    let tmp = tempfile_path("png");
    let mut vf = format!("select=eq(n\\,{n})");
    if let (Some(m), Some(r)) = (in_matrix, in_range) {
        vf.push_str(&format!(",scale=in_color_matrix={m}:in_range={r}"));
    }
    let pix = if depth16 { "rgb48be" } else { "rgb24" };
    let status = Command::new(ffmpeg_path())
        .args(["-y", "-hide_banner", "-nostats", "-loglevel", "error", "-i"])
        .arg(mp4)
        .args(["-vf", &vf, "-frames:v", "1", "-vsync", "0", "-pix_fmt", pix, "-f", "image2", "-c:v", "png"])
        .arg(&tmp)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped())
        .output()
        .context("spawn ffmpeg")?;
    if !status.status.success() {
        anyhow::bail!(
            "ffmpeg failed for frame {n} of {}: {}",
            mp4.display(),
            String::from_utf8_lossy(&status.stderr).trim()
        );
    }
    let bytes = std::fs::read(&tmp).context("read png")?;
    let _ = std::fs::remove_file(&tmp);
    if bytes.is_empty() {
        anyhow::bail!("ffmpeg wrote 0 bytes for frame {n}");
    }
    Ok(bytes)
}

fn decode_rgb16(png: &[u8]) -> Result<image::ImageBuffer<image::Rgb<u16>, Vec<u16>>> {
    Ok(ImageReader::new(Cursor::new(png))
        .with_guessed_format().context("guess png")?
        .decode().context("decode png")?
        .to_rgb16())
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

/// Newtype for a 16-bit RGB pixel. `image` 0.25 does not export an `Rgb16`
/// alias, so we define a thin wrapper whose `.0` is `[u16; 3]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rgb16(pub [u16; 3]);

#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
struct Patch {
    id: String,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    /// Expected color in 8-bit units (0..255), NOT left-justified. Upscale with
    /// `* 257` to match image::to_rgb16 before comparing via `channel_error`.
    rgb: [u16; 3],
}

#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
struct Manifest {
    width: u32,
    height: u32,
    patches: Vec<Patch>,
}

#[derive(Debug, serde::Serialize)]
struct ChannelError {
    /// mean abs error per channel in 8-bit code units (0..255)
    mean: [f64; 3],
    /// max abs error per channel in 8-bit code units
    max: [u16; 3],
}

/// Per-channel absolute error over paired pixels, reported in 8-bit code units
/// (values are stored left-justified in u16, so /256 maps back to 8-bit).
/// Panics if lengths differ — a sampling bug, not a regression.
fn channel_error(a: &[Rgb16], b: &[Rgb16]) -> ChannelError {
    assert_eq!(a.len(), b.len());
    let n = a.len().max(1) as f64;
    let mut sum = [0f64; 3];
    let mut max = [0u16; 3];
    for (pa, pb) in a.iter().zip(b) {
        for c in 0..3 {
            let da = (pa.0[c] / 256) as i32;
            let db = (pb.0[c] / 256) as i32;
            let d = (da - db).unsigned_abs() as u16;
            sum[c] += d as f64;
            if d > max[c] {
                max[c] = d;
            }
        }
    }
    ChannelError { mean: [sum[0] / n, sum[1] / n, sum[2] / n], max }
}

/// Average the center inset of a patch rect from a 16-bit image, returning one
/// representative Rgb16. Center sampling avoids 4:2:0 edge bleed. (Wired into
/// the CLI in a later task.)
#[allow(dead_code)]
fn sample_patch(img: &image::ImageBuffer<image::Rgb<u16>, Vec<u16>>, p: &Patch) -> Rgb16 {
    let inset_w = p.w / 5;
    let inset_h = p.h / 5;
    let x0 = p.x + inset_w;
    let y0 = p.y + inset_h;
    let x1 = (p.x + p.w).saturating_sub(inset_w).min(img.width());
    let y1 = (p.y + p.h).saturating_sub(inset_h).min(img.height());
    let mut acc = [0u64; 3];
    let mut count = 0u64;
    for yy in y0..y1 {
        for xx in x0..x1 {
            let px = img.get_pixel(xx, yy);
            for c in 0..3 {
                acc[c] += px.0[c] as u64;
            }
            count += 1;
        }
    }
    let count = count.max(1);
    Rgb16([
        (acc[0] / count) as u16,
        (acc[1] / count) as u16,
        (acc[2] / count) as u16,
    ])
}

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

const AUDIO_SAMPLE_RATE: f64 = 48000.0;

/// Decode `mp4`'s audio to mono f32 PCM at 48 kHz via ffmpeg (edit list
/// applied, so AAC priming is compensated at the decoder). Returns samples in [-1,1].
fn extract_audio_pcm(mp4: &Path) -> Result<Vec<f32>> {
    if !mp4.exists() {
        anyhow::bail!("mp4 not found: {}", mp4.display());
    }
    let out = Command::new(ffmpeg_path())
        .args(["-hide_banner", "-nostats", "-loglevel", "error", "-i"])
        .arg(mp4)
        .args(["-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"])
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .context("spawn ffmpeg (audio)")?;
    if !out.status.success() {
        anyhow::bail!(
            "ffmpeg audio decode failed for {}: {}",
            mp4.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let mut pcm = Vec::with_capacity(out.stdout.len() / 4);
    for chunk in out.stdout.chunks_exact(4) {
        pcm.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    if pcm.is_empty() {
        anyhow::bail!("no audio samples decoded from {}", mp4.display());
    }
    Ok(pcm)
}

const AUDIO_BASE_HZ: f64 = 400.0;
const AUDIO_STEP_HZ: f64 = 120.0;
const AUDIO_DRIFT_SLOPE_TOL: f64 = 0.01;
const AUDIO_OFFSET_TOL_MS: f64 = 66.0;
const AUDIO_SNR_FLOOR_DB: f64 = 15.0;

fn audio_expected_freq(second: usize) -> f64 {
    AUDIO_BASE_HZ + AUDIO_STEP_HZ * second as f64
}

#[derive(Debug, serde::Serialize)]
struct AudioSample {
    second: usize,
    expected_freq: f64,
    detected_freq: f64,
    aligned: bool,
    snr_db: f64,
    pass: bool,
}

#[derive(Debug, serde::Serialize)]
struct AudioReport {
    duration_s: f64,
    seconds: usize,
    drift_slope: f64,
    offset_ms: f64,
    samples: Vec<AudioSample>,
    pass: bool,
}

/// Per-second alignment + boundary drift + tone SNR over mono PCM.
fn analyze_audio(pcm: &[f32]) -> AudioReport {
    let sr = AUDIO_SAMPLE_RATE;
    let duration_s = pcm.len() as f64 / sr;
    let secs = duration_s.floor() as usize;
    let cands: Vec<f64> = (0..secs).map(audio_expected_freq).collect();

    let mut samples = Vec::with_capacity(secs);
    for s in 0..secs {
        let lo = ((s as f64 + 0.4) * sr) as usize;
        let hi = (((s as f64 + 0.6) * sr) as usize).min(pcm.len());
        let win = if lo < hi { &pcm[lo..hi] } else { &pcm[0..0] };
        let mags: Vec<f64> = cands.iter().map(|&f| goertzel(win, f, sr)).collect();
        let (best_i, &best) = mags
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            .unwrap_or((s, &0.0));
        let second_best = mags
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != best_i)
            .map(|(_, &m)| m)
            .fold(0.0_f64, f64::max);
        let snr_db = 20.0 * (best / (second_best + 1e-9)).log10();
        let aligned = best_i == s;
        samples.push(AudioSample {
            second: s,
            expected_freq: audio_expected_freq(s),
            detected_freq: if secs > 0 { cands[best_i] } else { 0.0 },
            aligned,
            snr_db,
            pass: aligned && snr_db >= AUDIO_SNR_FLOOR_DB,
        });
    }

    let (slope, offset_s) = fit_boundaries(pcm, &cands, sr);
    let drift_slope = slope;
    let offset_ms = offset_s * 1000.0;

    let pass = !samples.is_empty()
        && samples.iter().all(|x| x.pass)
        && (drift_slope - 1.0).abs() <= AUDIO_DRIFT_SLOPE_TOL
        && offset_ms.abs() <= AUDIO_OFFSET_TOL_MS;

    AudioReport { duration_s, seconds: secs, drift_slope, offset_ms, samples, pass }
}

/// Scan windows (100 ms, 25 ms hop); dominant candidate per window gives a step
/// function. Boundary k = first window where dominant becomes k. Fit time vs k
/// → (slope, offset_seconds). Returns (1.0, 0.0) if too few transitions.
fn fit_boundaries(pcm: &[f32], cands: &[f64], sr: f64) -> (f64, f64) {
    let win = (0.1 * sr) as usize;
    let hop = (0.025 * sr) as usize;
    if cands.len() < 2 || pcm.len() < win {
        return (1.0, 0.0);
    }
    let mut prev_dom: Option<usize> = None;
    let mut xs: Vec<f64> = Vec::new();
    let mut ys: Vec<f64> = Vec::new();
    let mut i = 0;
    while i + win <= pcm.len() {
        let w = &pcm[i..i + win];
        let dom = cands
            .iter()
            .enumerate()
            .map(|(j, &f)| (j, goertzel(w, f, sr)))
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(j, _)| j)
            .unwrap_or(0);
        if let Some(p) = prev_dom {
            if dom == p + 1 {
                xs.push(dom as f64);
                ys.push((i as f64 + win as f64 / 2.0) / sr);
            }
        }
        prev_dom = Some(dom);
        i += hop;
    }
    if xs.len() < 2 {
        return (1.0, 0.0);
    }
    let n = xs.len() as f64;
    let sx: f64 = xs.iter().sum();
    let sy: f64 = ys.iter().sum();
    let sxx: f64 = xs.iter().map(|x| x * x).sum();
    let sxy: f64 = xs.iter().zip(&ys).map(|(x, y)| x * y).sum();
    let denom = n * sxx - sx * sx;
    if denom.abs() < 1e-9 {
        return (1.0, 0.0);
    }
    let slope = (n * sxy - sx * sy) / denom;
    let offset = (sy - slope * sx) / n;
    (slope, offset)
}

#[derive(Debug, serde::Serialize)]
struct SampleResult {
    index: u64,
    best_match_index: u64,
    aligned: bool,
    ssim: f64,
    psnr_db: f64,
    pass: bool,
}

#[derive(Debug, serde::Serialize)]
struct Report {
    output: String,
    source: String,
    ssim_min: f64,
    samples: Vec<SampleResult>,
    pass: bool,
}

#[derive(Debug, serde::Serialize)]
struct BandingStats {
    distinct_levels: usize,
    max_plateau: usize,
}

/// Over a single ramp row (one channel), count distinct values and the longest
/// run of identical consecutive values (the plateau width). A clean 10-bit ramp
/// has many levels and plateau ~1; an 8-bit-quantized ramp has ~4x-wide
/// plateaus. Dither breaks plateaus up (distinct recovers, but with noise).
fn banding_stats(row: &[u16]) -> BandingStats {
    if row.is_empty() {
        return BandingStats { distinct_levels: 0, max_plateau: 0 };
    }
    let mut distinct = std::collections::BTreeSet::new();
    let mut max_plateau = 1usize;
    let mut run = 1usize;
    distinct.insert(row[0]);
    for w in row.windows(2) {
        distinct.insert(w[1]);
        if w[1] == w[0] {
            run += 1;
            max_plateau = max_plateau.max(run);
        } else {
            run = 1;
        }
    }
    BandingStats { distinct_levels: distinct.len(), max_plateau }
}

#[derive(Debug, serde::Serialize)]
struct GradientReport {
    sample: u64,
    row_y: u32,
    /// per-channel banding over the sampled mid-row (R, G, B)
    banding: [BandingStats; 3],
    /// 16-bit RGB at x=0 and x=mid — to confirm 10->16 scaling externally
    probe_x0: [u16; 3],
    probe_mid: [u16; 3],
}

/// Decode one frame as 16-bit RGB under a forced matrix, sample the mid-row, and
/// report per-channel banding (distinct levels + max plateau). Used by the axis-B
/// proxy probe to compare a 10-bit source ramp against its 8-bit proxy.
fn analyze_gradient(file: &Path, sample: u64, in_matrix: &str, in_range: &str) -> Result<GradientReport> {
    let img = decode_rgb16(&extract_frame_png_ex(file, sample, Some(in_matrix), Some(in_range), true)?)?;
    let y = img.height() / 2;
    let mut rows: [Vec<u16>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for x in 0..img.width() {
        let px = img.get_pixel(x, y);
        for c in 0..3 {
            rows[c].push(px.0[c]);
        }
    }
    let banding = [banding_stats(&rows[0]), banding_stats(&rows[1]), banding_stats(&rows[2])];
    let x0 = img.get_pixel(0, y);
    let mid = img.get_pixel(img.width() / 2, y);
    Ok(GradientReport {
        sample,
        row_y: y,
        banding,
        probe_x0: [x0.0[0], x0.0[1], x0.0[2]],
        probe_mid: [mid.0[0], mid.0[1], mid.0[2]],
    })
}

fn analyze(
    output: &Path,
    source: &Path,
    samples: &[u64],
    window: u64,
    ssim_min: f64,
) -> Result<Report> {
    let mut out_samples = Vec::with_capacity(samples.len());
    let mut all_pass = true;
    for &n in samples {
        let out_png = extract_frame_png(output, n)?;
        let (best, _best_score) = best_match_index(&out_png, source, n, window)?;
        let src_png = extract_frame_png(source, n)?;
        let ssim = ssim_pngs(&out_png, &src_png)?;
        let psnr_db = psnr_pngs(&out_png, &src_png)?;
        let aligned = best == n;
        let pass = aligned && ssim >= ssim_min;
        if !pass {
            all_pass = false;
        }
        out_samples.push(SampleResult {
            index: n,
            best_match_index: best,
            aligned,
            ssim,
            psnr_db,
            pass,
        });
    }
    Ok(Report {
        output: output.display().to_string(),
        source: source.display().to_string(),
        ssim_min,
        samples: out_samples,
        pass: all_pass,
    })
}

#[derive(Debug, serde::Serialize)]
struct PatchResult {
    id: String,
    authored: [u16; 3],
    output: [u16; 3],
    source: [u16; 3],
    app_error: ChannelError,   // output vs decoded-source (the gate)
    total_error: ChannelError, // output vs authored RGB (diagnostic)
}

#[derive(Debug, serde::Serialize)]
struct ColorReport {
    output: String,
    source: String,
    in_matrix: String,
    in_range: String,
    sample: u64,
    patches: Vec<PatchResult>,
    worst_app_max: u16, // worst app_error.max across all patches/channels
}

/// Decode one frame of output + source and report per-channel app-only error
/// (output vs source = the gate) plus total error (output vs authored RGB =
/// diagnostic). This is a PERCEPTUAL color-loss metric (displayed-color
/// fidelity), NOT a matrix-roundtrip check:
///
///   - The OUTPUT is decoded by its OWN embedded color tags — the WebCodecs HD
///     encoder normalizes every export to bt709 (it ignores the input frame's
///     colorSpace and writes a resolution default), so a faithful export of a
///     non-709 source is legitimately bt709-tagged. Decoding it by its own tag
///     measures what a player actually shows.
///   - The SOURCE is decoded under the FORCED `in_matrix`/`in_range`: the test
///     fixtures carry only a matrix tag (primaries/transfer are `unknown`), so
///     letting ffmpeg guess would be unstable — we pin the source's intended
///     interpretation as the reference.
///
/// So `app_error` answers "does the export show the same colors as the source?"
/// A 601-source export normalized to 709 with intact colors scores near-zero
/// (its small residual is the documented normalization standard line); a
/// decode-side matrix bug (e.g. the source decoded as the wrong matrix before
/// compositing) scores large; a full→limited RANGE squash scores large too.
fn analyze_color(
    output: &Path,
    source: &Path,
    manifest: &Manifest,
    sample: u64,
    in_matrix: &str,
    in_range: &str,
) -> Result<ColorReport> {
    // Output: decode by its own embedded tag (None ⇒ no forced scale).
    let out_img = decode_rgb16(&extract_frame_png_ex(output, sample, None, None, false)?)?;
    // Source: decode under the forced reference matrix/range (incomplete tags).
    let src_img = decode_rgb16(&extract_frame_png_ex(source, sample, Some(in_matrix), Some(in_range), false)?)?;
    let mut patches = Vec::with_capacity(manifest.patches.len());
    let mut worst = 0u16;
    for p in &manifest.patches {
        let o = sample_patch(&out_img, p);
        let s = sample_patch(&src_img, p);
        // *257 matches image::to_rgb16's 8->16 byte-replication so authored
        // aligns with how output/source were upscaled (gate uses app_error,
        // which compares output vs source — both via to_rgb16 — so it is exact).
        debug_assert!(p.rgb.iter().all(|&v| v <= 255), "manifest rgb must be 8-bit (0..=255), got {:?}", p.rgb);
        let authored = Rgb16([p.rgb[0] * 257, p.rgb[1] * 257, p.rgb[2] * 257]);
        let app = channel_error(&[o], &[s]);
        let total = channel_error(&[o], &[authored]);
        worst = worst.max(*app.max.iter().max().unwrap());
        patches.push(PatchResult {
            id: p.id.clone(),
            authored: p.rgb,
            output: [o.0[0] / 256, o.0[1] / 256, o.0[2] / 256],
            source: [s.0[0] / 256, s.0[1] / 256, s.0[2] / 256],
            app_error: app,
            total_error: total,
        });
    }
    Ok(ColorReport {
        output: output.display().to_string(),
        source: source.display().to_string(),
        in_matrix: in_matrix.into(),
        in_range: in_range.into(),
        sample,
        patches,
        worst_app_max: worst,
    })
}

fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let mut output: Option<String> = None;
    let mut source: Option<String> = None;
    let mut samples: Vec<u64> = Vec::new();
    let mut window: u64 = 2;
    let mut ssim_min: f64 = 0.95;
    let mut audio = false;
    let mut color = false;
    let mut manifest_path: Option<String> = None;
    let mut in_matrix: Option<String> = None;
    let mut in_range: Option<String> = None;
    let mut sample: u64 = 10;
    let mut gradient_row = false;
    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--output" => output = it.next().cloned(),
            "--source" => source = it.next().cloned(),
            "--audio" => audio = true,
            "--samples" => {
                samples = it
                    .next()
                    .map(|s| s.split(',').filter_map(|x| x.trim().parse().ok()).collect())
                    .unwrap_or_default();
            }
            "--window" => window = it.next().and_then(|s| s.parse().ok()).unwrap_or(2),
            "--ssim-min" => ssim_min = it.next().and_then(|s| s.parse().ok()).unwrap_or(0.95),
            "--color" => color = true,
            "--manifest" => manifest_path = it.next().cloned(),
            "--in-matrix" => in_matrix = it.next().cloned(),
            "--in-range" => in_range = it.next().cloned(),
            "--sample" => sample = it.next().and_then(|s| s.parse().ok()).unwrap_or(10),
            "--gradient-row" => gradient_row = true,
            other => {
                eprintln!("media_conformance: unknown arg `{other}`");
                return std::process::ExitCode::from(2);
            }
        }
    }
    let (Some(output), Some(source)) = (output, source) else {
        eprintln!("media_conformance: --output and --source are required");
        return std::process::ExitCode::from(2);
    };
    if gradient_row {
        let (Some(im), Some(ir)) = (in_matrix.clone(), in_range.clone()) else {
            eprintln!("media_conformance --gradient-row requires --in-matrix and --in-range");
            return std::process::ExitCode::from(2);
        };
        return match analyze_gradient(Path::new(&output), sample, &im, &ir) {
            Ok(r) => { println!("{}", serde_json::to_string_pretty(&r).unwrap()); std::process::ExitCode::SUCCESS }
            Err(e) => { eprintln!("media_conformance: {e:#}"); std::process::ExitCode::from(3) }
        };
    }
    if color {
        let (Some(mp), Some(im), Some(ir)) = (manifest_path, in_matrix, in_range) else {
            eprintln!("media_conformance --color requires --manifest, --in-matrix, --in-range");
            return std::process::ExitCode::from(2);
        };
        let manifest: Manifest = match std::fs::read_to_string(&mp) {
            Ok(s) => match serde_json::from_str(&s) {
                Ok(m) => m,
                Err(e) => { eprintln!("media_conformance: manifest parse: {e:#}"); return std::process::ExitCode::from(3); }
            },
            Err(e) => { eprintln!("media_conformance: manifest read: {e:#}"); return std::process::ExitCode::from(3); }
        };
        return match analyze_color(Path::new(&output), Path::new(&source), &manifest, sample, &im, &ir) {
            Ok(r) => { println!("{}", serde_json::to_string_pretty(&r).unwrap()); std::process::ExitCode::SUCCESS }
            Err(e) => { eprintln!("media_conformance: {e:#}"); std::process::ExitCode::from(3) }
        };
    }
    if audio {
        let pcm = match extract_audio_pcm(Path::new(&output)) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("media_conformance: {e:#}");
                return std::process::ExitCode::from(3);
            }
        };
        let report = analyze_audio(&pcm);
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
        return if report.pass {
            std::process::ExitCode::SUCCESS
        } else {
            std::process::ExitCode::from(1)
        };
    }
    if samples.is_empty() {
        eprintln!("media_conformance: --samples N1,N2,... is required");
        return std::process::ExitCode::from(2);
    }
    match analyze(Path::new(&output), Path::new(&source), &samples, window, ssim_min) {
        Ok(report) => {
            println!("{}", serde_json::to_string_pretty(&report).unwrap());
            if report.pass {
                std::process::ExitCode::SUCCESS
            } else {
                std::process::ExitCode::from(1)
            }
        }
        Err(e) => {
            eprintln!("media_conformance: {e:#}");
            std::process::ExitCode::from(3)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn goertzel_picks_the_present_tone() {
        let sr = 48000.0;
        let n = 4800; // 100 ms
        let f = 760.0;
        let samples: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * f * (i as f64) / sr).sin() as f32)
            .collect();
        let on = goertzel(&samples, 760.0, sr);
        let off = goertzel(&samples, 1240.0, sr);
        assert!(on > 0.4, "on-frequency magnitude too low: {on}");
        assert!(on > off * 5.0, "on={on} should dominate off={off}");
    }

    fn synth_pcm(secs: usize, offset_samples: usize) -> Vec<f32> {
        let sr = AUDIO_SAMPLE_RATE;
        let total = (secs as f64 * sr) as usize + offset_samples;
        let mut pcm = vec![0.0f32; total];
        for i in 0..total {
            let t = i as f64 / sr;
            let seg = ((i.saturating_sub(offset_samples)) as f64 / sr).floor() as usize;
            if seg >= secs { continue; }
            let f = audio_expected_freq(seg);
            pcm[i] = (2.0 * std::f64::consts::PI * f * t).sin() as f32 * 0.8;
        }
        pcm
    }

    #[test]
    fn analyze_audio_clean_signal_passes() {
        let r = analyze_audio(&synth_pcm(10, 0));
        assert_eq!(r.samples.len(), 10);
        assert!(r.samples.iter().all(|s| s.aligned), "all seconds must align: {r:?}");
        assert!((r.drift_slope - 1.0).abs() < 0.01, "slope {} not ~1", r.drift_slope);
        assert!(r.offset_ms.abs() < 30.0, "offset {}ms too large", r.offset_ms);
        assert!(r.samples.iter().all(|s| s.snr_db > 15.0), "snr floor");
        assert!(r.pass);
    }

    #[test]
    fn analyze_audio_flags_a_dropped_second() {
        let mut pcm = synth_pcm(10, 0);
        let sr = AUDIO_SAMPLE_RATE;
        for i in (5.0 * sr) as usize..(6.0 * sr) as usize {
            let t = i as f64 / sr;
            pcm[i] = (2.0 * std::f64::consts::PI * audio_expected_freq(6) * t).sin() as f32 * 0.8;
        }
        let r = analyze_audio(&pcm);
        assert!(!r.samples[5].aligned, "second 5 should be flagged misaligned");
        assert!(!r.pass);
    }

    /// Like `synth_pcm` but time-stretched: tone `k` occupies the sample interval
    /// `[stretch*k*sr, stretch*(k+1)*sr)`, so the per-second tone boundaries land
    /// at `stretch*k` seconds instead of `k`. Phase is continuous (t = i/sr) and
    /// amplitude matches `synth_pcm`. A `stretch > 1` simulates A/V drift where
    /// audio runs slow relative to its nominal one-tone-per-second grid.
    fn synth_pcm_stretched(secs: usize, stretch: f64) -> Vec<f32> {
        let sr = AUDIO_SAMPLE_RATE;
        let total = (stretch * secs as f64 * sr) as usize;
        let mut pcm = vec![0.0f32; total];
        for i in 0..total {
            let t = i as f64 / sr;
            let seg = (i as f64 / (sr * stretch)).floor() as usize;
            if seg >= secs { continue; }
            let f = audio_expected_freq(seg);
            pcm[i] = (2.0 * std::f64::consts::PI * f * t).sin() as f32 * 0.8;
        }
        pcm
    }

    // Locks the drift-detection path: a time-stretched signal must make
    // `fit_boundaries` return a non-unity slope (the headline feature of the
    // audio axis). Every prior test has slope == 1.0, so the slope computation
    // is otherwise unexercised. stretch=1.02 puts the 9 tone boundaries at
    // ~1.02*k seconds; the least-squares fit recovers slope ~1.02, which
    // exceeds AUDIO_DRIFT_SLOPE_TOL (0.01) and fails the report.
    #[test]
    fn analyze_audio_detects_drift() {
        let r = analyze_audio(&synth_pcm_stretched(10, 1.02));
        // Proves the fit actually ran (>=2 boundaries; otherwise it falls back
        // to the 1.0 sentinel) AND that the slope is non-unity.
        eprintln!("drift_slope = {}", r.drift_slope);
        assert!(
            (r.drift_slope - 1.02).abs() < 0.01,
            "expected slope ~1.02 from a 2% time-stretch, got {} (1.0 would mean the synthesis didn't stretch the boundaries)",
            r.drift_slope
        );
        assert!(!r.pass, "2% drift exceeds AUDIO_DRIFT_SLOPE_TOL, report must fail");
    }

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

    #[test]
    fn analyze_self_compare_passes_and_aligns() {
        // output == source == tiny clip -> every sample aligns to itself with
        // SSIM ~1.0 and the report is all-pass.
        let clip = std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fixtures/media/tiny.mp4"
        ));
        let report = analyze(clip, clip, &[5, 10, 20], 2, 0.95).unwrap();
        assert!(report.pass, "self-compare must pass: {report:?}");
        for s in &report.samples {
            assert_eq!(s.index, s.best_match_index);
            assert!(s.ssim > 0.999);
        }
    }

    #[test]
    fn channel_error_zero_for_identical() {
        let a = [Rgb16([100 << 8, 200 << 8, 50 << 8])];
        let e = channel_error(&a, &a);
        assert_eq!(e.max, [0, 0, 0]);
        assert!(e.mean.iter().all(|&m| m == 0.0));
    }

    #[test]
    fn channel_error_reports_per_channel_delta() {
        // two pixels; red off by 4 and 6 -> mean 5, max 6 (in 8-bit code units)
        let a = [Rgb16([10 << 8, 0, 0]), Rgb16([10 << 8, 0, 0])];
        let b = [Rgb16([14 << 8, 0, 0]), Rgb16([16 << 8, 0, 0])];
        let e = channel_error(&a, &b);
        assert_eq!(e.max[0], 6);
        assert!((e.mean[0] - 5.0).abs() < 1e-9);
    }

    #[test]
    fn manifest_parses_patches() {
        let json = r#"{"width":1920,"height":1080,"patches":[{"id":"red","x":0,"y":0,"w":10,"h":10,"rgb":[255,0,0]}]}"#;
        let m: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.patches[0].id, "red");
        assert_eq!(m.patches[0].rgb, [255, 0, 0]);
    }

    #[test]
    fn banding_full_ramp_has_many_levels() {
        // 256 strictly increasing values -> 256 distinct levels, max plateau 1
        let row: Vec<u16> = (0..256u16).map(|v| v << 8).collect();
        let b = banding_stats(&row);
        assert_eq!(b.distinct_levels, 256);
        assert_eq!(b.max_plateau, 1);
    }

    #[test]
    fn banding_quantized_ramp_has_wide_plateaus() {
        // simulate 8-bit content stretched over 1024 samples: 256 levels, each
        // repeated 4x -> distinct 256, max plateau 4
        let row: Vec<u16> = (0..1024u16).map(|i| ((i / 4) << 8) as u16).collect();
        let b = banding_stats(&row);
        assert_eq!(b.distinct_levels, 256);
        assert_eq!(b.max_plateau, 4);
    }
}
