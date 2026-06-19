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
   tagged `smpte170m`. The decoder follows that config over the bitstream's own
   VUI (verified live: a pc/601-VUI proxy decoded under a bt709/limited config
   stamps bt709/limited on its frames), so the config must be right for BOTH
   decode targets:
   - **Originals** carry their ffprobe tags directly.
   - **Proxies** preserve the source's colorimetry but historically carried it
     only in the SPS VUI — and mediabunny reads only the mp4 `colr` atom, never
     the VUI, so `getDecoderConfig().colorSpace` came back null and the decode
     fell back to the bt709/limited resolution default. That misread full-range
     sources (pc decoded as tv: clip + stretch) and 601 proxies (601 decoded as
     709) — the gate's `709full`/`601full` failures. Two-layer fix: the proxy
     recipes assert the source's ffprobe tags + `-movflags +write_colr`
     (`source_color_args`, PROXY_FORMAT_VERSION 7 / quick-q4) so every proxy is
     self-describing via colr, AND the ffprobe `sourceColor` is threaded into
     proxy decodes too (`withDefaultColorSpace`'s per-field priority keeps the
     decode target's own colr tag above it), which also covers older colr-less
     cached proxies.

   But PixiJS uploads the decoded frame to a texture via WebGPU
   `copyExternalImageToTexture`, which **ignores `VideoFrame.colorSpace`** and
   converts every frame as BT.709. A 601 frame uploaded that way is mis-converted
   (wrong RGB on the canvas). The fix: `VideoClipSprite` routes the frame through
   a 2D-canvas `drawImage` first, which **does** honor the frame's matrix, then
   binds the already-correct RGBA canvas. Preview was always correct because it
   uploads `createImageBitmap` output (also matrix-honoring); only export bound
   the raw `VideoFrame`.

2. **RGB→YUV at encode.** Chromium's WebCodecs H.264 encoder — hardware **and**
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

- All four encodings are faithful and DirectExport from the original
  (`yuvj420p` — the full-range alias of yuv420p — is on the browser-friendly
  whitelist, so full-range H.264 skips the proxy hop entirely). The proxy
  self-description machinery still carries color for proxy-routed sources
  (HEVC/VP9/10-bit), guarded by a Rust integration test
  (`proxy_carries_source_color_tags_and_colr_atom`: tags + colr atom on a real
  ffmpeg round-trip). The decode-side `drawImage` fix is load-bearing:
  reverting it scored ~22 (PSNR 22.6 dB vs 42 dB), confirming Pixi's upload
  drops the matrix. A full-range export is still EMITTED limited-range (the
  WebCodecs encoder choice) — a correct pc→tv conversion, which the perceptual
  gate scores as faithful.
- Preserving the source matrix tag in the output would require encoding outside
  WebCodecs (a Rust ffmpeg re-encode) purely to relabel HD to a non-standard
  matrix — rejected as a bad trade.
- The zero-copy decode path (`importExternalTexture`, which also honors the
  matrix and would drop the per-frame `drawImage` blit) is tracked in the
  roadmap — deliberately parked at lowest priority pending profiling — and
  not built here.
