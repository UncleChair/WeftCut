# Color-conformance axis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add color-fidelity testing to the media-conformance harness: Axis A measures 8-bit color round-trip through the real-WebView2 export across {601,709}×{ltd,full}; Axis B measures the Rust `libx264 -crf 18` proxy's fidelity on 10-bit gradients.

**Architecture:** Two decoupled axes sharing one analyzer binary (`media_conformance`) and one fixture generator (`generate.go`). Probe-first: Stage 0 tasks pin the real tags/matrix/dither/scaling before any threshold is set; the gate (Stage 2) compares against a committed `color_baseline.json` recorded in Stage 1, not against hardcoded numbers. Axis A (Tasks 1–7) is independently shippable; Axis B (Tasks 8–12) builds on the shared 16-bit analyzer additions.

**Tech Stack:** Go (`image`/`image/draw`/`image/png` + shelling ffmpeg) for fixtures; Rust (`image` 0.25 png-only, `ffmpeg_sidecar`, `anyhow`, `serde`/`serde_json`) for the analyzer; Node + WebdriverIO (`browser.execute` against `window.__weftcutTest`) for the producer; ffmpeg/ffprobe on PATH.

**Spec:** `docs/superpowers/specs/2026-06-03-color-conformance-axis-design.md`

---

## Reference facts (verified — quote these, don't re-derive)

- **Proxy ffmpeg args** (`apps/desktop/src-tauri/src/jobs/proxy.rs:117-149`), verbatim for Axis B Stage 0:
  `-vf scale=-2:'min(ih,{PROXY_HEIGHT_CAP})' -c:v libx264 -preset fast -crf 18 -profile:v high -g {GOP} -keyint_min {GOP} -bf 0 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart -f mp4`. No color tags, no explicit dither. `PROXY_HEIGHT_CAP`/`PROXY_GOP_FRAMES` are consts in proxy.rs.
- **e2e export hook** (`apps/desktop/e2e/specs/conformance.e2e.js`): `window.__weftcutTest.newProjectAndEnter({parentFolder, name, canvas:{width,height,fpsNum,fpsDen}})` then `window.__weftcutTest.exportClip({mediaAbsPath, outputAbsPath, settings})`. Export is fire-and-forget; poll `window.__e2eExportDone` and `window.__weftcutExportState.progress.frame`.
- **Analyzer primitives** (`apps/desktop/src-tauri/src/bin/media_conformance.rs`): `extract_frame_png(mp4, n) -> Vec<u8>` (PNG bytes via `select=eq(n,N)`), `decode_rgb8(png) -> image::RgbImage`. `image-compare` is **Rgb8-only** — the 16-bit path cannot use it.
- **analyze.mjs** (`apps/desktop/e2e/lib/analyze.mjs`): `spawnSync("cargo", ["run","--manifest-path","apps/desktop/src-tauri/Cargo.toml","--bin","media_conformance","--quiet","--", ...])`, parses stdout JSON.
- **ffmpeg matrix names:** 709 → `bt709`; 601 → `smpte170m` (matches `colorSpaceDefault.ts`'s SD string). Range: limited → `tv`, full → `pc`.

---

## Task 1: Go color-chart drawer + manifest

**Files:**
- Modify: `apps/desktop/e2e/fixtures/generate.go` (add `--color` flag + chart path)
- Create (generated, gitignored): `<mediaDir>/color_chart.png`, `<mediaDir>/color_manifest.json`

- [ ] **Step 1: Add the `--color` flag and chart builder to `generate.go`**

Add to the `flag` block near the top of `main`:

```go
	colorEnc := flag.String("color", "", "color chart encoding: 709ltd|601ltd|709full|601full (draws chart + manifest, ignores --fps content)")
```

Add this function (single source of truth for the patch grid — authored RGB is ground truth):

```go
type patch struct {
	ID  string `json:"id"`
	X   int    `json:"x"`
	Y   int    `json:"y"`
	W   int    `json:"w"`
	H   int    `json:"h"`
	RGB [3]int `json:"rgb"`
}

type manifest struct {
	Width   int     `json:"width"`
	Height  int     `json:"height"`
	Patches []patch `json:"patches"`
}

// 5x4 grid of large flat patches with deliberate diagnostic values.
func colorPatches(width, height int) []patch {
	cols, rows := 5, 4
	cw, ch := width/cols, height/rows
	// row-major; 20 cells. Values chosen to exercise primaries, secondaries,
	// limited-range endpoints (near-black/near-white), and mid-grays.
	vals := [][3]int{
		{255, 0, 0}, {0, 255, 0}, {0, 0, 255}, {0, 255, 255}, {255, 0, 255},
		{255, 255, 0}, {255, 255, 255}, {0, 0, 0}, {16, 16, 16}, {235, 235, 235},
		{128, 128, 128}, {64, 64, 64}, {192, 192, 192}, {255, 128, 0}, {128, 0, 255},
		{200, 150, 120}, {30, 60, 90}, {120, 200, 60}, {245, 245, 245}, {10, 10, 10},
	}
	ids := []string{
		"red", "green", "blue", "cyan", "magenta",
		"yellow", "white", "black", "near_black_16", "near_white_235",
		"gray_128", "gray_64", "gray_192", "orange", "violet",
		"skin", "navy", "lime", "near_white_245", "near_black_10",
	}
	out := make([]patch, 0, cols*rows)
	for i := 0; i < cols*rows; i++ {
		r, c := i/cols, i%cols
		out = append(out, patch{
			ID: ids[i], X: c * cw, Y: r * ch, W: cw, H: ch, RGB: vals[i],
		})
	}
	return out
}

func writeColorChart(width, height int) (string, error) {
	patches := colorPatches(width, height)
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for _, p := range patches {
		col := color.RGBA{uint8(p.RGB[0]), uint8(p.RGB[1]), uint8(p.RGB[2]), 255}
		draw.Draw(img, image.Rect(p.X, p.Y, p.X+p.W, p.Y+p.H), &image.Uniform{col}, image.Point{}, draw.Src)
	}
	pf, err := os.Create("color_chart.png")
	if err != nil {
		return "", err
	}
	defer pf.Close()
	if err := png.Encode(pf, img); err != nil {
		return "", err
	}
	mf, err := os.Create("color_manifest.json")
	if err != nil {
		return "", err
	}
	defer mf.Close()
	enc := json.NewEncoder(mf)
	enc.SetIndent("", "  ")
	if err := enc.Encode(manifest{Width: width, Height: height, Patches: patches}); err != nil {
		return "", err
	}
	return "color_chart.png", nil
}
```

Add the imports `"encoding/json"`, `"image"`, `"image/color"`, `"image/draw"`, `"image/png"` to the import block.

- [ ] **Step 2: Branch `main` into the color path before the `--fps` check**

Insert at the top of `main` after `flag.Parse()`:

```go
	if *colorEnc != "" {
		const width, height, duration = 1920, 1080, 1
		var matrix, prim, trc, rng, outRange string
		switch *colorEnc {
		case "709ltd":
			matrix, prim, trc, rng, outRange = "bt709", "bt709", "bt709", "tv", "tv"
		case "601ltd":
			matrix, prim, trc, rng, outRange = "smpte170m", "smpte170m", "smpte170m", "tv", "tv"
		case "709full":
			matrix, prim, trc, rng, outRange = "bt709", "bt709", "bt709", "pc", "pc"
		case "601full":
			matrix, prim, trc, rng, outRange = "smpte170m", "smpte170m", "smpte170m", "pc", "pc"
		default:
			log.Fatalf("unknown --color %q (709ltd|601ltd|709full|601full)", *colorEnc)
		}
		chart, err := writeColorChart(width, height)
		if err != nil {
			log.Fatalf("chart: %v", err)
		}
		out := fmt.Sprintf("test_%dp_color_%s.mp4", height, *colorEnc)
		vf := fmt.Sprintf("format=rgb24,scale=out_color_matrix=%s:out_range=%s,format=yuv420p", matrix, outRange)
		args := []string{
			"-y", "-loop", "1", "-i", chart, "-t", fmt.Sprintf("%d", duration), "-r", "30",
			"-vf", vf, "-c:v", "libx264", "-crf", "18", "-preset", "medium",
			"-colorspace", matrix, "-color_primaries", prim, "-color_trc", trc, "-color_range", rng,
			"-an", out,
		}
		fmt.Printf("Generating %s (%s)\n", out, *colorEnc)
		cmd := exec.Command("ffmpeg", args...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			log.Fatalf("ffmpeg failed: %v", err)
		}
		fmt.Printf("Done: %s\n", out)
		return
	}
```

- [ ] **Step 3: Generate the four clips + manifest manually to verify**

Run from a scratch media dir (`go` + `ffmpeg` on PATH):

```bash
cd "$(mktemp -d)" && for e in 709ltd 601ltd 709full 601full; do \
  go run "C:/Users/iClass/Desktop/learning/videtor/apps/desktop/e2e/fixtures/generate.go" --color $e; done && ls
```

Expected: `color_chart.png`, `color_manifest.json`, and `test_1080p_color_{709ltd,601ltd,709full,601full}.mp4` all present.

- [ ] **Step 4: Verify tags landed**

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=pix_fmt,color_space,color_range -of default test_1080p_color_601ltd.mp4
```

Expected: `pix_fmt=yuv420p`, `color_space=smpte170m`, `color_range=tv`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/fixtures/generate.go
git commit -m "feat(e2e): generate.go --color flat-patch chart + manifest (axis A fixtures)"
```

---

## Task 2: Wire color fixtures into the generator matrix

**Files:**
- Modify: `apps/desktop/e2e/fixtures/generate-fixtures.mjs`

- [ ] **Step 1: Extend `MATRIX` and `outputName` for color entries**

Add to the `MATRIX` array:

```js
  // color charts (flat patches, tagged) — axis A fixtures
  { color: "709ltd" },
  { color: "601ltd" },
  { color: "709full" },
  { color: "601full" },
```

Update `outputName` to handle the color entry (add as the first branch):

```js
export function outputName({ fps, format, audio, color }) {
  if (color) return `test_${WIDTH_HEIGHT}p_color_${color}.mp4`;
  if (format === "prores") return `test_${WIDTH_HEIGHT}p_${fps}fps_prores.mov`;
  if (audio) return `test_${WIDTH_HEIGHT}p_${fps}fps_audio.${format}`;
  return `test_${WIDTH_HEIGHT}p_${fps}fps.${format}`;
}
```

- [ ] **Step 2: Pass `--color` in `ensureFixtures`**

In the loop body of `ensureFixtures`, replace the args construction so a color entry shells the color flag:

```js
    const args = entry.color
      ? ["run", GENERATOR, "--color", entry.color]
      : ["run", GENERATOR, "--fps", String(entry.fps), "--format", entry.format];
    if (entry.audio) args.push("--audio");
```

- [ ] **Step 3: Run the generator end-to-end**

```bash
cd apps/desktop/e2e && node fixtures/generate-fixtures.mjs
```

Expected: the four `*_color_*.mp4` plus `color_manifest.json` appear in `fixtures/media/` (existing clips skipped).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/fixtures/generate-fixtures.mjs
git commit -m "feat(e2e): add color charts to the fixture matrix"
```

---

## Task 3: Analyzer — manifest parsing + per-channel error metric (pure, TDD)

**Files:**
- Modify: `apps/desktop/src-tauri/src/bin/media_conformance.rs`

- [ ] **Step 1: Write failing tests for the metric + manifest**

Add to the `#[cfg(test)] mod tests`:

```rust
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --bin media_conformance channel_error`
Expected: FAIL — `channel_error`/`Manifest`/`Rgb16` not found.

- [ ] **Step 3: Implement the metric, manifest types, and sampling**

Add near the top (after the existing `use image::ImageReader;`):

```rust
use image::Rgb16;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Patch {
    id: String,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    rgb: [u16; 3],
}

#[derive(Debug, Deserialize)]
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
/// (values are stored left-justified in u16, so we compare on the high byte for
/// 8-bit content and on the full range / 256 for 16-bit). Panics if lengths
/// differ — a sampling bug, not a regression.
fn channel_error(a: &[Rgb16], b: &[Rgb16]) -> ChannelError {
    assert_eq!(a.len(), b.len());
    let n = a.len().max(1) as f64;
    let mut sum = [0f64; 3];
    let mut max = [0u16; 3];
    for (pa, pb) in a.iter().zip(b) {
        for c in 0..3 {
            // /256 maps the u16 storage back to 8-bit code units; for genuine
            // 16-bit content the caller scales separately (see depth16 path).
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

/// Average the center inset (40%) of a patch rect from a 16-bit image, returning
/// one representative Rgb16. Center sampling avoids 4:2:0 edge bleed.
fn sample_patch(img: &image::ImageBuffer<Rgb16, Vec<u16>>, p: &Patch) -> Rgb16 {
    let inset_w = p.w / 5; // 20% margin each side -> central 60%; tune to 40% by p.w*3/10
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
```

Add to `Cargo.toml` `image` features if needed: 16-bit PNG decoding is covered by the existing `png` feature — no change. Confirm `serde` has `derive` (the file already serializes reports, so it does).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --bin media_conformance channel_error manifest`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/bin/media_conformance.rs
git commit -m "feat(conformance): per-channel color error metric + manifest sampling"
```

---

## Task 4: Analyzer — forced-matrix 8-bit extraction + `--color` mode

**Files:**
- Modify: `apps/desktop/src-tauri/src/bin/media_conformance.rs`

- [ ] **Step 1: Add a forced-matrix 16-bit-capable extractor**

Add (parameterized so Task 8 reuses it for `rgb48`):

```rust
/// Decode frame `n` of `mp4` to a PNG, optionally forcing the input YUV→RGB
/// matrix/range (ignoring stream tags) and choosing 8- or 16-bit RGB. Pinning
/// the matrix at decode is what makes color comparison valid — see the spec.
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
        anyhow::bail!("ffmpeg failed for frame {n}: {}", String::from_utf8_lossy(&status.stderr).trim());
    }
    let bytes = std::fs::read(&tmp).context("read png")?;
    let _ = std::fs::remove_file(&tmp);
    if bytes.is_empty() {
        anyhow::bail!("ffmpeg wrote 0 bytes for frame {n}");
    }
    Ok(bytes)
}

fn decode_rgb16(png: &[u8]) -> Result<image::ImageBuffer<Rgb16, Vec<u16>>> {
    Ok(ImageReader::new(Cursor::new(png)).with_guessed_format().context("guess png")?.decode().context("decode png")?.to_rgb16())
}
```

- [ ] **Step 2: Add the color report structs + analyze_color**

```rust
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
    /// worst app_error.max across all patches/channels
    worst_app_max: u16,
}

fn analyze_color(
    output: &Path,
    source: &Path,
    manifest: &Manifest,
    sample: u64,
    in_matrix: &str,
    in_range: &str,
) -> Result<ColorReport> {
    let out_img = decode_rgb16(&extract_frame_png_ex(output, sample, Some(in_matrix), Some(in_range), false)?)?;
    let src_img = decode_rgb16(&extract_frame_png_ex(source, sample, Some(in_matrix), Some(in_range), false)?)?;
    let mut patches = Vec::with_capacity(manifest.patches.len());
    let mut worst = 0u16;
    for p in &manifest.patches {
        let o = sample_patch(&out_img, p);
        let s = sample_patch(&src_img, p);
        // *257 matches image::to_rgb16's 8->16 byte-replication, so authored
        // lines up with how the decoded output/source are upscaled (else
        // total_error carries a sub-1-code bias). The gate (app_error) compares
        // output vs source — both via to_rgb16 — so it is unaffected.
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
    let _ = (manifest.width, manifest.height);
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
```

- [ ] **Step 3: Wire CLI flags in `main`**

Add to the arg-parse loop (`while let Some(a) = it.next()`):

```rust
            "--color" => color = true,
            "--manifest" => manifest_path = it.next().cloned(),
            "--in-matrix" => in_matrix = it.next().cloned(),
            "--in-range" => in_range = it.next().cloned(),
            "--sample" => sample = it.next().and_then(|s| s.parse().ok()).unwrap_or(10),
```

Declare alongside the other `let mut` vars: `let mut color = false;`, `let mut manifest_path: Option<String> = None;`, `let mut in_matrix: Option<String> = None;`, `let mut in_range: Option<String> = None;`, `let mut sample: u64 = 10;`.

Add this dispatch block before the existing `if audio {` block:

```rust
    if color {
        let (Some(mp), Some(im), Some(ir)) = (manifest_path, in_matrix, in_range) else {
            eprintln!("media_conformance --color requires --manifest, --in-matrix, --in-range");
            return std::process::ExitCode::from(2);
        };
        let manifest: Manifest = match std::fs::read_to_string(&mp).map_err(anyhow::Error::from).and_then(|s| Ok(serde_json::from_str(&s)?)) {
            Ok(m) => m,
            Err(e) => { eprintln!("media_conformance: manifest: {e:#}"); return std::process::ExitCode::from(3); }
        };
        match analyze_color(Path::new(&output), Path::new(&source), &manifest, sample, &im, &ir) {
            Ok(r) => { println!("{}", serde_json::to_string_pretty(&r).unwrap()); std::process::ExitCode::SUCCESS }
            Err(e) => { eprintln!("media_conformance: {e:#}"); std::process::ExitCode::from(3) }
        }
    } else if audio {
```

(Change the existing `if audio {` to `} else if audio {` and keep the rest; ensure the final `}` balance — the existing samples-required block becomes the trailing `else`.)

- [ ] **Step 4: Build + smoke against a generated clip**

Run (after `node fixtures/generate-fixtures.mjs` from Task 2):

```bash
cargo run --manifest-path apps/desktop/src-tauri/Cargo.toml --bin media_conformance --quiet -- \
  --color --output apps/desktop/e2e/fixtures/media/test_1080p_color_709ltd.mp4 \
  --source apps/desktop/e2e/fixtures/media/test_1080p_color_709ltd.mp4 \
  --manifest apps/desktop/e2e/fixtures/media/color_manifest.json --in-matrix bt709 --in-range tv --sample 10
```

Expected: JSON with `worst_app_max: 0` (self-compare) and per-patch `app_error.max == [0,0,0]`. `total_error` may be small/nonzero (source encode loss vs authored — that's the diagnostic).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/bin/media_conformance.rs
git commit -m "feat(conformance): --color mode with forced-matrix decode + app-only/authored references"
```

---

## Task 5: analyze.mjs color wrapper

**Files:**
- Modify: `apps/desktop/e2e/lib/analyze.mjs`

- [ ] **Step 1: Add an `analyzeColor` export**

```js
export function analyzeColor({ output, source, manifest, inMatrix, inRange, sample }) {
  const args = [
    "run", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml",
    "--bin", "media_conformance", "--quiet", "--",
    "--color", "--output", output, "--source", source,
    "--manifest", manifest, "--in-matrix", inMatrix, "--in-range", inRange,
    "--sample", String(sample ?? 10),
  ];
  const r = spawnSync("cargo", args, { cwd: REPO, encoding: "utf8" });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`media_conformance --color exit ${r.status}: ${r.stdout}\n${r.stderr}`);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/e2e/lib/analyze.mjs
git commit -m "feat(e2e): analyzeColor wrapper for media_conformance --color"
```

---

## Task 6: Axis A Stage 0 probe script (pins the export's real matrix/tags)

**Files:**
- Create: `apps/desktop/e2e/scripts/color-probe-export.mjs`

This script is run **once** after a real export of the `709ltd` chart exists at a known path (produced by Task 7's spec, or hand-produced). It ffprobes the output's tags and decodes it under all four (matrix,range) combos to reveal what the encoder actually did.

- [ ] **Step 1: Write the probe script**

```js
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeColor } from "../lib/analyze.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEDIA = process.env.WEFTCUT_TEST_MEDIA || path.resolve(HERE, "..", "fixtures", "media");
const MANIFEST = path.resolve(MEDIA, "color_manifest.json");
const SOURCE = path.resolve(MEDIA, "test_1080p_color_709ltd.mp4");
const OUTPUT = process.argv[2]; // path to a REAL exported 709ltd chart

if (!OUTPUT) { console.error("usage: node color-probe-export.mjs <exported.mp4>"); process.exit(2); }

const tags = spawnSync("ffprobe", [
  "-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=pix_fmt,color_space,color_transfer,color_primaries,color_range",
  "-of", "default", OUTPUT,
], { encoding: "utf8" });
console.log("=== OUTPUT TAGS ===\n" + tags.stdout);

console.log("=== TOTAL ERROR vs authored, per decode matrix (lowest wins = encoder's real matrix) ===");
for (const [im, ir] of [["bt709", "tv"], ["smpte170m", "tv"], ["bt709", "pc"], ["smpte170m", "pc"]]) {
  const r = analyzeColor({ output: OUTPUT, source: SOURCE, manifest: MANIFEST, inMatrix: im, inRange: ir, sample: 10 });
  const worstTotal = Math.max(...r.patches.flatMap((p) => p.total_error.max));
  console.log(`${im}/${ir}: worst_total_max=${worstTotal}  worst_app_max=${r.worst_app_max}`);
}
```

- [ ] **Step 2: Document the run in the script header**

Add a top comment: the script is a one-shot diagnostic, not a gate; its output decides whether Stage 2 gates as-is or requires an export-color-tag product fix. Record the findings in the spec's Decisions log.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/e2e/scripts/color-probe-export.mjs
git commit -m "feat(e2e): axis-A Stage 0 probe — ffprobe tags + per-matrix decode diagnostic"
```

---

## Task 7: Axis A gate spec (`color_conformance.e2e.js`)

**Files:**
- Create: `apps/desktop/e2e/specs/color_conformance.e2e.js`
- Create (after Stage 1 records numbers): `apps/desktop/e2e/fixtures/color_baseline.json`

- [ ] **Step 1: Write the spec iterating the 4 encodings**

Model on `conformance.e2e.js` (same hook + fire-and-forget poll). Per encoding, export 1:1, then `analyzeColor` and assert `worst_app_max` ≤ the baseline for that encoding + a tolerance. Decode matrix/range per encoding map.

```js
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { analyzeColor } from "../lib/analyze.mjs";

const MEDIA = process.env.WEFTCUT_TEST_MEDIA || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "media");
const MANIFEST = path.resolve(MEDIA, "color_manifest.json");
const BASELINE = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "color_baseline.json"), "utf8"));
const PROJ = path.resolve(os.tmpdir(), "weftcut-e2e-color-proj");
const DECODE = { "709ltd": ["bt709", "tv"], "601ltd": ["smpte170m", "tv"], "709full": ["bt709", "pc"], "601full": ["smpte170m", "pc"] };

describe("color round-trip conformance (real WebView2)", function () {
  before(function () { mkdirSync(PROJ, { recursive: true }); });

  for (const enc of Object.keys(DECODE)) {
    const source = path.resolve(MEDIA, `test_1080p_color_${enc}.mp4`);
    const output = path.resolve(os.tmpdir(), `weftcut-e2e-color-${enc}.mp4`);
    it(`${enc} round-trips within baseline`, async function () {
      if (!existsSync(source)) { console.warn(`[e2e] SKIP: ${source}`); this.skip(); }
      rmSync(output, { force: true });
      await browser.waitUntil(async () => (await browser.execute(() => typeof window.__weftcutTest?.newProjectAndEnter === "function")) === true, { timeout: 30000 });
      const r1 = await browser.executeAsync((parent, done) => {
        window.__weftcutTest.newProjectAndEnter({ parentFolder: parent, name: "e2e-color-" + Date.now(), canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } }).then(() => done({ ok: true })).catch((e) => done({ ok: false, error: String(e) }));
      }, PROJ);
      if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);
      await browser.waitUntil(async () => (await browser.execute(() => typeof window.__weftcutTest?.exportClip === "function")) === true, { timeout: 30000 });
      await browser.execute((media, out) => {
        window.__e2eExportDone = null;
        window.__weftcutTest.exportClip({ mediaAbsPath: media, outputAbsPath: out }).then(() => { window.__e2eExportDone = { ok: true }; }).catch((e) => { window.__e2eExportDone = { ok: false, error: String(e) }; });
      }, source, output);
      let settled = null;
      await browser.waitUntil(async () => { const d = await browser.execute(() => window.__e2eExportDone); if (d) { settled = d; return true; } return false; }, { timeout: 170000, interval: 1000 });
      if (!settled.ok) throw new Error("exportClip failed: " + settled.error);

      const [im, ir] = DECODE[enc];
      const report = analyzeColor({ output, source, manifest: MANIFEST, inMatrix: im, inRange: ir, sample: 10 });
      console.log(`[e2e] color ${enc}:`, JSON.stringify({ worst_app_max: report.worst_app_max }));
      const limit = BASELINE[enc].worst_app_max + BASELINE.tolerance;
      const offenders = report.patches.filter((p) => Math.max(...p.app_error.max) > limit);
      if (offenders.length) throw new Error(`${enc} patches exceed ${limit}: ` + JSON.stringify(offenders.map((p) => ({ id: p.id, max: p.app_error.max }))));
      expect(report.worst_app_max).toBeLessThanOrEqual(limit);
    });
  }
});
```

- [ ] **Step 2 (Stage 1): Record the baseline**

After Task 6's probe confirms the decode matrix, run the suite once in "record" mode (run the spec, read each `worst_app_max` from the logged report) and write `apps/desktop/e2e/fixtures/color_baseline.json`:

```json
{
  "tolerance": 2,
  "709ltd": { "worst_app_max": 0 },
  "601ltd": { "worst_app_max": 0 },
  "709full": { "worst_app_max": 0 },
  "601full": { "worst_app_max": 0 }
}
```

Replace each `worst_app_max` with the **measured** value from the first green run (the locked "standard line"). If Task 6 found the export is **untagged**, stop and surface the Stage 2 decision (gate as-is on the measured numbers, or add export color-tagging first) before committing the baseline.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/e2e/specs/color_conformance.e2e.js apps/desktop/e2e/fixtures/color_baseline.json
git commit -m "feat(e2e): axis-A color round-trip gate against recorded per-encoding baseline"
```

---

## Task 8: Analyzer — 16-bit banding/plateau metric (pure, TDD)

**Files:**
- Modify: `apps/desktop/src-tauri/src/bin/media_conformance.rs`

- [ ] **Step 1: Write failing tests for the banding metric**

```rust
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --bin media_conformance banding`
Expected: FAIL — `banding_stats` not found.

- [ ] **Step 3: Implement `banding_stats`**

```rust
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --bin media_conformance banding`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/bin/media_conformance.rs
git commit -m "feat(conformance): banding/plateau metric for gradient fidelity (axis B)"
```

---

## Task 9: generate.go `--gradient` mode (10-bit ramps)

**Files:**
- Modify: `apps/desktop/e2e/fixtures/generate.go`
- Modify: `apps/desktop/e2e/fixtures/generate-fixtures.mjs`

- [ ] **Step 1: Add `--gradient` to generate.go**

Add the flag: `gradient := flag.Bool("gradient", false, "emit a 10-bit BT.709 gradient ramp (HEVC Main10) for axis B")`.

Add a branch in `main` (after the `--color` branch):

```go
	if *gradient {
		const width, height, duration = 1920, 1080, 1
		out := fmt.Sprintf("test_%dp_gradient10.mp4", height)
		// Horizontal luma ramp 0..1023 across width, authored in 10-bit; tagged 709.
		// geq writes 10-bit values directly; format pipeline keeps it 10-bit.
		vf := "geq=lum='(X/(W-1))*1023':cb=512:cr=512,format=yuv420p10le,scale=out_color_matrix=bt709:out_range=tv"
		args := []string{
			"-y", "-f", "lavfi", "-i", fmt.Sprintf("nullsrc=size=%dx%d:rate=30:duration=%d", width, height, duration),
			"-vf", vf, "-c:v", "libx265", "-x265-params", "profile=main10", "-pix_fmt", "yuv420p10le",
			"-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
			"-tag:v", "hvc1", "-an", out,
		}
		fmt.Printf("Generating %s (10-bit HEVC Main10 ramp)\n", out)
		cmd := exec.Command("ffmpeg", args...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			log.Fatalf("ffmpeg failed: %v", err)
		}
		fmt.Printf("Done: %s\n", out)
		return
	}
```

- [ ] **Step 2: Add to the fixture matrix**

In `generate-fixtures.mjs`, add `{ gradient: true }` to `MATRIX`, handle in `outputName` (`if (gradient) return \`test_${WIDTH_HEIGHT}p_gradient10.mp4\`;`) and in `ensureFixtures` args (`entry.gradient ? ["run", GENERATOR, "--gradient"] : ...`).

- [ ] **Step 3: Generate + verify it's 10-bit**

```bash
cd apps/desktop/e2e && node fixtures/generate-fixtures.mjs && \
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,pix_fmt,color_space -of default fixtures/media/test_1080p_gradient10.mp4
```

Expected: `codec_name=hevc`, `pix_fmt=yuv420p10le`, `color_space=bt709`. If `libx265` is unavailable, the generator fails loudly — document the dependency.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/fixtures/generate.go apps/desktop/e2e/fixtures/generate-fixtures.mjs
git commit -m "feat(e2e): generate.go --gradient 10-bit HEVC Main10 ramp (axis B fixture)"
```

---

## Task 10: Axis B Stage 0 probe (proxy args verbatim + 10→16 scaling)

**Files:**
- Create: `apps/desktop/e2e/scripts/color-probe-proxy.mjs`
- Modify: `apps/desktop/src-tauri/src/bin/media_conformance.rs` (add a `--gradient-row` diagnostic mode)

This probe runs the proxy's **exact** ffmpeg args on the 10-bit gradient — no app, no proxy-job hook — and inspects the result.

- [ ] **Step 1: Add a gradient-row diagnostic to the analyzer**

```rust
#[derive(Debug, serde::Serialize)]
struct GradientReport {
    sample: u64,
    row_y: u32,
    /// per-channel banding stats over the sampled mid-row (green channel shown
    /// first; all three serialized)
    banding: [BandingStats; 3],
    /// the 16-bit value at x=0 and x=mid — to confirm 10->16 scaling externally
    probe_x0: [u16; 3],
    probe_mid: [u16; 3],
}

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
        sample, row_y: y, banding,
        probe_x0: [x0.0[0], x0.0[1], x0.0[2]],
        probe_mid: [mid.0[0], mid.0[1], mid.0[2]],
    })
}
```

Wire a `--gradient` CLI branch (distinct from `--color`): on `--gradient-row` decode `--output` only (no source needed) and print `GradientReport`. Add `let mut gradient_row = false;` + `"--gradient-row" => gradient_row = true,` and a dispatch before `--color`.

- [ ] **Step 2: Write the proxy probe script**

```js
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..", "..");
const MEDIA = process.env.WEFTCUT_TEST_MEDIA || path.resolve(HERE, "..", "fixtures", "media");
const SRC = path.resolve(MEDIA, "test_1080p_gradient10.mp4");
const PROXY = path.resolve(os.tmpdir(), "weftcut-probe-proxy.mp4");

// proxy.rs args verbatim (PROXY_HEIGHT_CAP assumed 2160 -> no downscale of 1080).
const proxyArgs = [
  "-y", "-hide_banner", "-loglevel", "error", "-i", SRC,
  "-vf", "scale=-2:'min(ih,2160)'", "-c:v", "libx264", "-preset", "fast", "-crf", "18",
  "-profile:v", "high", "-bf", "0", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", PROXY,
];
const p = spawnSync("ffmpeg", proxyArgs, { encoding: "utf8" });
if (p.status !== 0) { console.error("proxy ffmpeg failed:\n" + p.stderr); process.exit(1); }

const tag = (f) => spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt,color_space,color_range", "-of", "default", f], { encoding: "utf8" }).stdout;
console.log("=== SOURCE TAGS ===\n" + tag(SRC));
console.log("=== PROXY TAGS ===\n" + tag(PROXY));

const grad = (f, im) => spawnSync("cargo", ["run", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml", "--bin", "media_conformance", "--quiet", "--", "--gradient-row", "--output", f, "--source", f, "--in-matrix", im, "--in-range", "tv", "--sample", "10"], { cwd: REPO, encoding: "utf8" }).stdout;
console.log("=== SOURCE gradient (10-bit) ===\n" + grad(SRC, "bt709"));
console.log("=== PROXY gradient (8-bit) ===\n" + grad(PROXY, "bt709"));
console.log("NOTE: confirm 10->16 scaling from source probe_mid[0]: <<6 => ~32736, /1023*65535 => ~32800.");
```

- [ ] **Step 3: Run the probe + record findings**

```bash
cd apps/desktop/e2e && node fixtures/generate-fixtures.mjs && node scripts/color-probe-proxy.mjs
```

Expected: source banding `distinct_levels` ≫ proxy's; proxy `max_plateau` wider (or, if dither is on, distinct recovers with noise). Record the 10→16 scaling factor + whether the proxy dithers in the spec's Decisions log.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/bin/media_conformance.rs apps/desktop/e2e/scripts/color-probe-proxy.mjs
git commit -m "feat(e2e): axis-B Stage 0 probe — proxy args verbatim + gradient banding + 10->16 scaling check"
```

---

## Task 11: Axis B baseline + assertion (analyzer-level, no e2e hook yet)

**Files:**
- Create: `apps/desktop/e2e/scripts/color-axisB-check.mjs`
- Create: `apps/desktop/e2e/fixtures/gradient_baseline.json`

Per the spec, the import→proxy e2e hook is **deferred** until the probe proves it worth wiring. Stage 2 for axis B runs at the analyzer level on the proxy-args output (the same args the real proxy uses).

- [ ] **Step 1: Record the gradient baseline from the probe**

After Task 10, write `gradient_baseline.json` from the measured proxy numbers:

```json
{
  "source_min_distinct": 900,
  "proxy_max_plateau_limit": 8,
  "note": "Replace with measured values from color-probe-proxy.mjs. proxy_max_plateau_limit is the measured proxy max_plateau + headroom; a regression (e.g. dither disabled) widens plateaus past this."
}
```

Replace the numbers with the measured ones from Task 10.

- [ ] **Step 2: Write the check script (gross-regression gate)**

```js
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..", "..");
const MEDIA = process.env.WEFTCUT_TEST_MEDIA || path.resolve(HERE, "..", "fixtures", "media");
const SRC = path.resolve(MEDIA, "test_1080p_gradient10.mp4");
const PROXY = path.resolve(os.tmpdir(), "weftcut-axisB-proxy.mp4");
const BASE = JSON.parse(readFileSync(path.resolve(HERE, "..", "fixtures", "gradient_baseline.json"), "utf8"));

const p = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", SRC, "-vf", "scale=-2:'min(ih,2160)'", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-profile:v", "high", "-bf", "0", "-pix_fmt", "yuv420p", "-f", "mp4", PROXY], { encoding: "utf8" });
if (p.status !== 0) { console.error(p.stderr); process.exit(1); }

const report = JSON.parse(spawnSync("cargo", ["run", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml", "--bin", "media_conformance", "--quiet", "--", "--gradient-row", "--output", PROXY, "--source", PROXY, "--in-matrix", "bt709", "--in-range", "tv", "--sample", "10"], { cwd: REPO, encoding: "utf8" }).stdout);
const lumaPlateau = report.banding[0].max_plateau;
console.log("proxy luma max_plateau =", lumaPlateau, "limit =", BASE.proxy_max_plateau_limit);
if (lumaPlateau > BASE.proxy_max_plateau_limit) {
  console.error(`REGRESSION: proxy banding widened (plateau ${lumaPlateau} > ${BASE.proxy_max_plateau_limit})`);
  process.exit(1);
}
console.log("axis B OK");
```

- [ ] **Step 3: Run it**

```bash
cd apps/desktop/e2e && node scripts/color-axisB-check.mjs
```

Expected: prints `axis B OK` (after the baseline is set from real numbers).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/scripts/color-axisB-check.mjs apps/desktop/e2e/fixtures/gradient_baseline.json
git commit -m "feat(e2e): axis-B gradient banding regression gate (analyzer-level)"
```

---

## Task 12: Docs + memory

**Files:**
- Modify: `docs/superpowers/specs/2026-06-03-color-conformance-axis-design.md` (fill Decisions log with Stage 0 findings)
- Modify: `C:\Users\iClass\.claude\projects\C--Users-iClass-Desktop-learning-videtor\memory\MEMORY.md` + a project memory file

- [ ] **Step 1: Record Stage 0 findings in the spec**

Append to the Decisions log: the export's real tags/matrix (from Task 6), whether export is untagged (and the Stage 2 decision taken), the proxy's 10→16 scaling factor + dither state (from Task 10), and the locked baseline numbers.

- [ ] **Step 2: Update auto-memory**

Add a `project_color_conformance.md` memory (what the two axes test, the probe findings, where the baselines live) and a one-line pointer in `MEMORY.md`. Link `[[weftcut-media-conformance-harness]]`.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-03-color-conformance-axis-design.md
git commit -m "docs: record color-conformance Stage 0 findings + locked baselines"
```

---

## Self-Review

**Spec coverage:**
- Axis A fixtures (flat chart, 4 encodings, manifest) → Tasks 1–2. ✓
- Forced-matrix decode + tag reporting → Task 4 (decode) + Task 6 (ffprobe tags). ✓
- Per-channel code-value error (primary), app-only gate + authored diagnostic → Tasks 3–4. ✓
- ΔE secondary → **deliberately deferred** (spec calls it "secondary/summary only"; not gating). Noted as future, not a gap in the gate.
- Axis-B secondary per-channel-10bit error → **deliberately deferred**: `banding_stats` (the implemented primary, on raw u16 full precision) is what catches reduction regressions; `analyze_gradient` reports banding only. Per-channel-10bit can be added later via a 16-bit-aware variant (the existing `channel_error` floors to 8-bit `/256`, so it is the axis-A metric, not reused here). Not a gap in the axis-B gate.
- Probe-first staging (Stage 0/1/2) → Task 6 (A probe), Task 10 (B probe), Tasks 7/11 (baselines locked after probe). ✓
- Axis B gradient fixtures (10-bit) → Task 9. ✓
- 16-bit extraction + `image-compare` Rgb8-only avoided (manual per-channel) → Tasks 3/4/8. ✓
- Banding/plateau primary + per-channel secondary + dither detection → Tasks 8/10. ✓
- 10→16 scaling confirmed before normalizing → Task 10 (probe_mid check). ✓
- Proxy args verbatim, no e2e hook yet → Tasks 10–11. ✓
- Standard line per encoding-class, locked after probe → Task 7 baseline (per-enc) + Task 11 (gradient). ✓

**Placeholder scan:** baseline JSONs contain example numbers explicitly marked "replace with measured" — this is the probe-first design (numbers come from Stage 0/1 runs), not a TODO. ΔE deferral is explicit. No "add error handling"/"similar to Task N" placeholders.

**Type consistency:** `channel_error`/`ChannelError`, `Manifest`/`Patch`, `sample_patch`, `extract_frame_png_ex`, `decode_rgb16`, `analyze_color`/`ColorReport`/`PatchResult`, `banding_stats`/`BandingStats`, `analyze_gradient`/`GradientReport`, `analyzeColor` (JS) — names used consistently across tasks. CLI flags `--color`/`--manifest`/`--in-matrix`/`--in-range`/`--sample`/`--gradient-row` consistent between Rust (Task 4/10) and JS wrappers (Tasks 5/6/10).

**Known integration risks to watch during execution (not gaps):**
- The `main` arg-dispatch refactor (Task 4 Step 3) must keep brace balance with the existing `audio`/`samples` blocks — verify the build compiles before the smoke step.
- `PROXY_HEIGHT_CAP=2160` is assumed in Tasks 10–11; if proxy.rs's const differs, the `scale=-2:'min(ih,N)'` must match for the probe to mirror the real proxy. Confirm the const at execution time.
- `libx265`/`libx264 10-bit` availability gates Task 9; the generator fails loudly if absent.
