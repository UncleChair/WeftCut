---
status: accepted
---

# CPU-plane YUV converts in owned shaders; browser color conversion is trusted for decoder-produced frames only

## Context

The compositor ingests video frames from two kinds of producers. WebCodecs
decoders hand over browser-produced `VideoFrame`s whose color space Chromium
tracks internally. The native ffmpeg lanes ship raw CPU planes (8-bit NV12,
10-bit I420P10) across the process boundary as bytes (ADR 0029), which the
renderer must turn back into pixels itself.

ADR 0021 admits two legitimate chokepoint forms for color conversion:
*verified delegation* (platform math, our routing, tag-honoring proven by a
gate) and *owned parameters* (conversion we run with every knob explicit).
The browser 2D-canvas paths (`drawImage`, `createImageBitmap`) were the
verified delegates for YUV matrix/range — but that verification was measured
on decoder-produced frames.

The ProRes fidelity gate (`e2e/electron/export-prores-fidelity.spec.ts`)
proved the delegation does NOT extend to buffer-defined frames: **Chromium's
software conversion of an ArrayBuffer-constructed `VideoFrame` applies BT.601
coefficients regardless of the stamped `colorSpace`** — `drawImage` and
`createImageBitmap` ride the same converter. Measured signature on a
bt709/limited chart: yellow `B 0→10` (601-decode of 709-encoded YUV predicts
+10.6), blue `B 253→240`; differential SSIM-to-source 0.616 (native lane,
tinted) vs 0.892 (proxy lane, correct). Output tags were right while the
pixels were wrong — precisely the "convenient default doing silent color
math" that ADR 0021 fences off.

This is the third platform gap in one family: `VideoEncoder` ignores
`VideoFrame.colorSpace` when tagging output; Pixi's raw-`VideoFrame` WebGPU
upload (`copyExternalImageToTexture`) converts everything as BT.709; and now
buffer-frame software rasterization converts everything as BT.601. The
pattern behind all three: whenever raw YUV crosses into the platform with
color metadata *attached as data*, the platform may ignore the metadata.
Sibling gates were structurally blind to the new instance — natural-content
SSIM barely weights chroma (~1/6), and grayscale fixtures reconstruct
identically under any matrix — which is why only a saturated-chart
differential exposed it.

## Decision

**A buffer-defined `VideoFrame` — and CPU-plane YUV generally — is never
handed to the browser for color interpretation. Every CPU-plane frame
entering the compositor converts to RGB in an owned shader pass, with the
matrix and range selected from the frame's mapped source color.** In ADR
0021's taxonomy these lanes move from failed *verified delegation* to *owned
parameters*.

The mechanism, shared by both bit depths:

- CPU planes ride the ring as their own frame kinds — `NativeNv12Frame`
  (`render/decoder/nv12Frame.ts`, also the one comment home for the Chromium
  fact) and `TenBitFrame` — never as reconstructed `VideoFrame`s.
- `Nv12Ingest` / `TenBitIngest` are the owned WebGL2 conversion passes;
  `coefForMatrix` (`render/tenbit/yuv10.ts`) is the single source of
  coefficient selection (BT.601 for `smpte170m`/`bt470bg`, else BT.709;
  limited/full scale explicit).
- The `drawImage` snapshot path excludes CPU-plane frame kinds at compile
  time — `VideoClipSprite.updateFrame` takes `BrowserConvertibleFrame`
  (`decoder/decodedFrame.ts`), so the forbidden route cannot be written.
- Decoder-produced `VideoFrame`s keep the verified snapshot path — ADR
  0021's delegation stands for them, arbitrated by the color-conformance
  gates as before.

**Every owned conversion lane must be gated with saturated color content**
(the chart fixtures); alignment-oriented SSIM floors and grayscale ramps are
not evidence of matrix correctness.

## Consequences

- ADR 0029's single-color-model clause ("reconstruct `VideoFrame` →
  `createImageBitmap`, converge at the `drawImage` chokepoint") is superseded
  as to conversion *location*; its transport decision (ship bytes, not
  shared textures) is untouched.
- Both surfaces comply. Export: `Nv12Ingest`/`TenBitIngest` (the export
  worker prefers WebGL when native-decoded media is present; `TenBitIngest`
  is WebGL2-only). Preview: the software transport (`SwTransport`) rings
  `NativeNv12Frame`s that convert through the same `Nv12Ingest`, which
  carries a WGSL twin of its GLSL pass because the preview renderer prefers
  WebGPU. One ingest, one `coefForMatrix`, both surfaces.
- Any NEW CPU-plane lane (4:2:2 transport, HDR planes, screen/mic capture
  surfaces, future pixel formats) must arrive as its own frame kind + owned
  ingest + saturated-chart gate. Adding a `new VideoFrame(bytes, …)` +
  browser-conversion path is forbidden, however convenient.
- If Chromium ever fixes buffer-frame tag-honoring, the owned passes remain
  correct and gated; reverting to delegation would need fresh verification
  per ADR 0021's rules, and buys nothing.

## References

- ADR 0021 — the chokepoint taxonomy this decision refines (its offender
  list now carries the buffer-defined-frame entry).
- ADR 0029 — the ship-bytes transport these frames arrive over.
- Gates: `e2e/electron/export-prores-fidelity.spec.ts` (chart + differential),
  `e2e/electron/export-native-wedges.spec.ts` (ramp precision),
  `e2e/electron/preview-sw-color.spec.ts` (preview charts: 709 tint leg +
  601 no-over-correction leg),
  `e2e/electron/color-conformance.spec.ts` (decoder-frame delegation).
