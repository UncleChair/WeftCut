---
status: accepted
---

# 10-bit export uses a float16 composite and a native ffmpeg encode exit

## Context

The 8-bit export pipeline composites in RGBA8 and snapshots each frame
through a 2D canvas, so 10-bit source precision dies before any encoder
sees pixels. The encoder itself was a second ceiling: WebCodecs' encoder
is 8-bit only, tags HD output BT.709 by resolution default, and has no
HEVC software path (ADR 0014). Lifting 10-bit delivery therefore meant
fixing two things at once — a wider composite and a different encoder —
not just swapping the encoder.

A round of probes (the 2026-06-12 float16 pipeline exploration, since
retired) settled the shape:

- **WebGL2 renders `rgba16float` render targets stock.** PixiJS's WebGPU
  backend hardcodes a `bgra8unorm` pipeline color target and would need
  an upstream patch; the WebGL2 backend honors the render-texture format
  directly, with no fork. The export Worker owns its own renderer, so it
  can pick the backend per bit depth.
- **The encode exit's bottleneck is the webview↔Rust transport, not the
  GPU.** Readback of a packed `yuv420p10le` frame is GB/s; a loopback
  WebSocket to a Rust sink sustains ~80–100 MB/s on the dev machine —
  below realtime but acceptable for offline export, and far past a
  raw-invoke IPC fallback.
- **Chromium/Electron has no hardware Hi10P decode**, only software. 10-bit pixels
  do reach our memory via `VideoFrame.copyTo` of software-decoded I420P10
  frames; opaque hardware-decoded frames (HEVC Main10) cannot `copyTo`.
- **HDR preview is blocked on the web platform.** WebGL cannot present
  extended-range (`drawingBufferToneMapping` is unshipped); only a WebGPU
  canvas with `toneMapping: 'extended'` can, which would require the Pixi
  upstream per-target-format work plus real HDR-glass verification.

## Decision

When the export settings select **bit depth 10** (HEVC Main10 or AV1
only — H.264 stays 8-bit):

- The export Worker composites on the **WebGL2** backend into an
  `rgba16float` `RenderTexture`.
- **10-bit-capable sources** (H.264 Hi10P originals, identified by an
  ffprobe-metadata rule: codec h264 + pix_fmt yuv420p10le) ingest through
  a CPU-plane lane — `VideoFrame.copyTo` into an `I420P10` buffer, close
  the source frame immediately (ADR 0004 buffer-pool discipline), then an
  RG8→f16 GLSL conversion pass. 8-bit sources keep the snapshot ingest but
  composite into the same f16 target, gaining intermediate-rounding
  precision.
- A GPU byte-pack pass (`PackYuv420p10`) applies the BT.709 limited-range
  matrix + 10-bit quantization and writes `yuv420p10le` planes; the buffer
  streams over a one-shot loopback WebSocket to a Rust sink
  (`export/videosink.rs`) that pipes `ffmpeg -f rawvideo` into the probed
  Main10 encoder (`encoder_registry.rs`). Raw-invoke IPC is the fallback
  transport.

**The working space stays display-referred, gamma-encoded BT.709.** The
f16 composite is a precision-preserving carry of the already-encoded
signal, NOT a linear-light scene space. This is exactly the named revisit
trigger of ADR 0021 (color converges once at ingest; working space =
output space) realized for the export path: ingest still converges color,
the output transform is the second explicit chokepoint, and the
discipline is unchanged. The 8-bit export path is untouched.

## Consequences

- Real 10-bit HEVC/AV1 delivery with full color-tag control, verified
  end-to-end on a real Hi10P source (`Main 10 / yuv420p10le / bt709 / tv`).
  The conformance gradient meter confirms the precision survives ingest →
  composite → pack → encode.
- The post-v1 "native Rust export backend" shrinks from "rewrite the
  compositor in wgpu" to "native encode exit + f16 composite" — the entire
  PixiJS scene graph (sprites, Motifs, effects-to-be) is reused.
- Software 10-bit decode is slow; the export-settings UI warns that 10-bit
  export runs well below realtime. The ring high-water is entry-count
  based (a byte-based cap is the 4K follow-up).
- **Deferred (gate on the HDR-deliverable trigger, tracked post-v1):**
  HDR preview (WebGPU `rgba16float` canvas + Pixi
  per-target formats / runtime override + HDR-glass verification) and a
  wider-gamut/linear working space. **Open in the 10-bit bucket:** HEVC
  Main10 source conform (HW-opaque frames transcoded to a Hi10P
  intermediate so they ingest at full precision), an AV1-10 source decode
  probe, and the byte-based ring cap for 4K.

## Addendum (2026-06-13)

Three consequence-section facts moved after this ADR was accepted; the
decision itself is unchanged:

- **The "~80–100 MB/s, below realtime" transport figure was a dev-profile
  artifact, not a WS design property.** The receiver (tungstenite) ran at
  opt-level 0 in dev builds; release builds always sustained ~330 MB/s.
  With `[profile.dev] opt-level = 1` (a per-package override does not work —
  the read path monomorphizes into the caller's crate), the dev-build
  transport measures ~293 MB/s: above the 186 MB/s 1080p30 realtime bar.
  4K (~750 MB/s) remains beyond it; byte reduction (dense 10-bit packing)
  is the lever there.
- **AV1 10-bit sources are admitted** alongside Hi10P: dav1d under
  prefer-software decodes to copyTo-able I420P10, while the hardware path
  "succeeds" with opaque `format=null` frames — making the lane's
  prefer-software flag a correctness requirement for AV1.
- **The ring cap is resolution-derived**, replacing the flat 48-entry
  high-water: a per-ring byte target over the first frame's actual plane
  bytes, clamped to an entry floor/ceiling. 4K bounds at ~500 MB (entry
  floor) instead of ~1.2 GB.
- **v1 10-bit export ships as an experimental feature.** The export-
  settings UI labels the 10-bit option experimental and gates the export
  click behind an explicit confirmation. The driving caveat is preview
  fidelity: HDR/wide-gamut preview is unavailable on the web platform
  (the preview stays 8-bit/SDR per the Context section), so what the user
  sees **cannot be guaranteed to match** the 10-bit output — colors and
  gradients may differ. Compounding hazards: software 10-bit decode runs
  below realtime (4K especially), and HEVC Main10 source conform is still
  pending (HW-opaque originals get transcoded). The lane stays selectable;
  it is flagged, not removed.

Current state lives in `docs/render.md` ("Encode exits"); the remaining
follow-ups are tracked in the post-v1 backlog issue.

## References

- ADR 0021 — color converges at ingest; working space = output space
  (this ADR is its export-path revisit-trigger realization).
- ADR 0014 — export color perceptual conformance (the encoder ceiling
  this lifts; the gradient meter that gates it).
- ADR 0004 — WebCodecs buffer-pool discipline (the copy-then-close rule
  the CPU-plane lane satisfies).
- `docs/render.md` — the evergreen description of both encode exits.
- The 2026-06-12 float16 pipeline exploration (since retired) — the probe
  record and the HDR/`importExternalTexture` findings that seed the
  deferred work.
