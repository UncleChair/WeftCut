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
