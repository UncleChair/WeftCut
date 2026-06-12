# float16 working space: one composite, two sinks — exploration + probe plan

Status: **probes RUN 2026-06-12 (results below); design + implementation
landed on branch `feat/10bit-export`.** The loopback-WebSocket export
sink and `TenBitIngest`/`PackYuv420p10`/`TenBitFrame` pipeline
described in the decision tree below are implemented and gate-passing;
this spec is the graduated probe record. ADR 0021 (color converges at
ingest; working space = output space) remains the current model with
the f16 composite as its export-path realization. Probe vehicle:
`apps/desktop/e2e/tools/float16_probes.e2e.js` (re-runnable; H.264
Hi10P fixture variant generated as
`fixtures/media/probe_1080p_gradient10_h264.mp4`).

## Why this exists

The export's output ceiling is WebCodecs' encoder: 8-bit only,
resolution-default BT.709 tags, no HEVC software encoder (ADR 0014).
Two findings reframed how to lift it:

1. **WASM encoders are a dominated option.** Surveyed (knowledge-based,
   web verification pending): ffmpeg.wasm et al. are feasible in pure-web
   products, but WeftCut already ships the strictly-better native exit —
   `export/hwencoder.rs` (TargetCodec × NVENC/QSV/AMF probing, libx265 /
   libsvtav1 software fallbacks, Gyan full build = Main10-capable) and a
   production stdin-pipe pattern (`export_audio_only` feeds f32le PCM to
   ffmpeg). A rawvideo variant of that pipe gives the full native encoder
   menu with none of WASM's costs (no 4GB wasm32 ceiling, no COOP/COEP
   work, no GPL/patent change to the bundle since ffmpeg-sidecar is a
   runtime user-side download, full assembly speed).
2. **The encoder is not the gate — the 8-bit composite is.** Pixi
   composites in RGBA8 and the `VideoClipSprite` snapshot canvas is
   8-bit, so 10-bit source precision dies before any encoder sees
   pixels. Swapping the encoder alone buys only: codec menu freedom,
   full color-tag control, and encode-domain 10-bit (encoding 8-bit
   content in Main10 to reduce banding accumulation — worth having,
   not the real prize).

The web platform has since grown the surfaces that remove the gate:
WebGPU `rgba16float` render targets (core spec: renderable, blendable,
readable), float16 2D canvas (`colorType: 'float16'`), WebCodecs
high-bit-depth pixel formats (our Hi10P probe already sees `I420P10`
frames in WebView2), and WebGPU HDR canvas
(`toneMapping: {mode: 'extended'}`).

## The hypothesis: one float16 composite, two sinks

Key unlock: **export never needs the visible canvas**, so the
hard-locked 8-bit swap chain only constrains preview display — which
legitimately stays tone-mapped SDR on SDR glass anyway.

```
ingest (per-source chokepoints)
  10-bit sources: copyTo → r16 planes → explicit YUV→RGB shader   [owned params]
  8-bit sources:  unchanged (createImageBitmap / drawImage snapshot)
        │
        ▼
ONE float16 offscreen composite (Pixi scene graph, RGBA16F render target)
  - intermediate rounding (blends, gradients, effect chains) gone for
    8-bit sources too
        │
        ├─► EXPORT SINK: output transform (709 SDR now; 2020 PQ later)
        │     → GPU compute pass packs float16 RGB → P010 planes
        │       (1080p ≈ 6 MB/frame vs 16 MB raw RGBA16F)
        │     → copyTextureToBuffer readback → IPC → ffmpeg stdin
        │       (-f rawvideo, x265 Main10 / SVT-AV1 10-bit; encoder
        │        selection = existing hwencoder.rs)
        │
        └─► PREVIEW SINK: output transform → visible canvas
              SDR glass: tone map + DITHER → 8-bit swap chain
                (perceptual 10-bit on any panel — the pro-app standard)
              HDR glass: rgba16float canvas + toneMapping 'extended'
                (bypasses Pixi's canvas config; gated on probe P5)
```

Consequences if the probes pass:

- **ADR 0021 evolves exactly as its revisit trigger describes**: ingest
  converges into a wide working space; the output transform becomes an
  explicit second chokepoint per sink. The discipline (explicit, gated
  chokepoints) is unchanged.
- **preview-equals-export strengthens**: same composite, different
  output transforms, arbitrated by the conformance analyzer (Axis B
  gradient tooling counts distinct steps — the existing
  `media_conformance --gradient-row` is the 10-bit truth meter).
- **The post-v1 "native Rust export backend" shrinks** from "rewrite
  the compositor in wgpu" to "native encode exit + float16 composite":
  the entire Pixi scene graph (sprites, Motifs, effects-to-be) is
  reused. Do not amend the roadmap until probes confirm.
- Preview ring grows a second ingest lane: ImageBitmap is itself an
  8-bit chokepoint, so 10-bit sources need copyTo → r16 textures in
  the ring too. `copyTo` + immediate close satisfies ADR 0004's
  pool-drain requirement the same way createImageBitmap does. Sizing:
  P010 1080p ≈ 6 MB/frame; a 1.5 s ring ≈ 280 MB — same order as
  direct-preview ImageBitmaps today; 8-bit sources keep the
  ImageBitmap lane.

## Probes (run before any design work)

Ordered by how much each result decides. The e2e tool harness
(`apps/desktop/e2e/tools/*.e2e.js`, cf. `iso_importexternaltexture` /
`diag_color_fullrange`) is the vehicle for P1–P5.

| # | Probe | Question it settles | Method | If it fails |
|---|-------|--------------------|--------|-------------|
| P1 | `VideoFrame.copyTo()` of an `I420P10` frame | Can 10-bit pixels reach our memory at all? | Decode the Hi10P/Axis-B fixture, `copyTo` with the frame's native format, assert plane sizes + >8-bit sample values | 10-bit ingest is dead in-webview; only encode-domain 10-bit remains (8-bit composite → Main10 encode) |
| P2 | Pixi 8.18 float16 render target | Can the composite be RGBA16F without forking Pixi? | Create a RenderTexture with `format:'rgba16float'`, render a shallow gradient, read back, count distinct steps >256 | Custom final-composite pass (Pixi renders groups; one bespoke pass composites into float16) — more work, not fatal |
| P3 | Readback + IPC throughput | Is the export exit fast enough? | `copyTextureToBuffer` → Tauri IPC → Rust, MB/s benchmark at 1080p/4K P010 sizes. Merge with the route-B rawvideo spike (1080p30 P010 realtime ≈ 190 MB/s; ≥0.3× realtime ≈ 60 MB/s acceptable for offline) | Batch frames / shared-memory transport (localhost socket) before declaring dead |
| P4 | float16 2D canvas `drawImage` precision | Does the minimal-change snapshot route preserve >8-bit? | `getContext('2d', {colorType:'float16'})`, drawImage a 10-bit gradient VideoFrame, `getImageData` (float16), count steps | Use the P1 copyTo route for 10-bit ingest (more code, fully owned) |
| P5 | WebView2 HDR glass | Can embedded WebView2 present extended-range at all? | HDR-mode Windows + HDR display: configure canvas `rgba16float` + `toneMapping:{mode:'extended'}`, render >1.0 values, verify visually + screenshot pipeline. **The one link with no web-standard guarantee in embedded WebView2 (DComp visual hosting)** | HDR preview = tone-mapped SDR (every NLE's default), or native presenter child window (scRGB FP16 swap chain) as the known-cost last resort — we left the libmpv native-window world deliberately |
| P6 | `importExternalTexture` 10-bit precision | Optional alternative ingest | Only if P1 *and* P4 both fail | — |
| P7 | float16 preview overhead on iGPU | Preview-sink cost | PerfHUD, later — only when the preview sink is actually built | preview-LOD flag (already planned for effects) |

Validation backstop for all of it: the Axis-B gradient fixture +
`media_conformance --gradient-row` distinct-step counting tells the
truth about whether 10-bit survived end-to-end; the color-conformance
gate (ADR 0014) guards the matrix/tags through the new chokepoints.

## Probe results (2026-06-12, real WebView2 149.0.4022.62, RTX 3050/ampere)

| # | Verdict | Evidence |
|---|---------|----------|
| P1 | **PASS for software-decoded 10-bit; FAIL for hardware-opaque frames** | H.264 Hi10P (SW decode): `format=I420P10`, `copyTo` native layout 6 220 800 B, mid-row max=944, **781 distinct** levels, tagged bt709/limited — true 10-bit in our memory. HEVC Main10 (HW decode): frame `format=null` (opaque); `allocationSize`/`copyTo` throw NotSupported, including with `{format:'I420P10'}` conversion requested; no SW HEVC decoder exists (`configure` rejects `prefer-software`). |
| P2 | **PASS with a ~20-line patch; stock Pixi 8.18.1 FAILS** | `RenderTexture.create({format:'rgba16float'})` is accepted end-to-end (TextureSource + GPUTexture both rgba16float, render pass targets RGBA16Float). But `GpuStateSystem.getColorTargets` **hardcodes `format:"bgra8unorm"`** into every pipeline and the pipeline cache key (`getGlobalStateKey`/`getGraphicsStateKey`) ignores the target format → validation failure, nothing draws. Overriding `getColorTargets` to emit the active target's format + resetting `_pipeStateCaches`/`_pipeCache` → custom-WGSL gradient mesh renders clean: readback **3072 distinct f16 steps** over a 4096-px 0→1 ramp (8-bit ceiling is 256), monotonic. Fix shape: derive format from the bound render target + fold it into the pipeline cache key — runtime patch or upstream PR, NOT a bespoke composite pass. |
| P2b | **PASS — STOCK Pixi WebGL2 backend renders float16 with no patch** | Same probe on `preference:'webgl'`: `EXT_color_buffer_float` present, render clean, readback **3072 distinct f16 steps**, monotonic. The bgra8unorm hardcode is WebGPU-pipeline-specific; GL attachments follow the texture format natively. The export worker owns its renderer instance (`exportWorker.ts` `preference:"webgpu"`) — flipping the f16 composite to WebGL2 is a config-level change with zero library patches. |
| P3 | **GPU readback is a non-issue; Tauri IPC is the bottleneck, ~0.3× realtime. Implementation-time: loopback WebSocket measured 83 MB/s (first run, discard mode) → 100 MB/s (post-hardening re-run) on this machine — within the offline band; shipped as primary with raw-invoke IPC fallback.** | Readback: RGBA16F texture 3.6–5.6 GB/s, P010-sized buffer 1.7–5.3 GB/s (1080p ≈ 293 fps). IPC `writeFile(append)` (the export's production streaming pattern): **63–77 MB/s** across runs (1080p and 4K chunks alike — throughput-bound, so batching frames per call won't help). Combined readback→copy→IPC pipeline: **50–60 MB/s ≈ 8.5–10 fps** at 1080p P010 — straddles the 60 MB/s offline floor, far from 190 MB/s realtime. Transport spike result: loopback WebSocket (one-shot, discard-mode baseline) **83 MB/s first run → 100 MB/s post-hardening** on this machine (RTX 3050, Windows 11). UI-state overhead (selector + frame bookkeeping) reduces observed speed modestly below bare-discard numbers; the shipped pipeline uses the WebSocket as primary with raw-invoke IPC as fallback. |
| P4 | **FAIL — the snapshot route quantizes to 8-bit** | `getContext('2d', {colorType:'float16'})` + `getImageData(..., {pixelFormat:'rgba-float16'})` work (real `Float16Array` out), but `drawImage` of a 10-bit VideoFrame yields ≤**256 distinct** levels for both the SW I420P10 frame and the HW opaque frame — Chromium rasters VideoFrame→2D canvas through an 8-bit intermediate. 10-bit ingest must use the P1 copyTo→r16-planes route (or P6 for HW frames). |
| P5 | **Programmatic half PASS; glass on this machine is SDR** | `configure({format:'rgba16float', toneMapping:{mode:'extended'}})` accepted and echoed verbatim by `getConfiguration()`; swapchain texture stores r=4.0/g=2.0 unclamped. `matchMedia('(dynamic-range: high)')` = false (no HDR display attached/enabled) — the visual presentation check still needs HDR-mode Windows + HDR glass. No programmatic rejection anywhere. |
| P5b | **WebGL cannot present HDR — storage yes, presentation no** | WebGL2 (`EXT_color_buffer_float` enabled): `drawingBufferStorage(RGBA16F)` works — backbuffer becomes RGBA16F and stores r=4.0 unclamped. But there is NO presentation control: `drawingBufferToneMapping` (the WebGPU-toneMapping twin, Khronos WebGL PR #3668) is `undefined` — the spec PR is still open/unshipped — and `configureHighDynamicRange` doesn't exist; the compositor tone-maps the float backbuffer to SDR. 2D canvas: `toneMapping:{mode:'extended'}` request is **silently downgraded** to `standard`. **HDR presentation on this runtime = WebGPU canvas only.** Consequence: export-side 10-bit needs no HDR glass and ships on WebGL stock; when HDR *preview* turns on, the composite must move to WebGPU too (no cross-API texture sharing — a WebGL composite can't feed a WebGPU canvas without a CPU/8-bit round-trip), which is when the Pixi WebGPU patch/upstream fix becomes load-bearing. |
| P6 | **Now relevant for HEVC originals** | P1's HW-opaque finding makes `importExternalTexture` (or proxying HEVC sources to Hi10P/another SW-decodable 10-bit form) the open question for 10-bit HEVC ingest. Not yet run. |

Caveats: P3 numbers include Defender-scanned temp-file disk writes (disk
is not the bottleneck — NVMe sequential ≫ 77 MB/s — but a pipe-to-ffmpeg
sink may differ a little in either direction). P1/P4 used the Axis-B
gradient fixtures; distinct-step counting is the meter throughout.

## Decision tree after probes

- **P1+P2+P3 pass** → the in-webview 10-bit export variant is real;
  rescope the roadmap's native-backend item to "native encode exit",
  full Pixi reuse. P4 just picks the cheaper ingest implementation.
  — **This is the branch we're on, with two qualifiers**: (a) P2 needs
  the small Pixi format-override patch *only on the WebGPU backend* —
  P2b shows the WebGL2 backend works stock, so the export composite can
  ship patch-free on `preference:'webgl'` while the upstream fix lands;
  (b) P3
  is only ~0.3× realtime over the current IPC — a transport spike
  (localhost socket / shared memory) is a prerequisite work item, and
  P6 is needed before 10-bit *HEVC* originals can ingest (Hi10P H.264
  ingests today via copyTo).
- **P4 fail** (it did) → ingest uses the P1 copyTo route; the
  minimal-change snapshot canvas is off the table for 10-bit.
- **P5 pass** → in-webview HDR preview is real; the two-sink design
  carries HDR end-to-end with no native presenter. — **Programmatic
  half passed; visual half blocked on HDR hardware**, so HDR preview
  remains tone-mapped SDR until verified on real HDR glass.
- **P1 or P2+fallback fail** → did not fire; the native-backend
  rewrite stays shrunk to "native encode exit".

## Priority note

None of this changes today's ordering: SDR delivery is the product,
the float16/HDR work remains gated behind the HDR-deliverable trigger
(roadmap post-v1). What changed is the *shape* of the work when that
trigger fires — and the probes are cheap enough (each ≤ half a day,
P1 is minutes) to run opportunistically before then. The standing
near-term candidates that fall out of this exploration, independent of
HDR: the route-B rawvideo spike (encoder menu + tag control with an
8-bit composite) and the ingest tone-map for HDR sources
(proxy-time `zscale`/`tonemap`/dither — see ADR 0021's tolerated-gap
note), both of which work without any float16 machinery.
