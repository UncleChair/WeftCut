# Media-conformance E2E harness — design

## Problem

WeftCut's value is correct video in / correct video out across a codec matrix
(H.264, Hi10P, HEVC, AV1, VP9, ProRes), at various frame rates and containers.
Today nothing tests that on the engine the app actually ships on. The gaps:

- **No real-engine test.** The only browser-level test (`001_color`) renders a
  flat Color layer through Playwright **Chromium** — a different engine from the
  shipped **WebView2 (Edge)**. Codec behavior diverges between them (Hi10P
  decodes in Chrome but stalls in WebView2; `prefer-hardware` is treated as
  mandatory in WebView2 → AV1 false-negative). A Playwright pass gives false
  confidence about what the real app does with real codecs.
- **No real-media path.** No test decodes a real file end-to-end
  (decode → composite → re-encode → mux). `001_color` uses an empty media map.
- **No measurement of the things that matter for video:** frame alignment
  (drift / dropped / duplicated frames — the `frameDurUs` area had a real bug)
  and conversion loss (quality through the pipeline).

We have purpose-built assets for this (in an external dir, see Assets): a Go
generator (`generate.go`) emits `testsrc2` clips with a **burned-in `FRAME
NNNNN` counter, SMPTE timecode, and a per-second center digit** on every frame,
plus a 300-frame pristine PNG reference set. Each frame is uniquely
identifiable — exactly what frame-alignment verification needs.

## Goals (first slice)

Ship ONE thin, fully-working vertical slice that proves the architecture:

1. Drive the **real WeftCut app (real WebView2)** to import and export ONE
   synthetic H.264 clip, headlessly and repeatably. The clip is placed **1:1**
   on the timeline (no trim, no retime, same fps in and out) so the expected
   mapping is identity: output frame `N` should show source frame `N`.
2. **Frame alignment:** confirm each sampled output frame carries the expected
   source frame index (read from the burned-in `FRAME` number).
3. **Conversion loss (app-only):** SSIM/PSNR of each sampled output frame
   against the **decoded source** frame of the same index.

## Non-goals (explicitly deferred — separate later slices)

- **Codec matrix** (Hi10P / HEVC / AV1 / VP9 / ProRes / 60·120 fps / mkv·mov).
  First slice is one clip, one path. The harness is built to extend to these.
- **Import-routing matrix** (Hi10P→proxy, H.264→direct, …). Mostly Rust, partly
  unit-covered already.
- **Audio alignment.** Blocked: every synthetic clip is `-an` and the real
  clips carry no known sync marker. Needs a `generate.go` extension that muxes a
  click/tone on known frames before this is startable. Tracked as future work.

## Validated assumptions (spikes already run, 2026-06-02)

- **tauri-driver attaches to WeftCut's real WebView2.** `cargo install
  tauri-driver` + msedgedriver matched to the installed Edge/WebView2
  (`148.0.3967.96`) + `tauri build --debug --no-bundle` + a 10-line wdio spec:
  session reported as `webview2 v148.0.3967.96`, `navigator.userAgent` contains
  `Edg/148`, `getTitle()` = "WeftCut", Tauri bridge present, DOM mounted. No
  version-mismatch hang. **This is the engine fidelity the design depends on.**
- **mediabunny + WebCodecs decode real 1080p H.264.** (Proven in a Chromium
  spike; the real harness exercises WebView2's decoder via the app itself.)

## Architecture — two layers

The producer and the analyzer are **decoupled**: the analyzer measures an
output file regardless of how it was produced. This keeps the analyzer testable
in isolation (run it on an existing export) and lets the producer evolve.

```
[test clip] --> Layer 1: Producer (WebDriver E2E, real WebView2)
                     drives WeftCut: import -> place -> export -> file on disk
[output.mp4] --> Layer 2: Analyzer (Rust + ffmpeg-sidecar, producer-agnostic)
                     per sampled frame:
                       - read burned-in FRAME id  -> frame-alignment verdict
                       - SSIM/PSNR vs decoded source frame -> loss verdict
                     -> structured JSON report, non-zero exit on any failure
```

### Layer 1 — Producer (WebDriver E2E)

- **Stack:** WebdriverIO (`@wdio/cli` + local-runner + mocha-framework +
  spec-reporter, v9) + `tauri-driver` (cargo bin) + `msedgedriver`.
- **Location:** `apps/desktop/e2e/` — `wdio.conf.*`, `specs/`, and a small
  setup script.
- **Real app:** `wdio.conf` `onPrepare` runs `tauri build --debug --no-bundle`
  and points `tauri:options.application` at
  `src-tauri/target/debug/weftcut.exe`. `beforeSession` spawns `tauri-driver
  --native-driver <msedgedriver>`; `afterSession` kills it.
- **msedgedriver version pinning (critical — mismatch → silent hang):** a setup
  step reads the installed Edge/WebView2 build (registry / `msedge.exe`
  ProductVersion) and downloads the **matching** `msedgedriver`
  (`https://msedgedriver.microsoft.com/<version>/edgedriver_win64.zip`) into a
  cached, git-ignored tools dir. Because WebView2 is evergreen, this runs each
  time and fails fast with a clear message if the download 404s, rather than
  hanging the suite.
- **Driving import + export — test-control surface (recommended over UI
  clicking):** the export runs through the frontend's real export Worker
  (WebCodecs in WebView2), so the E2E must trigger the real frontend. Rather
  than click fragile UI, expose a **dev/test-only JS hook** (e.g.
  `window.__weftcutTest` mounted only under a test flag, or reuse the existing
  dev MCP bridge) that the spec calls via `browser.execute(...)` to: open a
  project referencing the test clip, then run the export to a known output path.
  UI-driving is the fallback if a programmatic hook proves impractical. The
  exact shape of this hook is the first thing the implementation plan resolves.
- **Output:** the export writes `output.mp4` to a known path the analyzer reads.

### Layer 2 — Analyzer (Rust + ffmpeg-sidecar)

A **new, self-contained CLI bin** `media_conformance` (DECISION — not an
extension of the old `fixture_compare`, which is removed with the rest of the
Playwright-era system; see Cleanup). It salvages the two proven, non-Playwright
primitives from the old `fixtures.rs` — `extract_frame_from_file`
(ffmpeg-sidecar) and `compare_ssim_pngs` (`image` + `image-compare`) — copied
into the new bin's own module rather than depended upon, so the old files can be
deleted cleanly. Invoked as `media_conformance --output <mp4> --source <mp4>
--samples <frame indices>`:

1. **Frame-ID reader (no OCR dependency).** The `FRAME NNNNN` text is rendered
   with `consola.ttf` (monospace) at a fixed position (x=20, y=20, fontsize=42)
   on a black box. The analyzer crops that fixed rectangle and matched-filters
   each digit cell against the 10 pre-rendered consola glyphs (rendered once via
   the same drawtext and cached) → the integer source-frame index. Deterministic
   because we control font, size, and position.
2. **Frame alignment.** For an output frame sampled at composition time `T`,
   assert the read FRAME id equals the expected source index for `T`. Catches
   off-by-one, drift, dropped, and duplicated frames.
3. **Conversion loss (app-only baseline — DECISION).** Compare each sampled
   output frame to the **decoded source** frame of the **same index** (aligned
   by the FRAME id, not by timestamp): SSIM (+ PSNR) with a pass threshold.
   This isolates WeftCut's own loss (decode → composite → re-encode) from the
   source's original x264 encode. (Rejected baselines: vs pristine `frames/*.png`
   conflates source-encode loss with app loss; "both" adds a reference path to
   maintain for no first-slice benefit.)

Output: a structured JSON report + non-zero exit on any alignment failure or
sub-threshold loss, so it can become a gate.

## Assets

External (NOT committed — large): an env-pointed dir (default the current
`...\testfile`), holding the generator + clips. The harness reads
`WEFTCUT_TEST_MEDIA` (or a config file); **if the dir is absent it SKIPs the
real-media E2E with a logged notice** rather than failing — so a fresh
checkout / a machine without the assets still passes the rest of the suite.

First-slice clip: `test_1080p_30fps.mp4` (H.264 High, yuv420p, 1920×1080, 30fps,
10s, 300 frames). Source of truth for frame ids = the burned-in counter; pristine
`frames/frame_NNNN.png` kept as an optional absolute reference only.

`generate.go` (the matrix generator) is the natural home for the future audio
sync-marker extension and for emitting the HEVC/AV1/VP9 clips the codec-matrix
slice will need.

## Cleanup — remove the entire Playwright-era fixture system (DECISION)

"Tests run in the app, not via Playwright" — the old system is fully removed,
not kept alongside:

- **Remove (Playwright render layer):** `vitest.browser.config.ts`,
  `src/**/*.browser.test.ts` (`001_color`), the `@vitest/browser` +
  `@vitest/browser-playwright` + `playwright` dev-deps. (This retires the
  `fixtures:render` gate greened in commit `86abfe9`.)
- **Remove (old fixture-suite scaffolding):** the `fixture_compare` Rust bin,
  the fixture-suite logic in `fixtures.rs` (`check_fixture`, manifest loading,
  `SuiteReport`, …), the `extract_video_frame` / `compare_fixture_frame` Tauri
  devtools commands **if not used elsewhere** (verify in the plan), the
  `fixtures:render` / `fixtures:compare` / `fixtures:check` npm scripts, and the
  old `apps/desktop/fixtures/` sample fixtures (`001_color`, `002_color_stack`).
- **Salvage, don't depend on:** the two pure primitives
  (`extract_frame_from_file`, `compare_ssim_pngs`) are copied into the new
  `media_conformance` bin, then the old files are deleted — no half-gutted
  `fixtures.rs` left behind.
- **Keep:** all of `86abfe9`'s **non-Playwright** fixes — typecheck (`tsc -b`
  + the type-error fixes), the `vite.config` `chrome105` target, and the
  **Compositor Color-layer product-bug fix** (that one was a real product bug;
  it stays regardless of how it was found).

## Failure modes & handling

- **msedgedriver ≠ WebView2 version → hang.** Mitigation: auto-fetch the
  matching driver each run; fail fast on download error.
- **Export never completes (decoder stall / crash).** The spec waits on a
  completion signal with a timeout → fails with the captured app logs, not a
  hang.
- **Missing external assets.** Skip-with-notice, not fail.
- **Build cost.** Each E2E run needs a `tauri build --debug` (Rust, minutes).
  This is a smoke/nightly-tier gate, not an inner-loop test; fast unit tests
  (`npm test`, 251) stay the inner loop.

## CI implication (no CI exists yet — separate effort)

The E2E needs a Windows runner with WebView2 + a matched msedgedriver + the Rust
toolchain to build the app. Heavier than the unit tier. Wiring any CI at all is
its own follow-up; this design just keeps the harness CI-runnable (headless,
asset-skip, deterministic exit codes).

## Future slices (after this one lands)

1. Codec matrix: generate HEVC/AV1/VP9 + use Hi10P/ProRes/60·120fps; per-codec
   import-route + export expectations.
2. Import-routing assertions (Rust): decodability/proxy decision per codec.
3. Audio alignment: `generate.go` sync-marker extension → A/V sync measurement.

## Resolved (user, 2026-06-02)

- **Test-control surface:** programmatic dev/test-only JS hook
  (`window.__weftcutTest`, mounted only under a test flag), driven via
  `browser.execute(...)` — NOT UI clicking, NOT the MCP bridge.
- **Analyzer:** a NEW bin (`media_conformance`); the old Playwright-era system
  is removed entirely (see Cleanup).
- **Harness location:** `apps/desktop/e2e/`.

## Open questions for the plan

- Exact API of the `window.__weftcutTest` hook (open-project + export-to-path
  signature) and how the test flag is set so it's absent in production builds.
- Sample-frame selection (which indices: first / mid / last + a few interior).
- Confirm `extract_video_frame` / `compare_fixture_frame` Tauri commands have no
  other consumers before removing them.
