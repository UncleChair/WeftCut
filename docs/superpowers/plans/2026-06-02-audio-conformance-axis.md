# Audio Conformance Axis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an audio conformance axis — verify exported audio for alignment (which second), A/V sync drift, and fidelity — mirroring the existing video axis.

**Architecture:** A new audio fixture carries per-second frequency-stepped pure tones (`F_k = 400 + 120·k Hz`) alongside the burned-in counter video. The `media_conformance` Rust binary gains an `--audio` mode that decodes the export to PCM (via ffmpeg) and uses Goertzel at the known candidate frequencies to measure per-second alignment, second-boundary drift, and tone SNR. A new E2E spec drives import→export→analyze.

**Tech Stack:** Go (fixture generator, external), Rust (analyzer: ffmpeg shell + hand-written Goertzel, no new crates), WebdriverIO/Node (e2e + `analyze.mjs`).

**Spec:** `docs/superpowers/specs/2026-06-02-audio-conformance-axis-design.md`

**Shared constant (MUST match across Go + Rust, like the snap-math/engine-source pairs):** `BASE = 400 Hz`, `STEP = 120 Hz`, `SAMPLE_RATE = 48000`, per-second tones, fixture duration = 10 s.

---

## File Structure

- `C:/Users/jonny/Desktop/learning/testfile/generate.go` (EXTERNAL, not in repo) — `--audio` flag adds the marked audio track; regenerates `test_1080p_30fps_audio.mp4`.
- `apps/desktop/src-tauri/src/bin/media_conformance.rs` (MODIFY) — `goertzel`, `extract_audio_pcm`, `analyze_audio` + `AudioReport`, and an `--audio` branch in `main`.
- `apps/desktop/e2e/lib/analyze.mjs` (MODIFY) — `audio` passthrough (`--audio`).
- `apps/desktop/e2e/specs/audio_conformance.e2e.js` (CREATE) — the audio spec.

---

## Task 1: Audio fixture — `generate.go --audio` + regenerate

**Files:**
- Modify: `C:/Users/jonny/Desktop/learning/testfile/generate.go` (external)
- Produces: `C:/Users/jonny/Desktop/learning/testfile/test_1080p_30fps_audio.mp4`

- [ ] **Step 1: Add the `--audio` flag + marked audio track**

In `generate.go`, add a flag and, for the mp4 path, build per-second sine inputs + a concat into the existing filter graph. Add near the other flags:

```go
	audio := flag.Bool("audio", false, "add a per-second frequency-stepped tone track (test marker) + name output *_audio.mp4")
```

After `out` is computed, when `*audio` is set for the mp4 path, override the args. Replace the `case "mp4", "mkv", "mov":` body with a branch:

```go
	case "mp4", "mkv", "mov":
		if *audio {
			out = fmt.Sprintf("test_%dp_%dfps_audio.%s", height, *fps, *format)
			const audioBaseHz = 400
			const audioStepHz = 120
			const audioSR = 48000
			// testsrc2 video input is input 0; append one sine input per second.
			args = append([]string{}, input...)
			for k := 0; k < duration; k++ {
				freq := audioBaseHz + audioStepHz*k
				args = append(args, "-f", "lavfi", "-i",
					fmt.Sprintf("sine=frequency=%d:duration=1:sample_rate=%d", freq, audioSR))
			}
			// filter_complex: video chain on [0:v] -> [v]; concat the N sines -> [a].
			var concatIn strings.Builder
			for k := 1; k <= duration; k++ {
				concatIn.WriteString(fmt.Sprintf("[%d:a]", k))
			}
			fc := fmt.Sprintf("[0:v]%s,%s[v];%sconcat=n=%d:v=0:a=1[a]",
				vfChain, colorVF, concatIn.String(), duration)
			args = append(args, "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
				"-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "medium")
			args = append(args, colorTags...)
			args = append(args, "-c:a", "aac", "-b:a", "192k", out)
		} else {
			args = append(input, "-vf", vfChain+","+colorVF, "-c:v", "libx264",
				"-pix_fmt", "yuv420p", "-crf", "23", "-preset", "medium")
			args = append(args, colorTags...)
			args = append(args, "-an", out)
		}
```

- [ ] **Step 2: Regenerate the audio fixture**

Run (from the testfile dir):
```bash
cd /c/Users/jonny/Desktop/learning/testfile && go run generate.go --fps 30 --format mp4 --audio
```
Expected: `Done: test_1080p_30fps_audio.mp4`.

- [ ] **Step 3: Verify the fixture has the expected audio + video**

Run (FP = the winget ffprobe path):
```bash
FP=/c/Users/jonny/AppData/Local/Microsoft/WinGet/Links/ffprobe.exe
"$FP" -v error -show_entries stream=codec_type,codec_name,sample_rate,channels,duration -of csv "$NEW"
```
Expected: a `video,h264,...` stream (bt709) AND an `audio,aac,48000,1,~10` stream. Spot-check second 3's tone is ~760 Hz:
```bash
FF=/c/Users/jonny/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe
"$FF" -v error -ss 3.3 -t 0.2 -i "$NEW" -vn -af "astats=metadata=1" -f null - 2>&1 | grep -i "Zero crossings rate" 
```
(Or eyeball via a quick FFT tool.) Expected: dominant frequency near 400+120·3 = 760 Hz.

- [ ] **Step 4: (No commit — external fixture, not in the repo.)** Note in the PR/summary that `generate.go` + `test_1080p_30fps_audio.mp4` changed in the external `testfile/` dir.

---

## Task 2: Goertzel magnitude + unit test

**Files:**
- Modify: `apps/desktop/src-tauri/src/bin/media_conformance.rs`

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block:

```rust
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --bin media_conformance goertzel -- --nocapture`
Expected: FAIL — `goertzel` not found.

- [ ] **Step 3: Implement `goertzel`**

Add near the top of `media_conformance.rs` (after the imports):

```rust
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
    // Amplitude of a real sine of unit amplitude comes out ~1.0 with this scale.
    power.max(0.0).sqrt() * 2.0 / (n as f64)
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --bin media_conformance goertzel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/bin/media_conformance.rs
git commit -m "feat(test): goertzel magnitude for media_conformance audio mode"
```

---

## Task 3: `extract_audio_pcm` (ffmpeg → mono f32 PCM)

**Files:**
- Modify: `apps/desktop/src-tauri/src/bin/media_conformance.rs`

- [ ] **Step 1: Implement `extract_audio_pcm`**

Mirror `extract_frame_png`'s ffmpeg-shelling style. Add:

```rust
const AUDIO_SAMPLE_RATE: f64 = 48000.0;

/// Decode `mp4`'s audio to mono f32 PCM at 48 kHz via ffmpeg (edit list
/// applied, so AAC priming is compensated at the decoder). Returns the raw
/// samples in [-1, 1].
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
    let bytes = out.stdout;
    let mut pcm = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        pcm.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    if pcm.is_empty() {
        anyhow::bail!("no audio samples decoded from {}", mp4.display());
    }
    Ok(pcm)
}
```

- [ ] **Step 2: Build to confirm it compiles**

Run: `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --bin media_conformance`
Expected: compiles (a `dead_code` warning on the not-yet-called fn is fine until Task 5).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/bin/media_conformance.rs
git commit -m "feat(test): extract_audio_pcm for media_conformance audio mode"
```

---

## Task 4: `analyze_audio` (alignment / drift / fidelity) + `AudioReport`

**Files:**
- Modify: `apps/desktop/src-tauri/src/bin/media_conformance.rs`

- [ ] **Step 1: Write the failing test**

```rust
    /// Build PCM = `secs` one-second tones at the expected stepped freqs,
    /// optionally shifting every sample by `offset_samples` (sync offset).
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
        // Drop second 5 by overwriting it with second 6's tone (reorder/drop).
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
```

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --bin media_conformance analyze_audio`
Expected: FAIL — `analyze_audio` / `audio_expected_freq` / `AudioReport` not defined.

- [ ] **Step 3: Implement the analysis**

Add the constants, the report structs, and `analyze_audio`:

```rust
const AUDIO_BASE_HZ: f64 = 400.0;
const AUDIO_STEP_HZ: f64 = 120.0;
/// Pass thresholds. Drift is strict (≤ ~1 frame over the clip); the absolute
/// offset is loose (AAC priming is a constant lag, not drift); the SNR floor is
/// re-calibrated after the first real run (Task 8).
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

    // Per-second alignment + SNR: measure the tone over the interior 0.4..0.6s
    // of each second (away from the boundary clicks).
    let mut samples = Vec::with_capacity(secs);
    for s in 0..secs {
        let lo = ((s as f64 + 0.4) * sr) as usize;
        let hi = (((s as f64 + 0.6) * sr) as usize).min(pcm.len());
        let win = if lo < hi { &pcm[lo..hi] } else { &pcm[0..0] };
        let mags: Vec<f64> = cands.iter().map(|&f| goertzel(win, f, sr)).collect();
        let (best_i, &best) = mags
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .unwrap_or((s, &0.0));
        // SNR: dominant vs the strongest competing candidate.
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

    // Drift: find each second boundary (the time the dominant candidate switches
    // from s-1 to s) by a fine forward scan, then least-squares fit time vs s.
    let (slope, offset_s) = fit_boundaries(pcm, &cands, sr);
    let drift_slope = slope;
    let offset_ms = offset_s * 1000.0;

    let pass = !samples.is_empty()
        && samples.iter().all(|x| x.pass)
        && (drift_slope - 1.0).abs() <= AUDIO_DRIFT_SLOPE_TOL
        && offset_ms.abs() <= AUDIO_OFFSET_TOL_MS;

    AudioReport { duration_s, seconds: secs, drift_slope, offset_ms, samples, pass }
}

/// Scan windows (100 ms, 25 ms hop); the dominant candidate per window gives a
/// step function. Boundary k = first window where dominant becomes k. Fit
/// boundary-time vs k → (slope, offset_seconds). Returns (1.0, 0.0) if too few.
fn fit_boundaries(pcm: &[f32], cands: &[f64], sr: f64) -> (f64, f64) {
    let win = (0.1 * sr) as usize;
    let hop = (0.025 * sr) as usize;
    if cands.len() < 2 || pcm.len() < win {
        return (1.0, 0.0);
    }
    let mut prev_dom: Option<usize> = None;
    let mut xs: Vec<f64> = Vec::new(); // k
    let mut ys: Vec<f64> = Vec::new(); // boundary time (s)
    let mut i = 0;
    while i + win <= pcm.len() {
        let w = &pcm[i..i + win];
        let dom = cands
            .iter()
            .enumerate()
            .map(|(j, &f)| (j, goertzel(w, f, sr)))
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
            .map(|(j, _)| j)
            .unwrap_or(0);
        if let Some(p) = prev_dom {
            if dom == p + 1 {
                // boundary into second `dom` at the window's center time.
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
    // least squares y = slope*x + offset
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
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --bin media_conformance analyze_audio`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/bin/media_conformance.rs
git commit -m "feat(test): analyze_audio (alignment + drift + SNR) for media_conformance"
```

---

## Task 5: `main()` `--audio` branch + CLI + exit codes

**Files:**
- Modify: `apps/desktop/src-tauri/src/bin/media_conformance.rs` (the `main` fn arg loop + dispatch)

- [ ] **Step 1: Add `--audio` parsing + dispatch**

In `main`, add an `audio` bool alongside the other parsed args:

```rust
    let mut audio = false;
```
Add a match arm in the arg loop (next to `--window` etc.):
```rust
            "--audio" => audio = true,
```
Replace the final `match analyze(...)` dispatch with an audio branch first:

```rust
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
    match analyze(Path::new(&output), Path::new(&source), &samples, window, ssim_min) {
        // ... unchanged video branch ...
```

(`--source` is accepted but unused in audio mode — the markers are self-describing via the known formula, which MUST match `generate.go`.)

- [ ] **Step 2: Build + smoke against the fixture**

Run:
```bash
cargo run --manifest-path apps/desktop/src-tauri/Cargo.toml --bin media_conformance --quiet -- \
  --audio --output "C:/Users/jonny/Desktop/learning/testfile/test_1080p_30fps_audio.mp4" \
  --source "C:/Users/jonny/Desktop/learning/testfile/test_1080p_30fps_audio.mp4"
```
Expected: a JSON `AudioReport` with `seconds: 10`, all samples `aligned: true`, `drift_slope` ~1.0, `pass: true` (the fixture analyzed against itself is a clean signal).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/bin/media_conformance.rs
git commit -m "feat(test): media_conformance --audio mode (CLI + report + exit codes)"
```

---

## Task 6: `analyze.mjs` audio passthrough

**Files:**
- Modify: `apps/desktop/e2e/lib/analyze.mjs`

- [ ] **Step 1: Add the `audio` option**

Change the signature + argv:

```javascript
export function analyze({ output, source, samples, ssimMin, audio }) {
  const args = [
    "run", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml",
    "--bin", "media_conformance", "--quiet", "--",
    "--output", output, "--source", source, "--samples", samples.join(","),
  ];
  if (ssimMin != null) args.push("--ssim-min", String(ssimMin));
  if (audio) args.push("--audio");
  const r = spawnSync("cargo", args, { cwd: REPO, encoding: "utf8" });
  // ... unchanged ...
```

(In audio mode `--samples` is ignored by the bin; pass `[0]` from the spec to satisfy the arg.)

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/e2e/lib/analyze.mjs
git commit -m "test(e2e): analyze.mjs --audio passthrough"
```

---

## Task 7: `audio_conformance.e2e.js` spec

**Files:**
- Create: `apps/desktop/e2e/specs/audio_conformance.e2e.js`

- [ ] **Step 1: Write the spec (ships `describe.skip`)**

```javascript
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { analyze } from "../lib/analyze.mjs";

const MEDIA_DIR =
  process.env.WEFTCUT_TEST_MEDIA || "C:/Users/jonny/Desktop/learning/testfile";
const SOURCE = path.resolve(MEDIA_DIR, "test_1080p_30fps_audio.mp4");
const OUTPUT = path.resolve(os.tmpdir(), "weftcut-e2e-audio-out.mp4");
const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-audio-proj");

// Audio conformance: import + 1:1-place a clip whose audio is a per-second
// frequency-stepped tone (F_k = 400 + 120k Hz), export (video=WebCodecs,
// audio=Rust ffmpeg->AAC, then mux), and verify per-second alignment + A/V sync
// drift + tone fidelity via `media_conformance --audio`. Independent of the
// video axis (its own fixture + spec). describe.skip until first-run validated.
describe.skip("audio import -> export conformance (real WebView2)", function () {
  before(function () {
    if (!existsSync(SOURCE)) {
      console.warn(`[e2e] SKIP: audio source not found at ${SOURCE}`);
      this.skip();
    }
    mkdirSync(PROJECT_PARENT, { recursive: true });
    rmSync(OUTPUT, { force: true });
  });

  it("exports audio that stays aligned + synced + faithful", async () => {
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => typeof window.__weftcutTest?.newProjectAndEnter === "function",
        )) === true,
      { timeout: 30000, timeoutMsg: "newProjectAndEnter never mounted" },
    );
    const r1 = await browser.executeAsync((parent, done) => {
      window.__weftcutTest
        .newProjectAndEnter({
          parentFolder: parent,
          name: "e2e-audio-" + Date.now(),
          canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
        })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, PROJECT_PARENT);
    if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);

    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => typeof window.__weftcutTest?.exportClip === "function",
        )) === true,
      { timeout: 30000, timeoutMsg: "exportClip never mounted" },
    );

    await browser.execute(
      (media, output) => {
        window.__e2eExportDone = null;
        window.__weftcutTest
          .exportClip({ mediaAbsPath: media, outputAbsPath: output })
          .then(() => { window.__e2eExportDone = { ok: true }; })
          .catch((e) => { window.__e2eExportDone = { ok: false, error: String(e) }; });
      },
      SOURCE,
      OUTPUT,
    );

    let lastFrame = -1;
    let settled = null;
    try {
      await browser.waitUntil(
        async () => {
          const snap = await browser.execute(() => {
            const st = window.__weftcutExportState;
            return { done: window.__e2eExportDone, kind: st?.kind ?? null, frame: st?.progress?.frame ?? null };
          });
          if (snap.frame != null && snap.frame !== lastFrame) {
            lastFrame = snap.frame;
            console.log(`[e2e] audio export ${snap.kind} frame=${snap.frame}`);
          }
          if (snap.done) { settled = snap.done; return true; }
          return false;
        },
        { timeout: 170000, interval: 1000 },
      );
    } catch (e) {
      throw new Error(`export never settled (last frame=${lastFrame}): ${e.message}`);
    }
    if (!settled.ok) throw new Error("exportClip failed: " + settled.error);

    const report = analyze({ output: OUTPUT, source: SOURCE, samples: [0], audio: true });
    console.log("[e2e] audio report:", JSON.stringify(report));

    const misaligned = report.samples.filter((s) => !s.aligned);
    if (misaligned.length > 0) {
      throw new Error("audio seconds misaligned: " +
        JSON.stringify(misaligned.map((s) => ({ second: s.second, detected: s.detected_freq }))));
    }
    expect(Math.abs(report.drift_slope - 1)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(report.offset_ms)).toBeLessThanOrEqual(66);
    expect(report.pass).toBe(true);
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/e2e/specs/audio_conformance.e2e.js
git commit -m "test(e2e): audio conformance spec (skipped pending first-run validation)"
```

---

## Task 8: Run, calibrate the SNR floor, un-skip, validate green

**Files:**
- Modify: `apps/desktop/e2e/specs/audio_conformance.e2e.js` (un-skip)
- Possibly modify: `apps/desktop/src-tauri/src/bin/media_conformance.rs` (`AUDIO_SNR_FLOOR_DB` if the real export's SNR lands below 15 dB)

- [ ] **Step 1: Un-skip + run the full e2e**

Change `describe.skip` → `describe` in `audio_conformance.e2e.js`. Run:
```bash
npm --prefix "C:/Users/jonny/Desktop/learning/videtor/apps/desktop/e2e" test
```
Expected: 3 spec files run (launch, conformance video, conformance audio). Read the `[e2e] audio report:` line.

- [ ] **Step 2: Inspect + calibrate**

From the logged report: confirm every second `aligned: true`, `drift_slope` ~1.0, `|offset_ms|` ≤ 66. Note the real per-second `snr_db`. If a faithful export's SNR is below 15 dB (AAC compresses the tone + adds noise), lower `AUDIO_SNR_FLOOR_DB` to a value that passes a faithful export with margin while still catching gross corruption — document the chosen value like the video axis's 0.80 SSIM floor. Rebuild + re-run if changed.

- [ ] **Step 3: Confirm green**

Run the e2e again. Expected: `Spec Files: 3 passed`. If alignment fails or drift is large, that is a REAL export A/V-sync finding — treat it with systematic-debugging, do not loosen the gate to hide it.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/specs/audio_conformance.e2e.js apps/desktop/src-tauri/src/bin/media_conformance.rs
git commit -m "test(e2e): activate audio conformance gate (align + drift + SNR floor)"
```

---

## Self-Review

- **Spec coverage:** fixture markers (Task 1), Goertzel (Task 2), PCM extract (Task 3), alignment+drift+fidelity+report (Task 4), CLI/exit codes (Task 5), analyze.mjs (Task 6), e2e spec (Task 7), validate+calibrate+un-skip (Task 8), A/V-sync-via-absolute-grid (Task 4 drift + the video axis, no explicit cross-check per spec). All spec sections covered.
- **Type consistency:** `goertzel(&[f32], f64, f64) -> f64`, `audio_expected_freq(usize) -> f64`, `analyze_audio(&[f32]) -> AudioReport`, `AudioReport { duration_s, seconds, drift_slope, offset_ms, samples, pass }`, `AudioSample { second, expected_freq, detected_freq, aligned, snr_db, pass }` — used consistently across tasks 2/4/5 and the spec.
- **Shared constant:** `BASE=400/STEP=120/SR=48000`, duration 10 — must match between `generate.go` (Task 1) and `media_conformance.rs` (Task 4). Flagged in the header.
- **Placeholders:** none — every code step has complete code; the SNR floor is an explicit initial-and-calibrated value (Task 8).
