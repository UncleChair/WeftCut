//! Fixture-runner shared logic.
//!
//! Two consumers live behind these free functions:
//!
//! 1. The Tauri commands `extract_video_frame` + `compare_fixture_frame`
//!    in `commands.rs` — devtools-driven baseline generation + ad-hoc
//!    regression checks (P10a/b).
//! 2. The `fixture_compare` binary in `bin/fixture_compare.rs` — CI-side
//!    gate that consumes an MP4 produced by the vitest browser test +
//!    runs the same SSIM compare without a webview (P10c).
//!
//! Sync API only — the async wrappers in `commands.rs` use
//! `spawn_blocking` to keep the tokio runtime clean.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result};
use ffmpeg_sidecar::paths::ffmpeg_path;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct FixtureManifest {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub width: u32,
    pub height: u32,
    pub sample_times_us: Vec<i64>,
}

/// SSIM pass threshold. **Mirrors `FIXTURE_SSIM_PASS_THRESHOLD` in
/// `apps/desktop/src/render/fixtures/runFixture.ts`.** Both consumers
/// must use the same value or the JS-side devtools check and the
/// CI-side `fixture_compare` will disagree on what passes.
pub const SSIM_PASS_THRESHOLD: f64 = 0.995;

/// Read `<fixture_root>/manifest.json` and parse the supported subset.
pub fn load_manifest(fixture_root: &Path) -> Result<FixtureManifest> {
    let path = fixture_root.join("manifest.json");
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("read manifest {}", path.display()))?;
    let m: FixtureManifest = serde_json::from_str(&text)
        .with_context(|| format!("parse manifest {}", path.display()))?;
    Ok(m)
}

/// `<fixture_root>/expected/t_<us>.png`. Path may not exist; caller is
/// responsible for checking before reading.
pub fn expected_png_path(fixture_root: &Path, t_us: i64) -> PathBuf {
    fixture_root.join("expected").join(format!("t_{t_us}.png"))
}

/// Extract one PNG frame from an MP4 file at composition-time `t_us`.
/// Wraps `ffmpeg-sidecar`: writes nothing extra to disk, returns the
/// PNG bytes. `-ss` before `-i` is the fast keyframe-bounded seek —
/// fine for our 1 s-GOP exports.
pub fn extract_frame_from_file(mp4_path: &Path, t_us: i64) -> Result<Vec<u8>> {
    if t_us < 0 {
        anyhow::bail!("t_us must be >= 0");
    }
    if !mp4_path.exists() {
        anyhow::bail!("mp4 not found: {}", mp4_path.display());
    }

    let png_tmp = tempfile::Builder::new()
        .prefix("weftcut-fixture-")
        .suffix(".png")
        .tempfile()
        .context("create png tempfile")?;
    let png_path = png_tmp.path().to_path_buf();

    let t_seconds = (t_us as f64) / 1_000_000.0;
    let output = Command::new(ffmpeg_path())
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
        .arg(mp4_path)
        .args(["-frames:v", "1", "-update", "1", "-f", "image2", "-c:v", "png"])
        .arg(&png_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .context("spawn ffmpeg for frame extract")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!(
            "ffmpeg exited with {} for frame at {t_us}µs: {}",
            output.status,
            stderr.trim()
        );
    }
    let bytes = std::fs::read(&png_path).context("read extracted png")?;
    if bytes.is_empty() {
        anyhow::bail!("ffmpeg wrote zero bytes for frame at {t_us}µs");
    }
    Ok(bytes)
}

/// Same as [`extract_frame_from_file`], but takes MP4 bytes in memory.
/// Used by the devtools / Tauri-command path where the MP4 never
/// touches disk between the export Worker and the compare step.
pub fn extract_frame_from_bytes(mp4_bytes: &[u8], t_us: i64) -> Result<Vec<u8>> {
    if mp4_bytes.is_empty() {
        anyhow::bail!("mp4_bytes is empty");
    }
    let mp4_tmp = tempfile::Builder::new()
        .prefix("weftcut-fixture-")
        .suffix(".mp4")
        .tempfile()
        .context("create mp4 tempfile")?;
    std::fs::write(mp4_tmp.path(), mp4_bytes).context("write mp4 tempfile")?;
    extract_frame_from_file(mp4_tmp.path(), t_us)
}

/// SSIM-compare two PNG-encoded images. Returns a score in [0, 1]
/// where 1.0 is pixel-identical. Errors when dimensions disagree —
/// that's a fixture problem (manifest dims out of sync with the
/// renderer), not a "score = 0" regression.
pub fn compare_ssim_pngs(actual_png: &[u8], expected_png: &[u8]) -> Result<f64> {
    use image::ImageReader;
    use image_compare::Algorithm;
    use std::io::Cursor;

    if actual_png.is_empty() {
        anyhow::bail!("actual_png is empty");
    }
    if expected_png.is_empty() {
        anyhow::bail!("expected_png is empty");
    }

    let actual = ImageReader::new(Cursor::new(actual_png))
        .with_guessed_format()
        .context("guess actual format")?
        .decode()
        .context("decode actual png")?
        .to_rgb8();
    let expected = ImageReader::new(Cursor::new(expected_png))
        .with_guessed_format()
        .context("guess expected format")?
        .decode()
        .context("decode expected png")?
        .to_rgb8();

    if actual.dimensions() != expected.dimensions() {
        anyhow::bail!(
            "dimensions disagree: actual {}×{} vs expected {}×{}",
            actual.width(),
            actual.height(),
            expected.width(),
            expected.height(),
        );
    }

    let result = image_compare::rgb_similarity_structure(
        &Algorithm::MSSIMSimple,
        &actual,
        &expected,
    )
    .context("ssim compare")?;
    Ok(result.score)
}

/// One sample's compare outcome — used by both the bin's JSON report
/// and any future Tauri command that wants to surface per-sample
/// status to the dev panel.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SampleReport {
    pub t_us: i64,
    pub expected_path: PathBuf,
    /// `Some(score)` when both frames could be decoded and compared;
    /// `None` when the baseline was missing or some upstream step
    /// errored (`error` carries the detail).
    pub score: Option<f64>,
    pub pass: bool,
    pub missing_baseline: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FixtureReport {
    pub fixture: String,
    pub fixture_root: PathBuf,
    pub mp4_path: PathBuf,
    pub samples: Vec<SampleReport>,
    /// True iff every sample either passed or was missing-baseline.
    /// Missing baselines are not failures — they're a "owed work"
    /// signal the bin surfaces with a non-zero exit code to make CI
    /// notice.
    pub pass: bool,
    pub any_missing_baseline: bool,
}

/// End-to-end check used by the bin: run every `sample_times_us` from
/// the manifest, extract from `mp4_path`, SSIM-compare against the
/// fixture's `expected/`, return one structured report.
pub fn check_fixture(fixture_root: &Path, mp4_path: &Path) -> Result<FixtureReport> {
    let manifest = load_manifest(fixture_root)?;
    let mut samples = Vec::with_capacity(manifest.sample_times_us.len());
    let mut all_pass = true;
    let mut any_missing = false;
    for &t_us in &manifest.sample_times_us {
        let expected_path = expected_png_path(fixture_root, t_us);
        let actual_png = match extract_frame_from_file(mp4_path, t_us) {
            Ok(b) => b,
            Err(e) => {
                all_pass = false;
                samples.push(SampleReport {
                    t_us,
                    expected_path,
                    score: None,
                    pass: false,
                    missing_baseline: false,
                    error: Some(format!("{e:#}")),
                });
                continue;
            }
        };
        if !expected_path.exists() {
            any_missing = true;
            samples.push(SampleReport {
                t_us,
                expected_path,
                score: None,
                pass: false,
                missing_baseline: true,
                error: None,
            });
            continue;
        }
        let expected_png = match std::fs::read(&expected_path) {
            Ok(b) => b,
            Err(e) => {
                all_pass = false;
                samples.push(SampleReport {
                    t_us,
                    expected_path,
                    score: None,
                    pass: false,
                    missing_baseline: false,
                    error: Some(format!("read expected: {e}")),
                });
                continue;
            }
        };
        match compare_ssim_pngs(&actual_png, &expected_png) {
            Ok(score) => {
                let pass = score >= SSIM_PASS_THRESHOLD;
                if !pass {
                    all_pass = false;
                }
                samples.push(SampleReport {
                    t_us,
                    expected_path,
                    score: Some(score),
                    pass,
                    missing_baseline: false,
                    error: None,
                });
            }
            Err(e) => {
                all_pass = false;
                samples.push(SampleReport {
                    t_us,
                    expected_path,
                    score: None,
                    pass: false,
                    missing_baseline: false,
                    error: Some(format!("{e:#}")),
                });
            }
        }
    }
    Ok(FixtureReport {
        fixture: manifest.name,
        fixture_root: fixture_root.to_path_buf(),
        mp4_path: mp4_path.to_path_buf(),
        samples,
        pass: all_pass,
        any_missing_baseline: any_missing,
    })
}
