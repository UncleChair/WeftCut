# 10-bit export pipeline: f16 composite + native encode exit — design

Status: **design approved 2026-06-12; implementation plan pending.**
Successor to the probe phase of
`2026-06-12-float16-pipeline-exploration.md` (results table there; probe
vehicle `apps/desktop/e2e/tools/float16_probes.e2e.js`). ADR 0021's
discipline (explicit, gated chokepoints; working space = output space)
carries through unchanged.

## Scope

Ship 10-bit video export (HEVC Main10 / AV1 10-bit) through a float16
offscreen composite and a native ffmpeg encode exit. The existing 8-bit
export pipeline stays byte-for-byte unchanged and remains the default.
HDR **preview** is explicitly deferred until PixiJS supports
per-render-target formats on WebGPU upstream (or we adopt the verified
runtime patch) — this design only keeps the per-sink output-transform
seam open for it.

## Decisions (settled)

| Decision | Outcome |
|----------|---------|
| Export composite backend | Pixi **WebGL2**, stock 8.18.1 (probe P2b: rgba16float render targets work unpatched; the bgra8unorm hardcode is WebGPU-pipeline-only). Preview untouched: WebGPU, 8-bit, SDR. |
| Exit transport | **localhost WebSocket** to an in-process Rust sink (one-time token, ephemeral port). Implementation step 1 is a throughput spike, target ≥ 190 MB/s (1080p30 P010 realtime); probe P3 measured raw-invoke IPC at 63–77 MB/s, which stays as the runtime fallback. |
| HEVC Main10 sources | v1: ingest via the existing 8-bit path into the f16 composite (HW decode yields opaque `format=null` frames — probe P1 — so copyTo can't reach them). A Rust-side "10-bit conform" transcode (→ Hi10P intermediate) is the named fast-follow. |
| Trigger | Export Settings gains `bitDepth: 8 \| 10` (selectable only for HEVC/AV1). Smart default: preselect 10 when the timeline contains a 10-bit-ingestable source and the codec supports it. 8-bit or H.264 → current pipeline, unchanged. |
| Working space (v1) | **Display-referred, gamma-encoded BT.709 values in float16.** No linear-light blending — preserves preview-equals-export against the 8-bit preview. Linearization is an HDR-phase question. |
| 10-bit H.264 output | Not offered (compatibility). |

## Data flow (bitDepth = 10)

```
sources
├─ 10-bit SW-decodable (Hi10P now; AV1-10bit probed at impl time)
│    ExportDecoderPool decodes the ORIGINAL
│    decoder output callback: copyTo(ArrayBuffer) + frame.close() immediately
│      (CPU-plane lane — satisfies ADR 0004's pool-drain rule outright)
│    → upload 3 planes as R16UI GL textures
│    → YUV→RGB conversion pass (BT.709 matrix, range from owned mediaColor params)
│    → per-clip RGBA16F texture; VideoClipSprite binds it directly
│      (bypasses the 2D-canvas snapshot — probe P4 proved drawImage quantizes)
└─ 8-bit / HEVC Main10 / everything else: existing snapshot ingest, unchanged
        │
        ▼
Pixi WebGL2 Compositor (export worker, preference:"webgl")
renders into an RGBA16F RenderTexture at composition size
(the OffscreenCanvas remains only as the GL context host)
        │  (encoder dims < comp dims → second f16 RT blit)
        ▼
PackP010: fragment byte-pack passes → RGBA8 target(s), each texel = 2 bytes
of u16LE samples → readPixels(UNSIGNED_BYTE) — byte-exact, 1080p ≈ 6.2 MB/frame.
The pack pass IS the v1 output transform: RGB→YUV BT.709 limited + 10-bit
quantize.
        │
        ▼
WebSocket → 127.0.0.1 → Rust ExportVideoSink
→ ffmpeg-sidecar stdin: -f rawvideo -pix_fmt yuv420p10le -s WxH -r fps
  encoder selection = existing export/hwencoder.rs
  (HEVC: NVENC Main10 → QSV → AMF → libx265 main10; AV1: libsvtav1 10-bit)
  full color-tag control: bt709/limited on the output
→ temp video file → existing audio mux flow, unchanged → deliverable
```

WebCodecs `VideoEncoder`, the `new VideoFrame(canvas)` capture, and the
fMP4 postMessage/writeFile chain do not participate in the 10-bit lane.

## Components

Each unit has one purpose, a narrow interface, and independent tests.

- **`TenBitIngest`** (worker, new) — I420P10 plane buffers → three R16UI
  textures → conversion pass → per-clip RGBA16F texture.
  `ExportDecoderPool` grows a CPU-plane lane: for >8-bit decoder output
  formats the ring stores `{planes, layout, ptsUs}` instead of
  VideoFrames; `waitForPts`/eviction bookkeeping unchanged.
- **`PackP010`** (worker, new) — f16 RenderTexture → byte-pack
  pass(es) → `readPixels` → `Uint8Array` in `yuv420p10le` layout.
  Matrix + quantization coefficients locked by CPU golden-vector unit
  tests.
- **`ExportVideoSink`** (Rust, new) — commands
  `export_video_sink_start` (bind WS, spawn ffmpeg with hwencoder.rs
  args, return port+token) / `export_video_sink_write` (IPC fallback
  path only) / `..._finish` (close stdin, await encode, return temp
  path) / `..._cancel` (kill ffmpeg, release port). Ordered frames,
  app-level backpressure (ack or bufferedAmount threshold — plan
  detail).
- **Settings / routing glue** — `bitDepth` in `export.json` + dialog
  (HEVC/AV1 only) + size estimator; media gains a
  `tenBitExportCapable` determination (v1 rule: 10-bit pix_fmt ∧ codec
  = H.264; AV1 added behind an implementation-time decode probe).

## Known landmines (designed-for, not discovered-later)

1. **SW 10-bit reorder-tail deadlock** — the reverted 2026-06-04
   10-bit DirectExport failure: software 10-bit decoders hold their
   reorder tail until `flush()`, and the chunked no-mid-flush export
   model wedges (proven 10-bit-software-specific; 8-bit passes
   300/300). The new lane adopts that note's fix shape at chunk
   boundaries (feed next-GOP lead-in frames, or boundary flush for the
   CPU-plane lane — flushing is cheap here because frames are copied
   out and closed immediately, so flush-induced output bursts don't
   pin the hardware pool). A dedicated B-frame 10-bit e2e gate guards
   the regression.
2. **Backend divergence** — 8-bit exports (WebGPU) vs 10-bit exports
   (WebGL) of the same project may differ at sub-pixel rasterization
   level. Accepted; the conformance analyzer (frame-align + SSIM)
   arbitrates.
3. **`readPixels` is synchronous** — acceptable first (P3 showed the
   exit has large GPU-side headroom); if profiling says otherwise,
   WebGL2 fence + `getBufferSubData` gives async readback. Plan keeps
   it simple-first.
4. **WS throughput unverified** — the spike gates the transport. Miss
   ⇒ try batched fetch-POST; still miss ⇒ ship on raw-invoke IPC rates
   with the export UI stating reduced speed.

## Error handling / degrade ladder

- Socket bind/connect failure → transparent fallback to
  `export_video_sink_write` raw-invoke chunks (same Rust sink).
- No 10-bit encoder: practically unreachable (ffmpeg-sidecar's full
  build always carries libx265/libsvtav1); ffmpeg-missing errors
  surface exactly like today's HEVC transcode path.
- Cancel: existing worker cancel + sink `cancel` (kill ffmpeg, delete
  temp).
- 10-bit requested but no 10-bit-capable source: allowed (encode-domain
  10-bit still reduces banding accumulation from the f16 composite);
  the smart default simply doesn't preselect it.

## Validation

- **Spike e2e tool**: WS loopback throughput webview→Rust (gate
  ≥ 190 MB/s).
- **Unit**: PackP010 golden vectors (known RGB f16 → expected 10-bit
  YUV words), conversion-matrix coefficients both directions.
- **E2E gates** (real WebView2, wdio):
  - `export_10bit.e2e.js`: Axis-B gradient fixtures through a full
    10-bit export; `media_conformance --gradient-row` distinct-step
    count > 600 (of ~877) proves 10-bit survived end-to-end; ffprobe
    asserts `yuv420p10le`/Main10 + bt709/limited tags.
  - B-frame 10-bit fixture export (reorder-tail deadlock regression).
  - `probe_1080p_gradient10_h264.mp4` is promoted into the generated
    fixture matrix (`generate.go` gains an `--gradient-h264` variant).
- **Regression**: the existing 18-spec e2e suite stays green — the
  8-bit path is untouched by construction.

## Out of scope (v1)

HDR preview (waits on Pixi upstream per-target formats + HDR glass;
probe P5b: WebGL cannot present extended-range — `drawingBufferToneMapping`
unshipped — so HDR preview will require the WebGPU path when it comes).
HEVC Main10 10-bit conform. Any preview-side change. Linear-light
working space. Filters/TexturePool format-awareness (no filters in the
export composite). 10-bit H.264 output.

## References

- Probe results: `2026-06-12-float16-pipeline-exploration.md` (P1–P6
  table) + `apps/desktop/e2e/tools/float16_probes.e2e.js`.
- Reorder-tail fix shape: memory note `project_10bit_direct_export`
  (10-bit DirectExport attempt, reverted 2026-06-04).
- Encoder probing: `src-tauri/src/export/hwencoder.rs`.
- Pixi upstream: issue pixijs#12019, PR pixijs#12020 (global-static
  shape); our per-target derivation PR is tracked separately and is
  NOT a dependency of this design.
