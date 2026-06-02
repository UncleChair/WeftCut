# `media_conformance` Analyzer Bin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new, self-contained Rust CLI bin `media_conformance` that, given an exported MP4 and its source MP4, verifies **frame alignment** and measures **app-only conversion loss** at sampled frame indices — producer-agnostic, runnable today against any export.

**Architecture:** ffmpeg-sidecar extracts frames by index; `image`/`image-compare` compute SSIM. Alignment exploits the burned-in per-frame counter in the test clips: an aligned output frame `N` must best-match (highest SSIM) source frame `N` within a small index window — no OCR/glyph geometry. The same `SSIM(out_N, src_N)` (plus a hand-rolled PSNR) is the loss metric. Output is structured JSON + non-zero exit on any failure.

**Tech Stack:** Rust, ffmpeg-sidecar, image (PNG), image-compare (MSSIMSimple). Runs after Plan 1 (which removed the old `fixtures.rs`/`fixture_compare`; the two pure primitives are re-created here, not imported).

**Branch:** `test/media-conformance-e2e` (continues after Plan 1).

**Slice-1 scope note (DECISION — flag for reviewer):** Alignment uses **windowed best-match SSIM**, NOT absolute glyph-OCR of the `FRAME NNNNN` text. Rationale: for 1:1 placement at unchanged fps the source↔output index map is identity, and the burned-in counter (incl. the 300px center digit) makes adjacent frames visually distinct enough that argmax-SSIM is unambiguous — fully deterministic, zero fragile pixel geometry. Absolute glyph reading is a documented follow-on, needed only for the later fps-conversion slices where the 1:1 map breaks (see "Follow-on").

---

### Task 1: Bin scaffold + frame extraction by index

**Files:**
- Create: `apps/desktop/src-tauri/src/bin/media_conformance.rs`
- (No `Cargo.toml` change — `src/bin/*.rs` is auto-discovered; `ffmpeg-sidecar`, `image`, `image-compare`, `anyhow` are already deps.)

- [ ] **Step 1: Write a failing unit test for index extraction (self-identity)**

Add to the bottom of `apps/desktop/src-tauri/src/bin/media_conformance.rs`:

```rust
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
```

- [ ] **Step 2: Run it to confirm it fails (function missing)**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --bin media_conformance 2>&1 | tail -20`
Expected: compile error — `cannot find function 'extract_frame_png'`.

- [ ] **Step 3: Implement extraction + a minimal `main`**

Put at the top of the file:

```rust
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
/// Avoids the `tempfile` crate (no need to keep the handle — ffmpeg writes
/// the file, we read then delete it).
fn tempfile_path(ext: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    // pid + a monotonic counter keeps it unique within a run.
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
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --bin media_conformance 2>&1 | tail -20`
Expected: `test extract_frame_is_deterministic ... ok`. (Requires ffmpeg-sidecar's bundled binary or system ffmpeg — same as the old `fixtures.rs` used.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/bin/media_conformance.rs
git commit -m "feat(test): media_conformance bin — frame extraction by index"
```

---

### Task 2: SSIM + PSNR + windowed alignment

**Files:**
- Modify: `apps/desktop/src-tauri/src/bin/media_conformance.rs`

- [ ] **Step 1: Write failing tests for SSIM identity + best-match alignment**

Add these tests inside the existing `mod tests`:

```rust
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
```

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --bin media_conformance 2>&1 | tail -20`
Expected: compile errors — `ssim_pngs` / `best_match_index` not found.

- [ ] **Step 3: Implement SSIM, PSNR, and windowed best-match**

Add above `fn main()`:

```rust
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

/// Peak SNR in dB over RGB. Higher is better; identical frames -> +inf, which
/// we clamp to 100.0 for JSON-friendliness.
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
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --bin media_conformance 2>&1 | tail -20`
Expected: `ssim_identity_is_one ... ok`, `best_match_of_self_is_same_index ... ok`, plus Task 1's test still ok.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/bin/media_conformance.rs
git commit -m "feat(test): media_conformance — ssim/psnr + windowed alignment"
```

---

### Task 3: CLI args, per-sample report, exit codes

**Files:**
- Modify: `apps/desktop/src-tauri/src/bin/media_conformance.rs`

- [ ] **Step 1: Write a failing test for the per-sample analysis result**

Add inside `mod tests`:

```rust
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
```

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --bin media_conformance 2>&1 | tail -20`
Expected: `cannot find function 'analyze'` / `Report` undefined.

- [ ] **Step 3: Implement the report types + `analyze` + real `main`**

Add the types + `analyze` above `fn main()`:

```rust
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
```

Replace the stub `fn main()` with:

```rust
fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let mut output: Option<String> = None;
    let mut source: Option<String> = None;
    let mut samples: Vec<u64> = Vec::new();
    let mut window: u64 = 2;
    let mut ssim_min: f64 = 0.95;
    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--output" => output = it.next().cloned(),
            "--source" => source = it.next().cloned(),
            "--samples" => {
                samples = it
                    .next()
                    .map(|s| s.split(',').filter_map(|x| x.trim().parse().ok()).collect())
                    .unwrap_or_default();
            }
            "--window" => window = it.next().and_then(|s| s.parse().ok()).unwrap_or(2),
            "--ssim-min" => ssim_min = it.next().and_then(|s| s.parse().ok()).unwrap_or(0.95),
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
```

(`serde` + `serde_json` are already deps. Remove the now-unused `use std::process::Stdio;`? No — `extract_frame_png` still uses `Stdio`. Keep all `use`s.)

- [ ] **Step 4: Run tests to confirm pass**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --bin media_conformance 2>&1 | tail -20`
Expected: all four tests `ok`.

- [ ] **Step 5: Build + manual self-compare smoke**

Run: `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --bin media_conformance`
Expected: exit 0.

Run (self-compare smoke — same file as output+source must pass):
```bash
cargo run --manifest-path apps/desktop/src-tauri/Cargo.toml --bin media_conformance --quiet -- \
  --output apps/desktop/fixtures/media/tiny.mp4 \
  --source apps/desktop/fixtures/media/tiny.mp4 \
  --samples 5,10,20
```
Expected: JSON report with `"pass": true`, every sample `aligned: true`, `ssim` ~1.0; exit code 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/bin/media_conformance.rs
git commit -m "feat(test): media_conformance CLI — per-sample report + exit codes"
```

---

## Self-Review

**Spec coverage:** new bin (not extending `fixture_compare`) ✓; salvaged primitives re-created locally (`extract_frame_png` ≈ old `extract_frame_from_file`, `ssim_pngs` ≈ old `compare_ssim_pngs`) ✓; app-only loss = output vs decoded **source** same index ✓ (`analyze`); frame alignment via the burned-in counter ✓ (windowed best-match — slice-1 method, flagged). PSNR added per spec's "SSIM/PSNR".

**Placeholder scan:** none — every function is fully implemented; the stub `main` in Task 1 is explicitly replaced in Task 3.

**Type/name consistency:** `extract_frame_png`, `ssim_pngs`, `psnr_pngs`, `best_match_index`, `analyze`, `SampleResult`, `Report` are defined once and referenced consistently across tasks; CLI flags (`--output/--source/--samples/--window/--ssim-min`) match between `main` and the spec.

**Open item carried to execution:** the self-compare tests prove mechanics; the first REAL output-vs-source run happens once Plan 3's producer exists (or manually against an existing export of a known source). The `--ssim-min 0.95` default may need tuning against the first real H.264-export number — record it then.

## Follow-on (later slices, not here)

- **Absolute frame-number reader** (glyph-match the `FRAME NNNNN` text): needed when the source↔output index map is NOT identity (fps conversion, trims). Calibrate digit templates by rendering consola.ttf at fontsize 42 via ffmpeg drawtext.
- Audio-alignment metric (after `generate.go` gains a sync marker).
