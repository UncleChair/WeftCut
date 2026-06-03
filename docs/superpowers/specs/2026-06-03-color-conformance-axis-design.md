# Color-conformance test axis — design

## Problem

The media-conformance harness verifies **frame alignment** (strict) and a
**loose SSIM floor** (0.80) on a burned-in-counter `testsrc2` clip. SSIM over RGB
is luma-dominated and nearly blind to chroma/matrix error: a "BT.601 read as
BT.709" shift can stay above 0.80 and pass silently (the historical full
mismatch only fell to ~0.47). **Color fidelity is therefore not tested today.**

Two distinct color questions are unverified:

1. **8-bit round-trip fidelity** — does a known color survive
   import → composite → re-encode → mux and come back unchanged? Across the
   realistic encoding matrix ({601,709}×{limited,full}), not just the one tag the
   current fixture happens to carry.
2. **Proxy fidelity on 10-bit sources** — WebView2 cannot decode 10-bit
   (`yuv420p10le` → full proxy, `proxy_decision.rs`), so every 10-bit source is
   reduced to 8-bit by the Rust `libx264 -crf 18` proxy (`proxy.rs`) before the
   webview ever sees it. That reduction is a real, user-invisible quality step
   that nothing measures.

## Pipeline facts this design is built on (verified 2026-06-03)

- **Export is 8-bit, untagged-by-WeftCut.** All export codec strings are 8-bit
  (`avc1.640028`, `av01.0.13M.08` "8-bit", `hev1.1.6` Main not Main10 —
  `exportSettings.ts`). The encoder config carries no color fields
  (`runExport.ts`); color metadata rides *only* the first WebCodecs chunk's
  `metadata.decoderConfig.colorSpace` into mediabunny (`encoder.ts`), and what
  WebView2's encoder puts there is **unverified**. The Rust final-mux writes no
  `-colorspace`/`-color_primaries`.
- **Decode side is closed.** Source fixtures are tagged BT.709 matrix + tv range
  (`generate.go`; ffprobe confirms `color_space=bt709, color_range=tv`, though
  `transfer`/`primaries` read `unknown` — a libx264/MP4 VUI quirk). Untagged
  sources get a resolution-keyed default (`colorSpaceDefault.ts`).
- **There is no 10-bit *output* path.** "10-bit loss" in WeftCut = the
  10→8 proxy reduction, not a 10→10 round-trip (which does not exist).
- **The analyzer is 8-bit-blind.** `extract_frame_png` ends in `to_rgb8()`;
  both sides drop the low 2 bits, so a naive run measures ~0 extra 10-bit loss.

## Two axes

The two axes measure **different things** and stay decoupled (independent
fixtures, independent specs, shared analyzer binary), so each can land and be
validated on its own:

- **Axis A — 8-bit round-trip fidelity.** Producer = real-WebView2 export. The
  question: does the app preserve color end-to-end?
- **Axis B — proxy fidelity on gradients.** Producer = the Rust ffmpeg proxy.
  The question: how much does the 10→8 proxy degrade a smooth gradient?

Both follow **probe-first**: Stage 0 pins reality (what tags/matrix/dither the
pipeline actually produces) before any threshold is set; thresholds are locked
only after the probe. Stage 2 (the gate) is conditional on Stage 0's findings.

---

## Axis A — 8-bit round-trip fidelity

### The matrix-pinning requirement (blocks validity)

Color comparison is only meaningful if the YUV↔RGB matrix is pinned at **both**
ends. An untagged export decoded with ffmpeg's default matrix measures
"(encoder's matrix guess) vs (ffmpeg's decode guess) agreement" — not whether
WeftCut preserved color. So the analyzer must:

- **Force-decode** with an explicit matrix/range
  (`-vf scale=in_color_matrix=M:in_range=R,format=rgb24`), ignoring tags, and
- **Report the output's actual tags** (ffprobe the export). An untagged output
  is itself a finding, not a thing to silently guess through.

### Fixtures — flat color-patch chart

`testsrc2` is too noisy (4:2:0 + sharp edges floor the baseline at ~0.85,
swamping matrix shifts). Use **large flat patches** instead:

- Extend `generate.go` to draw a chart of ~16–20 large rectangles (center-region
  sampling is robust to 4:2:0 + compression) and emit `color_manifest.json`
  (`{ patch_id, rect, authored_rgb }` — the absolute ground truth).
- **Deliberate diagnostic values** so expected vs regressed loss is legible:
  primaries R/G/B, secondaries C/M/Y, near-black (0,0,0)+(16,16,16), near-white
  (235,235,235)+(255,255,255), mid-grays, a skin tone, a saturated mix. Near-
  black/near-white specifically exercise limited-range endpoint clipping.
- One authored-RGB chart, encoded into four clips with matching tags:
  `test_1080p_color_709ltd.mp4`, `_601ltd`, `_709full`, `_601full`. Same authored
  RGB across all four; only the YUV encoding + tag differ.

No burned-in counter is needed — flat 1:1 export, sample any interior frame.

### Analyzer — `media_conformance --color`

Per sampled frame, per patch: crop the rect, average a center sub-region, then:

- **Primary metric: per-channel code-value error (mean + max)** over 0..255.
  Directly answers "is code 235 still 235" and is diagnostic ("red drifted 4
  codes"). A hand-rolled ΔE2000 is **not** the gate.
- **Secondary: ΔE (CIE76 or ΔE2000)** as a perceptual summary only.
- **Two references:**
  - **Gate on app-only** = output vs **decoded-source** (same forced matrix on
    both). This matches the existing harness's stated app-only baseline and means
    "WeftCut's own color loss."
  - **authored-RGB** = diagnostic / total-loss reference. (It bakes in the
    source's own 4:2:0 + RGB→YUV rounding — negligible on flat patches, but the
    *gate* number should mean app loss, so authored-RGB stays diagnostic.)

### Standard line (locked after Stage 0)

Per **encoding-class** (a single global number is wrong — limited vs full and
endpoint vs midtone patches lose legitimately different amounts). Initial values,
to be replaced by measured numbers:

- Same-encoding round-trip (8→8 identity, flat, faithful): per-channel mean
  ≤ ~1–2 codes, max ≤ ~3–4 codes.
- Cross-encoding faithful: per-channel mean ≤ ~2–3 codes.
- Near-black / near-white: looser, listed separately (endpoint clipping).

---

## Axis B — proxy fidelity on gradients (10→8)

### Honest framing — this is NOT isolated bit-depth loss

The proxy is `libx264 -crf 18` (lossy DCT) and gradients are H.264's worst case
(it bands gradients even 8→8). So `source(10b) vs proxy(8b)` **conflates three
losses**: bit-depth reduction, 4:2:2→4:2:0 (ProRes sources), and crf-18
compression — and on gradients the compression banding likely dominates the
bit-depth step. Axis B is therefore named and gated as **"proxy fidelity on
gradients (reduction + chroma + compression, combined)"**, a gross-regression
gate. It does **not** claim bit-depth isolation.

- **Optional extension (only if an isolated number is wanted):** add a reference
  = source reduced to 8-bit *without* compression
  (`-pix_fmt yuv420p -f rawvideo` or `-qp 0`). Then
  `delta(10b → raw8b)` = depth + chroma and `delta(raw8b → proxy)` = compression.
  Deferred; not in the first slice.

### Fixtures — smooth gradient ramps

Banding only shows on gradients, so axis B needs its own fixtures (not
`testsrc2`, not the flat chart):

- Grayscale ramp 0→1023 across the width, per-channel R/G/B ramps, a denser
  near-black segment.
- True 10-bit sources, authored via `geq`/`gradients` (testsrc2 won't do it) and
  a **10-bit-capable x264/x265**: HEVC Main10 + H.264 Hi10P (`yuv420p10le`, the
  canonical "WebView2 can't decode → proxy" case), plus the existing ProRes 422
  10-bit. (Spread is Stage 1+; the probe needs only one.)

### Analyzer — 16-bit extraction path

The 8-bit path is structurally blind to this. Add a 16-bit path:

- Extract via ffmpeg `-pix_fmt rgb48` and decode as `image::Rgb16`. Compare
  `source(10b)` vs `proxy(8b)` in 10-bit code space (0..1023).
- **Gotcha — 10→16 scaling:** Stage 0 must confirm ffmpeg's scaling before
  normalizing; it is likely `<<6` (1023 → 65472, *not* 65535). Normalize by the
  measured factor or every 10-bit value carries a constant offset.
- **Gotcha — `image_compare::rgb_similarity_structure` is Rgb8-only.** The 16-bit
  path cannot reuse it; per-channel error on `Rgb16` is manual (which is the
  metric anyway). No SSIM at 16-bit unless hand-rolled — not planned.

### Metrics

- **Primary: banding / plateau** — distinct-level count along the ramp and/or
  max plateau width. This is what moves when reduction quality regresses;
  per-channel averages get washed out under dither.
- **Secondary: per-channel code-value error (10-bit space).**
- **Dither detection:** a dithered proxy trades banding for noise — distinct-
  level count recovers but with local noise. Report both so the signature is
  legible (and so "dither got turned off" is catchable).

### Producer — keep Stage 0 cheap, defer the e2e hook

- **Stage 0 (probe):** run the proxy's *exact ffmpeg args* on one 10-bit gradient
  fixture directly + ffprobe the output (dither on? tags? pix_fmt? scaling?). No
  app, no new async-job hook.
- **Defer the import→proxy hook.** Driving the real proxy through app import
  needs a new e2e surface (wait-for-proxy-done + get-proxy-path). Build it only
  after the probe proves axis B is worth wiring end-to-end; until then the
  analyzer runs on the proxy file produced by the proxy's own args.

---

## Shared: probe-first three stages

| Stage | Axis A | Axis B |
|---|---|---|
| **0 — Probe** | One real export → ffprobe tags → force-decode 601/709 × ltd/full → which matches authored RGB ⇒ the export's real matrix/tags | Run the proxy's exact ffmpeg args on one 10-bit gradient → ffprobe ⇒ dither / tags / pix_fmt / 10→16 scaling |
| **1 — Baseline** | All 4 encodings → measure per-channel error → lock per-encoding standard line | Gradient spread → measure plateau/banding + per-channel → lock baseline |
| **2 — Gate (conditional)** | Assert ≤ standard line; if export is untagged, **decide** whether to add export color-tagging (product fix) first | Assert proxy ≤ baseline; regression on banding fails |

Thresholds are **not** set before the probe, on either axis.

## File layout

- `apps/desktop/e2e/fixtures/generate.go` — `--color <enc>` (flat chart + manifest)
  and `--gradient` (10-bit ramps) modes.
- `apps/desktop/e2e/fixtures/generate-fixtures.mjs` — `MATRIX` gains the 4 color
  clips + the 10-bit gradient clip(s); `color_manifest.json` alongside the media.
- `apps/desktop/src-tauri/src/bin/media_conformance.rs` — `--color` mode,
  `--in-matrix`/`--in-range` forced decode, a 16-bit (`Rgb16`) extraction +
  per-channel/banding analysis, and output-tag reporting (ffprobe).
- `apps/desktop/e2e/lib/analyze.mjs` — wrap the new invocations.
- Stage 0 probe: a standalone node script (axis A: one export + analyze; axis B:
  proxy-args + ffprobe). Stage 2 gate: `color_conformance.e2e.js` (axis A export;
  axis B import→proxy once its hook lands).

## Failure modes & handling

- **Untagged export.** Reported by Stage 0, not guessed through. Drives the
  Stage 2 decision (gate-as-is vs fix-export-tagging-first).
- **Missing external assets / encoders.** Skip-with-notice (matches the existing
  harness); axis B additionally needs a 10-bit-capable x264/x265 + `go`/`ffmpeg`.
- **10→16 scaling assumption wrong.** Caught in Stage 0 before any threshold.

## Open questions for the plan

- Exact patch set + chart layout (count, rect sizes, the diagnostic values).
- Forced-matrix CLI shape and how `--color` reports both references + tags in one
  JSON report (reuse the existing `Report`/exit-code conventions).
- Axis B Stage 1 fixture spread (HEVC Main10 vs Hi10P vs ProRes — how many).
- The import→proxy producer hook shape (only if Stage 0 greenlights axis-B e2e).
- Whether to fix `generate.go`'s untagged `transfer`/`primaries` while there.

## Decisions log (resolved by user, 2026-06-03)

- **Intent:** probe-first — pin reality before thresholds; gate decision follows
  the probe.
- **Axis A encodings:** {601,709}×{limited,full} = 4 (8-bit only).
- **10-bit:** in scope this round, as Axis B (proxy fidelity), alongside Axis A.
- **Defaults adopted (vetoable):** primary metric = per-channel code-value error;
  chart authored in Go + manifest (not SMPTE bars, for endpoint control); Stage 0
  probe = standalone script.
- **From advisor review:** axis B reframed as combined proxy fidelity (not
  isolated bit-depth); axis B primary metric = banding/plateau; axis B probe via
  direct ffmpeg args (no e2e hook yet); axis A gates on app-only (output vs
  decoded-source) with authored-RGB diagnostic.

## Implementation status (2026-06-03)

Branch `test/color-conformance-axis`. All analyzer/generator/script code is
implemented, committed, and unit/smoke-verified. Each pure function is TDD'd;
the `media_conformance` bin suite is 13/13 green.

- **Axis A (8-bit round-trip): run + gated 2026-06-03 — caught a real product bug.**
  `generate.go --color` chart + `color_manifest.json`; `media_conformance --color`
  (forced `--in-matrix`/`--in-range` decode, per-channel code-value error, app-only
  gate + authored diagnostic); `analyzeColor` wrapper; `specs/color_conformance.e2e.js`
  gate. Real WebView2 exports of all four charts: **709-limited round-trips perfectly
  (worst_app_max=0), but BT.601=~20, 709-full=~20, 601-full=~34** off — see the Axis-A
  findings below. Gate landed as "709-green / 601·full-expected-fail"; the product fix
  is a deferred follow-up.

## Stage 0 findings — Axis B (measured 2026-06-03)

Measured by `scripts/color-probe-proxy.mjs` running the proxy's exact ffmpeg args
(`proxy.rs`: `libx264 -preset fast -crf 18 -profile:v high -g 6 -bf 0 -pix_fmt
yuv420p`) on `test_1080p_gradient10.mp4` (true 10-bit, mid-row distinct ≈ 881):

- **The proxy PRESERVES color tags** — output `yuv420p` (8-bit) but keeps
  `bt709 / tv / bt709 / bt709`. Tag-faithful (unlike the export, TBD on axis A).
- **10→8 reduction: distinct levels 881 → 220** (~4×, the expected ~2-bit loss).
- **No dither:** 220 < 256 ⇒ pure quantization, not error-diffusion (dither would
  push distinct back ≥256 with noise). This is the signature to watch.
- **ffmpeg 10→16 decode is full-scale** (`probe_mid 33312 / 520 ≈ 65535/1023`),
  **not** `<<6` (which would give 65472). Matters only for the deferred
  per-channel-10bit metric — the banding gate counts raw distinct values
  (scale-invariant), so it is unaffected.
- **Locked axis-B baseline** (`fixtures/gradient_baseline.json`): gate on the
  proxy luma row — `distinct_levels ≥ 180` (floor below measured 220) and
  `max_plateau ≤ 250` (ceiling above measured 152; the 147→152 plateau is
  dominated by limited-range black-clamp, a weaker signal than distinct levels).
  `scripts/color-axisB-check.mjs` passes today (220/152) and its regression path
  is verified (tampering the floor to 500 → exit 1).

## Stage 0 findings — Axis A (measured 2026-06-03, real WebView2)

Exported all four charts through the real app (4 passing, `webview2 148.0.3967.96`),
then probed. **app-only worst_app_max: 709ltd=0, 601ltd=20, 709full=20, 601full=34.**
Every output is tagged identically `bt709/tv`.

**Root cause (isolated + confirmed):** the bug is upstream of the export tag — the
canvas RGB is already wrong for non-709/non-limited sources before the encoder runs.
Three evidence pieces:

1. **WebView2 honors explicit `VideoFrame.colorSpace`** (matrix + range): a synthetic
   I420 frame tagged `smpte170m` vs `bt709` converts to different RGB (G 39 vs 71), and
   `tv` vs `pc` differs (255 vs 235) — proven on both a 2D canvas and a WebGL2
   `texImage2D` readback (`tools/color_isolation_*.e2e.js`).
2. **Pixi's upload preserves it** — `GlTextureSystem` only sets `UNPACK_PREMULTIPLY_ALPHA`,
   never `UNPACK_COLORSPACE_CONVERSION` (stays browser-default, which honors).
3. **`getDecoderConfig().colorSpace` is `undefined`** for all four fixtures (node probe):
   the H.264 bitstream VUI lacks the matrix and mediabunny doesn't surface the container
   `colr` box. So `withDefaultColorSpace` hits its `matrix == null` branch and **defaults
   every HD source to `bt709`/limited** → the decoder is fed the wrong matrix/range. 709-
   limited works by luck (default matches); 601/full are mis-converted.

**This is NOT a `runExport` output-tag fix** — the output is already tagged `bt709/tv`,
matching its (wrongly-converted) pixels; re-tagging fixes nothing.

## Gate landed: "709-green / 601·full-expected-fail"

`specs/color_conformance.e2e.js` + `fixtures/color_baseline.json` (`faithfulMax=5`):
faithful encodings (`expectFaithful:true`, 709ltd) assert `worst_app_max ≤ 5`; known-bad
encodings (`expectFaithful:false`, 601/709full/601full) assert `worst_app_max > 5` — i.e.
they assert the bug is STILL present, so the suite stays green (4 passing) until the fix
lands. When the color-management fix lands, their error drops ≤ 5, those assertions go
RED, and that's the signal to flip `expectFaithful:true`. No broken error magnitudes are
enshrined as "acceptable" (`measured_worst_app_max` in the baseline is documentation only).

## Deferred follow-up — the color-management product fix (own design)

Read the source's REAL color tags (they exist in the container `colr` box — ffprobe sees
`smpte170m`/`tv`) and feed them to the decoder, instead of defaulting to 709. Likely
either: (a) find where mediabunny exposes container color metadata beyond
`getDecoderConfig`, or (b) extract it Rust-side at import (`io/probe.rs` already ffprobes)
and pass it to the frontend to override `withDefaultColorSpace`. Same class as the
original `colorSpaceDefault` fix, extended: default-by-resolution is right for truly-
untagged sources but wrong for sources tagged in-container only. Verify the fix flips
601/full to green via this harness (the gate will go RED, then flip `expectFaithful`).

Diagnostics retained under `e2e/tools/` (excluded from the `specs/**` auto-run):
`record_color_exports.e2e.js` (re-record/verify exports), `color_isolation_canvas.e2e.js`
and `color_isolation_webgl.e2e.js` (the colorSpace-honoring probes).
