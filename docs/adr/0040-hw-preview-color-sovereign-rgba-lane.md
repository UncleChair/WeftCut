---
status: accepted
---

# The hardware preview lane ships native-converted RGBA, because color math and tag authority never delegate to the browser

## Context

The Windows hardware preview lane decodes with ffmpeg `d3d11va` and hands
frames to the renderer as shared D3D11 textures. It used to share the decoded
**NV12** directly, tagged with the source's colorimetry, and let Chromium's
`createImageBitmap` perform the YUV→RGB conversion in the preload. That put
both axes of the color trust model in the browser's hands: the **math** (which
matrix/range arithmetic runs) and the **tag authority** (which metadata wins
when container and bitstream disagree).

ADR 0032 already established for the software lane that buffer-defined YUV is
never browser-converted — Chromium software-converts buffer-frame NV12 as
BT.601 regardless of the stamped colorSpace, and its WebGPU ingestion paths
(`copyExternalImageToTexture` AND `importExternalTexture`) render a
601-tagged frame differently from the `drawImage` reference. The shared-
texture lane was the remaining exception, and two alternatives for its future
were rejected on the same constraint:

- **Native demux + WebCodecs decode** surrenders both axes: container-colr vs
  VUI precedence becomes Chromium-internal policy (ADR 0021's layering is
  inexpressible), and 10-bit/HDR is tone-mapped by Chromium's rules.
- **VideoFrame → `copyExternalImageToTexture` into Pixi's queue** drops
  `VideoFrame.colorSpace` outright (601 content renders wrong); adding
  `createImageBitmap` puts the read back on Chromium's device and reintroduces
  the cross-device barrier. No web API path is both zero-copy and free of
  browser color math.

Two probes made the chosen shape safe to build. The poc's Result 6 proved a
native matrix-only shader recovers the `drawImage` reference **to the byte**
through the very WebGPU path that mangles raw NV12. A follow-up probe proved
Electron's `importSharedTexture({pixelFormat:'rgba'})` is byte-exact end to
end — `copyTo` AND the production `createImageBitmap` call — on stride-hostile
patterns, with the sRGB-passthrough tag echoed intact on the `VideoFrame`.

## Decision

Native converts NV12→RGBA8 **on the decode device** with a session-owned
pixel shader, renders into the shared pool slots (now
`R8G8B8A8_UNORM` + `RENDER_TARGET`), and main imports them as `rgba` tagged
sRGB-passthrough (`{bt709, srgb, rgb, full}`). The browser is a byte mover:
`createImageBitmap` has no color decision left to make.

- **Constants derive, never hardcode.** The shader's coefficients come from
  Rust twins of the renderer's `coefForMatrix`/`inverseCoef` (yuv10.ts) and
  `Nv12Ingest`'s limited/full normalization, baked as `#define`s at session
  open from the stream's tags (`previewGpuOpen(matrix, fullRange)`), with
  golden unit tests pinning the four encodings. Both planes are point-sampled
  (nearest chroma upsample), matching `Nv12Ingest`, so the HW and SW lanes
  agree on the conformance charts.
- **Explicitly NOT `VideoProcessorBlt`.** The D3D11 video processor is faster
  but its math is driver-defined — it can neither be pinned to the goldens nor
  reproduced across machines, which fails the constraint this ADR exists to
  encode.
- **The ownership protocol hardened alongside** (orthogonal, but shipped
  together): every `frameReady` carries the slot's fill **generation**, the
  ack must echo it (ABA immunity over the busy-flag check), and the owner
  reclaims a delivered slot whose ack never arrives (3 s lease — one
  possibly-torn frame instead of a permanently wedged pool). The cross-device
  read barrier itself stays: read ordering is memory coherence, not color.
- **Cost is measured, not assumed.** The conversion pass is priced by GPU
  timestamp queries (`convertGpu` in `previewGpuTakeTimings`) and the pool's
  VRAM is reported live (`poolSlotBytes` native-side, `hwBudget().slotVram`
  across sessions, a `Pool VRAM` table in playback-perf) — RGBA slots are
  ×2.67 the NV12 bytes (a fully-subscribed admission cap ≈ 299 MB of pool).

The resident gates: `preview-hw-color.spec.ts` runs the four saturated charts
(709/601 × limited/full) through the forced `d3d11va` lane (worst patch-center
error measured 1–2/255 — the H.264 fixture's own quantization class; a wrong
matrix reads 10–30), and `preview-hw-conformance.spec.ts` gained the
`d3d11va` leg (natural-content SSIM ≥ 0.98) — the shared-texture channel's
first pixel-fidelity gates on Windows.

## Consequences

- 601/709 × limited/full are correct through the HW lane by the app's own
  arithmetic, gated, WYSIWYG-consistent with the software lane. The
  renderer's ingest treats the preview texture like any other RGB layer.
- Per-frame native work grows by one full-screen pass + a staging copy (the
  decoder's `BIND_DECODER` array slices cannot carry SRVs); per-slot VRAM
  grows ×2.67. Same-sitting playback-perf A/B against the NV12 path showed
  1080p×5 and 4K×2 equivalent (all criteria green both variants); the 4K×3
  cell is red in BOTH variants (decode-engine saturation, GPU vdec ~100%),
  i.e. the measured 4K ceiling of 2 concurrent tracks did not move.
- 10-bit preview stays out: Electron 42 has no 10-bit RGB integer
  `pixelFormat` (`rgba|bgra|rgbaf16|nv12|nv16|p010le`, runtime-verified) and
  hand-built P010 imports are null/black, so a future 10-bit lane must ride
  `rgbaf16` (64 bpp) — deferred, with the proxy path unchanged.
- If the shader constants and the renderer twins ever drift, the golden unit
  tests and the chart gates fail loudly — that coupling is the point.
