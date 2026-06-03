---
status: accepted
---

# Export color: matrix-honoring decode + perceptual conformance metric

A non-BT.709 source (e.g. a BT.601 / smpte170m clip) must export with its colors
intact. Two facts about the WebCodecs pipeline shape how that is achieved and how
it is measured.

## The decode side honors the source matrix; the encode side cannot preserve it

The export decodes a source frame, composites it on an sRGB canvas, captures the
canvas, and re-encodes. The color outcome depends on two conversions:

1. **YUV→RGB at decode.** The decoder is configured with the source's color tags
   (`withDefaultColorSpace` layered over the ffprobe-extracted matrix/range), so
   it emits a correctly-tagged frame — verified: a 601 source yields a frame
   tagged `smpte170m`. But PixiJS uploads that frame to a texture via WebGPU
   `copyExternalImageToTexture`, which **ignores `VideoFrame.colorSpace`** and
   converts every frame as BT.709. A 601 frame uploaded that way is mis-converted
   (wrong RGB on the canvas). The fix: `VideoClipSprite` routes the frame through
   a 2D-canvas `drawImage` first, which **does** honor the frame's matrix, then
   binds the already-correct RGBA canvas. Preview was always correct because it
   uploads `createImageBitmap` output (also matrix-honoring); only export bound
   the raw `VideoFrame`.

2. **RGB→YUV at encode.** WebView2's WebCodecs H.264 encoder — hardware **and**
   software — **ignores the input frame's `colorSpace` and writes a
   resolution-based default tag** (BT.709 for HD). There is no `colorSpace` field
   on `VideoEncoderConfig`, and tagging the captured frame has no effect. So the
   export **cannot emit a 601-tagged HD file**: a 601 source is faithfully
   *normalized* to BT.709 (standard for HD), costing only codec round-trip loss.

So the colors are preserved; the container's matrix tag is normalized to 709.

## The conformance gate measures displayed color, not the matrix tag

Because the output is legitimately 709-tagged, a matrix-roundtrip check — force
both output and source to the source's matrix, then compare — measures the *tag
relabel*, not the colors. It reports the same error whether the pixels are right
(the fix above) or wrong (the Pixi mis-convert), so it cannot validate the fix or
catch a regression.

The gate instead uses a **perceptual** metric (`media_conformance --color`):
decode the **output by its own embedded tag**, decode the **source forced to its
matrix/range** (fixtures carry only a matrix tag, so guessing is unstable), and
compare the displayed RGB. This asks the right question — *does the export show
the same colors as the source?* — and is discriminating: a faithful 601→709
export scores ≈0 (worst channel 2 codes), a decode-side matrix bug scores large,
and a full→limited **range** squash scores large.

## Consequences

- `709ltd` and `601ltd` are faithful (`worst_app_max` 0 and 2). The decode-side
  `drawImage` fix is load-bearing: reverting it scored ~22 (PSNR 22.6 dB vs
  42 dB), confirming Pixi's upload drops the matrix.
- `709full` / `601full` remain known-bad: their output is limited-range (tv)
  while the source is full-range (pc) — a real pc→tv squash (verified via
  ffprobe). The suspected cause is the full-range proxy re-encode dropping full
  range (full-range sources are expected to route through a proxy), not directly
  confirmed here — a real loss the original-decode path does not touch (the
  deferred proxy-color slice). They assert `worst_app_max > faithfulMax` and flip
  red when it is addressed.
- Preserving the source matrix tag in the output would require encoding outside
  WebCodecs (a Rust ffmpeg re-encode) purely to relabel HD to a non-standard
  matrix — rejected as a bad trade.
- The zero-copy decode path (`importExternalTexture`, which also honors the
  matrix and would drop the per-frame `drawImage` blit) is tracked in the
  roadmap, not built here.
