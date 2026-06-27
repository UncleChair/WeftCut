# Render

The PixiJS + WebCodecs renderer. One module produces every frame the
user ever sees — in the live preview surface and in the export
Worker. Preview pixels equal export pixels by construction.

This doc covers the architecture. For the preview-side mount + clock
+ transport see [`preview.md`](preview.md). For the audio export +
final mux see [`rendering.md`](rendering.md).

## Boundaries

- **In scope:** visual compositing — video clips, image overlays,
  text (including caption cues), color fills, transforms, opacity, blend
  modes, transitions.
- **Out of scope:** audio (the buffer-scheduled Web Audio preview mixer
  + Rust export mixer; [`audio.md`](audio.md)), file muxing (handled by
  ffmpeg `-c copy`), source probing / proxy generation / waveforms /
  thumbnails (all Rust-side).
- **Per-layer effects:** each layer carries an ordered `effects` chain of
  Pixi filters (v1: Blur). The compositor attaches them to the layer's
  sprite per frame; the renderer owns the filter *catalog*
  (`render/effects/effectRegistry.ts`) while the project state holds the
  effect *instances* and their keyframeable params (authored in the TS
  actor, mirrored to Rust for export). See
  [ADR 0027](adr/0027-per-layer-effects-pixi-filter-chains.md).

## Directory layout

```
apps/desktop/src/render/
  Compositor.ts              — PixiJS Application owner; per-frame composite
  clock.ts                   — audio-master clock (anchor-derived; wall fallback)
  PlaybackEngine.ts          — transport (play/pause/seek/scrub)
  decoder/
    SourceDecoderPool.ts     — per-clip VideoDecoder + ring; refcounted shared mediabunny Input per source; idle-dispose
    mediaInput.ts            — opens a mediabunny Input over a weftcut-media:// Range CustomSource (AssetRangeSource)
    PacketPump.ts            — single-flight async packet→decoder loop (getKeyPacket/getNextPacket)
    probeSourceDecodable.ts  — export pre-flight: can this machine's WebCodecs decode the original?
    FrameRing.ts             — 1 s lookahead / 0.5 s lookbehind per clip; stores ImageBitmap snapshots
    scrub.ts                 — debounced scrub coalescer (decode-during-drag)
  sprite/
    VideoClipSprite.ts
    ImageOverlaySprite.ts
    TextSprite.ts
    MotifSprite.ts           — binds a Motif's captured PNG frame as a texture
    ColorSprite.ts
  motifs/                    — Motif raster cache + frame descriptor helpers
                               (capture/cache pipeline covered in motifs.md)
  worker/
    exportWorker.ts          — Worker entry; imports Compositor against OffscreenCanvas
    encoder.ts               — VideoEncoder config + mediabunny Output mux into video.mp4
    protocol.ts              — postMessage protocol (start/cancel/progress/chunk/done)
  audio/
    AudioGraph.ts            — master bus (meter + soft limiter)
    AudioMixer.ts            — per-layer buffer-scheduled playback
    conformSource.ts         — VCONF Range reader (zero decode)
    chunkSchedule.ts         — pure scheduling math
    envelope.ts              — sampled-envelope contract (grid/fades in TS;
                               dB + keyframe math via the eval wasm leaf)
```

Audio architecture detail (conform cache, envelope contract, the Rust
export mixer): [`audio.md`](audio.md).

## Compositor

`Compositor` owns a PixiJS `Application` (or the headless equivalent
in the export Worker). Its public surface:

```ts
class Compositor {
  setProject(summary: ProjectSummary): void;
  setMediaSources(urls: Record<MediaId, string>): void;
  render(tUs: number): void;          // composite one frame at this time
}
```

Each call to `setProject` updates the sprite tree by diffing the
incoming layer set against the mounted sprites. New layers spawn a
Sprite of the right kind; removed layers dispose; surviving layers
get their `LayerSummary` patched in place. Z-order follows the
track + within-track index that the project summary already carries.

`render(tUs)` walks the mounted sprites in z-order. For each layer the
Compositor first resolves the view's `AnimTrack<T>` properties at the
layer-local time via `render/resolveView.ts` — numeric tracks through
`render/animated.ts`'s `resolveAnimated`, which calls the shared
`weftcut-eval` wasm (the SAME crate Rust links natively, so there is one
keyframe engine, not a hand-mirrored pair; [ADR 0025](adr/0025-shared-eval-wasm-leaf-crate.md));
color tracks statically until `Animated<Rgba>` lands in the leaf — then
hands the resolved scalar view to the sprite to update its texture /
position / opacity / transform / blend mode. The leaf resolves `EaseIn`,
`EaseOut`, and `Bezier{p1,p2}` through one WebKit-`UnitBezier` cubic
solver (Newton–Raphson with binary-search fallback), so named CSS eases
and arbitrary per-segment timing functions are identical in preview,
export, and Rust by construction. The golden-vector fixture
(`render/animatedGolden.fixture.json`) is now a single-source regression:
the TS suite (`animated.golden.test.ts`, through wasm) and the Rust leaf
test both assert the wasm/native engine reproduces it. (One JS
`unitBezier` copy remains in `animated.ts` for the curve-graph editor
overlay only.)

**Known limit:** the wasm preview holds at most 256 keyframes **per animated
property** (one `AnimTrack` — e.g. a single layer's opacity or x, NOT a whole
track or clip; mirrors `MAXKF` in `native/eval/src/wasm.rs`). It is a
static-allocation backstop for the no_std wasm, not a product limit — manual
authoring stays in the single digits. Beyond 256 the preview truncates while
native export still evaluates every keyframe, so the two would diverge;
`loadTrack` (`MAX_KEYFRAMES`) emits a one-time `console.warn` if a property ever
exceeds it. Revisit (an upstream per-property cap, or a linear-memory upload
path) only if dense/programmatic keyframes are ever generated.

### Keyframe easing authoring

Easing is shown and edited directly on the timeline. Each animated property's
keyframe sub-lane draws its value over time as a curve; focusing a property
expands its lane and exposes tangent handles on each keyframe (left = the
previous segment's outgoing control point, right = this segment's). Dragging a
handle edits that segment's `cubic-bezier`; right-clicking a keyframe or segment
opens a preset / Smooth menu. The curve follows the value, so which segment an
easing governs is read directly from the picture.

Each expanded sub-lane header also carries an After Effects-style keyframe
navigator — `◄ ◆ ►` — to the left of the property name. The arrows seek the
playhead to the previous / next keyframe of that property and select it; the
middle diamond toggles a keyframe at the playhead (filled when one sits there →
click removes it; hollow → click adds one at the current value), and is disabled
when the playhead is off the clip. The navigator acts on the focused clip, or
the sole keyframed clip when a track row spans several. Unlike the inspector
stopwatch, which turns a property's animation on or off, the navigator only adds
and removes keys on an already-animated property.

The same expanded sub-lane header also exposes the property's value at the
playhead as a compact, editable number field beside the navigator — on the
focused row only; collapsed rows stay navigator-and-label. Typing a value, or
stepping it with the arrows, writes a keyframe at the playhead (creating one if
none sits there, updating it if one does) — the same auto-key the inspector
performs — and the field is disabled when the playhead is off the clip. The
inspector's value rows and this timeline field are one shared control,
`KeyframeField`, driven by each property's descriptor (which widgets — number,
slider, readout — plus step and bounds); the inspector wraps it with the
stopwatch, the timeline renders it compact without one.

## Decoder pool

`SourceDecoderPool` is two-tiered. Decoders + frame rings are keyed
by `layerId` (one `SourceHandle` per clip), while the underlying
mediabunny `Input` + `EncodedPacketSink` (and the resolved
`VideoDecoderConfig` from `getDecoderConfig()`) live on a refcounted
`SourceMedia` keyed by `mediaId`. Multiple clips of the same source —
including overlapping copies on different tracks — each get their own
`VideoDecoder` / `FrameRing` / `PacketPump` but share one opened input.

A decoder is created on first `requestFrameAt(tUs)` against its
handle and reused for every subsequent request from that clip. The
hardware-decode fallback path stays the same as before:

- **First-frame error (output count = 0):** reset the decoder with
  `hardwareAcceleration: 'prefer-software'` and mark the handle as
  downgraded.
- **`'Codec reclaimed due to inactivity'`:** close + null the
  decoder, emit one LogBus warning, lazy-rebuild on next
  `requestFrameAt`.

Each handle's `FrameRing` caches the most recent 1 s lookahead /
0.5 s lookbehind. The ring is what the compositor reads — decoder
threads stay one step ahead of the playhead.

The ring stores `ImageBitmap` snapshots, not `VideoFrame`s.
`SourceHandle.output` runs `createImageBitmap(frame)` and closes the
source `VideoFrame` on resolve — this returns the WebCodecs hardware
decoder's buffer slot to its pool. Caching `VideoFrame`s directly
would pin the pool (~13 slots on common desktop GPUs) at the ring's
held count, exhaust it within a few frames, and stall the decoder
silently. The export-side `ExportFrameStore` keeps `VideoFrame`s
because its consumer closes them immediately after each encoded
frame, so the pool stays drained without snapshotting; both stores
satisfy a shared `FrameStore` interface that returns
`DecodedFrame = VideoFrame | ImageBitmap`. See ADR 0004.

Idle handles are disposed 5 s after the last `requestFrameAt` and
recreated on demand. The shared `SourceMedia` is freed only once its
refcount falls to 0 (the last referencing handle has disposed), at
which point the sample table + any resident GOP-block byte cache are
released.

### Byte handling

The source is never fully resident in memory. The mediabunny `Input`
reads through a `weftcut-media://` Range `CustomSource` (`AssetRangeSource`):
each read issues an HTTP `Range` request and returns exactly the
requested bytes. The `weftcut-media:` custom protocol handler (registered
in the main process) honors Range — the same path HTML5 `<video>` seeks
through — whereas a plain `fetch(url)` buffers the whole body before
exposing `body.getReader()`, defeating streaming.

One Range caveat: `AssetRangeSource.read` loops, re-issuing Range
requests until it has the exact byte count mediabunny asked for — a
single short read would hand the decoder truncated data and wedge it.

mediabunny owns the demux and byte cache; there is no resident sample
table and no manual block LRU (the prior mp4box era's `sampleAt` /
`ensureBlocksLoaded` / GOP-block cache are gone). The `PacketPump`
pulls packets via `getKeyPacket(tsSeconds)` / `getNextPacket(packet)`,
both of which `await` any uncached Range read natively — a cache miss
awaits the bytes instead of returning a transient null. The reset
decision (`decideReset`, ADR 0003) is synchronous and key-packet-free;
only the reset *action* fetches a key packet. See ADR 0002 for the
mediabunny demux/mux adoption.

### Why per-clip decoders

The pool used to key everything by `mediaId` — every clip of the
same source shared one decoder + ring. That assumed "only one clip
of a source is under the playhead at a time," which holds for
sequential cuts on a single track but breaks the moment overlapping
copies of one source appear on the timeline (a common A/B-roll
move). `Compositor.setAnchorTime` fires `requestFrameAt(srcTUs_i)`
for every clip under the playhead; with one shared ring, N
overlapping clips of the same media wrote N conflicting anchors per
tick, the ring evicted its own contents, and the decoder reset once
per overlapping clip per tick — observable as a continuous
`[weftcut/pixi] decoder reset:` log spam with no clip ever painting
a stable frame.

Per-clip decoders give each layer a stable anchor + lookahead at the
cost of a per-clip hardware decode session, well within the 8–32
concurrent sessions modern Windows H.264 / HEVC stacks expose.

### Future optimisation: shared decoder across sequential cuts

The cost the current design pays is cold-start latency at every cut.
Blade-splitting one clip into two layers gives each half its own
decoder, so playback crossing the cut warms a fresh decoder for the
second half (~100–300 ms first-frame). The pre-refactor design
happened to hide this because both halves rode one already-warm
decoder.

The optimisation is to detect "same `mediaId`, contiguous
source-time, sequential timeline-time" pairs at acquire-time and let
the second clip continue the first clip's `SourceHandle` across the
cut boundary instead of constructing its own. Constraints:

- Same `mediaId`.
- `layer_b.params.src_in_us` ≈
  `layer_a.params.src_in_us + (layer_a.t_end_us − layer_a.t_start_us)`
  (source-time stays contiguous across the cut, within one project
  frame).
- `layer_b.t_start_us` ≈ `layer_a.t_end_us` (timeline-time also
  contiguous within one project frame).
- Neither clip reverses, skips, or rate-changes the source (i.e.
  default `1.0×` forward playback only).

When all four hold, the cut is functionally a no-op for the decoder
and a single warm pipeline can serve both layers. When any
constraint fails — e.g. the user deliberately overlaps two cuts of
one source on different tracks for split-screen — the current
per-clip path applies.

v1 doesn't ship this. The "cold decoder at every cut" penalty is
acceptable for typical timelines; revisit if cuts dominate user
projects and the latency becomes user-visible during scrub or
preview.

## Scrub

`scrub.ts`'s `ScrubCoalescer` debounces drag input — a quiet-period
timer plus a max-wait ceiling, so an unbroken drag still re-targets the
decoder a few times a second instead of freezing on the last frame
until the user pauses. On a stable target the `PacketPump` resets to
the prior key packet (via `getKeyPacket`) and decodes forward to the
requested frame. The short proxy GOP (ADR 0008) bounds that to a few
frames, so each re-target lands within ~1 frame-time and decode-during-
drag works without churn.

## Sprite kinds

| Sprite | Source | Notes |
|---|---|---|
| `VideoClipSprite` | `FrameRing` snapshot → `Texture` | Consumes the `DecodedFrame` returned by `FrameStore.frameAt` — `ImageBitmap` from preview's `FrameRing`, `VideoFrame` from export's `ExportFrameStore`. Both are snapshotted into a sprite-owned canvas before upload (see the snapshot rule below). |
| `ImageOverlaySprite` | `createImageBitmap` / `ImageDecoder` → `Texture` | Two branches. **Still images:** one-shot `createImageBitmap` at sprite spawn; texture cached for the layer's lifetime. **Animated images (GIF, animated WebP, APNG, animated AVIF):** `decodeAnimatedImage` decodes all frames once via WebCodecs `ImageDecoder` (downscaled to composition size) and caches the resulting `DecodedAnimation` per `mediaId`. Each `render(tUs)` call selects the frame whose cumulative native delay covers `tInLayerUs mod totalDuration` (via `gifFrameIndexAt`) — looping at native speed to fill the layer. The same sprite class and the same `Compositor` run inside the export Worker, so export animation is inherent; the Worker awaits `preloadImages()` before starting the encode loop. |
| `TextSprite` | PixiJS `Text` (native canvas) | Shadow via drop-shadow filter; outline via stroke option; intro / outro presets are sprite-side animation. Caption cues imported from SRT/VTT/ASS files are ordinary `Text` layers and render through this same sprite — no separate subtitle path exists (see [`captions.md`](captions.md)). Bundled fonts (Liberation Sans, Noto Sans SC) are loaded into the export Worker before the encode loop so burned-in captions never tofu. |
| `MotifSprite` | CDP-captured PNG frame → `Texture` | Binds the Motif's frame for the playhead's layer-relative time (on demand, RAM lookahead, or persisted PNG); frames come from the webcap CDP capture path, not an in-process raster; see [`motifs.md`](motifs.md). |
| `ColorSprite` | PixiJS `Graphics` rect | Animated fill color. |

### Frame upload: the snapshot rule

**Never bind a raw `VideoFrame` to a Pixi texture.** Pixi's default
WebGPU upload (`copyExternalImageToTexture`) drops the frame's
`colorSpace` and converts every frame with a fixed BT.709/limited
formula. For a 601 or full-range frame that is a destructive pixel
mis-convert — wrong RGB values baked into the composite, which no
downstream re-tagging can repair — not a recoverable metadata error.
The browser's 2D-canvas paths (`drawImage`, `createImageBitmap`) do
honor the frame's matrix/range, so both surfaces route through one of
them before Pixi ever sees pixels:

- **Preview** converts at decode output: `SourceHandle.output` runs
  `createImageBitmap(frame)` (which also returns the decoder's buffer
  slot — ADR 0004), so the `FrameRing` already holds correct RGB.
- **Export** holds raw `VideoFrame`s for pool-drain reasons, so
  `VideoClipSprite` snapshots each frame into its sprite-owned
  `OffscreenCanvas` via a synchronous `drawImage` and binds the canvas.

ADR 0014 records the evidence: reverting the export snapshot scores
~22 on the perceptual conformance gate vs ≈0 with it. The zero-copy
alternative (`importExternalTexture`, which also honors the matrix)
is deliberately parked at lowest priority — see the roadmap.

The snapshot rule is one instance of the project-wide color model —
color converges once at an explicit, gated chokepoint and the rest of
the pipeline is color-naive (ADR 0021).

## Motifs

A Motif is a parameterized, time-varying web overlay (a lower-third, a
countdown, a title card). Because the export Worker has no DOM, a Motif is
captured to a bitmap on the **main process** for both surfaces: the export
Worker receives the bitmaps rather than producing them, so one capture path
feeds preview and export and preview-equals-export holds.

`MotifSprite` obtains the frame for the playhead's layer-relative time
(captured on demand, from a RAM lookahead ring, or from a persisted PNG
sequence) and binds it as a texture; the layer transform and opacity are
applied to the sprite. Capture drives the Motif's page to time `t` in an
offscreen Electron window and grabs a PNG via the DevTools Protocol
(`webContents.debugger`, `Page.captureScreenshot`) — a real browser raster.
The frame is byte-identical across runs and across OS at a fixed `t`, so the
cache holds one capture per frame index.

A Motif's `index.html` + manifest (+ optional `assets/`) are embedded in the
Rust binary and served to the host over the `motif:` URI scheme; see
`crate::motifs` (`native/src/motifs/`). The catalog is surfaced to the
renderer via the `list_motifs` command and the MCP `list_motifs` tool.

See [`motifs.md`](motifs.md) for the authoring contract, the capture harness,
and the raster cache.

## Export Worker

`exportWorker.ts` is the Worker entry. It receives:

- An `OffscreenCanvas` transferred from the main thread.
- A `structuredClone`d `ProjectSummary` + media asset URL map.
- A `VideoEncoderConfig` (built from
  `defaultEncoderConfig(width, height)` on the main thread).
- A time range `[startUs, endUs)`.

The Worker mounts a `Compositor` against the OffscreenCanvas, walks
the output frame grid for that half-open range, calls `render(tUs)` for
each frame, and captures each output `VideoFrame` with
`timestamp = tUs - startUs` so the encoded video starts at zero. The
grid uses the exact rational output fps (`frameGrid.ts`), not
`i * round(1e6 / fps)`, so trim tails and 29.97/59.94-style rates do
not drift or over-count.

Encoded chunks stream through mediabunny `Output` using an
`EncodedVideoPacketSource` and an append-only stream target. The Worker
posts each fMP4 slice as a `chunk` event and waits for a `chunk-ack` after
the main thread appends it to a temp `video.mp4`; this keeps long exports
off V8's single-ArrayBuffer size ceiling. Progress events fire on every
encoded frame; the final `done` event carries perf counters only, because the
file has already been streamed to disk.

The main thread then optionally awaits the Rust audio-only export into a
sibling temp audio file and asks Rust to mux or transcode into the user's
chosen output; see [`rendering.md`](rendering.md).

### Export decode pipelines (one per media × phase)

The Worker drives an `ExportDecoderPool` in ~2 s chunks: per chunk it
dispatches every needed packet per pipeline in one `decodeRange(aUs, bUs)`
call (no mid-export `decoder.flush()` — see the EOS-tail notes in
`ExportDecoderPool.ts`), then the encode loop awaits each output frame via
`ring.waitForPts` and evicts consumed frames to keep the WebCodecs
buffer pool drained.

Pipelines are keyed by `exportHandleKey` = `mediaId` + the clip's
timeline→source offset (`src_in_us − t_start_us`, the *phase*), and the
Worker groups the chunk's active clips by that key, dispatching ONE
merged source range per group:

- **Same phase** (a stacked copy, or trims of one pass through the
  source): every clip wants the same source PTS at the same output time,
  so one decoder + ring serves them all and the extra copies cost no
  extra decode. Frame eviction takes the group **minimum** cutoff so no
  clip drops a frame a sibling still needs.
- **Different phase** (A/B-roll offsets of one source): the clips want
  source times a constant gap apart. One shared ring would have to hold
  the whole gap's worth of `VideoFrame`s — past ~13 frames that deadlocks
  the decoder's buffer pool — so each phase gets its own pipeline,
  mirroring the preview's per-clip keying.

The pool used to key handles by bare `mediaId`. Two enabled overlapping
clips of one source then raced a single handle — their concurrent
`decodeRange` calls interleaved on the shared packet cursor and each
clip's per-frame evict dropped frames the other still needed — and the
export's frame counter froze mid-run. The e2e gate is
`export_overlap_same_source.e2e.js`: stacked completion + no extra
dispatch vs the single-clip baseline, and offset completion + shifted
frame alignment in the offset clip's exclusive region.

With this grouping, dispatch sits on the inherent floor for every
forward-marching timeline shape — single-clip, sequential re-use,
different-phase overlap, and mid-GOP range entry, each measured against
its floor via the worker's `__weftcutExportPerf` counters during
development.
Source time per pipeline is `t + phase`, monotonic in `t`, so backward
re-seeks never fire in normal export; the residual costs — one decode
pass per phase, and the GOP-key prefix at a mid-GOP entry — are
properties of the content, not the scheduler.

### Export source resolution

Before launching the Worker, `runExport.ts` resolves each clip's
**export** source (`exportPlaybackPathFor`): the original for a
DirectExport or bypassed source, otherwise the source-resolution export
master (`proxy_path`). Export never reads the quick preview proxy. For
any clip whose export source is a non-H.264 **original**, a main-thread
**pre-flight** (`probeSourceDecodable`) configures a decoder and decodes
one key packet — racing success against the decoder's error callback and
a timeout (WebCodecs can fail silently). If a source can't be decoded on
this machine, the Worker is never launched: the export aborts with a
retry message and `ensure_full_proxy` enqueues a proxy, so the retry
succeeds from the master. When the import sweep is already probing the
same source, the gate **defers to that in-flight probe** rather than
opening a second decoder — concurrent probes contend for the WebCodecs
buffer pool and false-negative a decodable source (ADR 0013). See ADRs
0010–0011, 0013.

### Encode exits

The Worker supports two encode exits, selected by the export settings'
bit-depth choice.

**8-bit (default):** the existing WebCodecs path described above.
`VideoEncoder` receives each composited `VideoFrame` from the PixiJS
`OffscreenCanvas`, streams encoded chunks through mediabunny `Output`,
and the fMP4 slices land on disk via the chunk/`writeFile(append)`
loop. No changes to this path.

**10-bit (HEVC Main10 or AV1, via the export settings bit-depth
selector):** the Worker switches to the WebGL2 backend for the
composite. The encode exit diverges at three points:

- **Source ingest.** 10-bit-capable sources (H.264 Hi10P and AV1
  10-bit originals, identified at export time by a pure
  ffprobe-metadata rule — codec h264 or av1 + pix_fmt yuv420p10le —
  that sets `tenBitExportCapable`) are decoded through a CPU-plane
  lane, configured prefer-software up front. For Hi10P that skips a
  doomed hardware attempt (no HW path exists); for AV1 it is a
  correctness requirement — the hardware decoder "succeeds" but emits
  opaque `format=null` frames that cannot `copyTo`, and only dav1d
  software decode yields readable `I420P10` planes. The decoder's
  output callback
  runs `VideoFrame.copyTo` into a typed `I420P10` buffer and closes the
  source frame immediately — the copy-then-close pattern satisfies
  ADR 0004's buffer-pool discipline outright, returning the hardware
  slot before the ring ever takes ownership. The extracted planes are
  handed to `TenBitIngest` as an RG8→f16 conversion pass: each chroma-
  and luma-plane pair is uploaded as an RG8 texture and a GLSL shader
  unpacks and scales the 10-bit samples into an `rgba16float`
  `RenderTexture`. The serialized copy chain inside the decoder output
  callback preserves PTS order; EOS finalization (the `SourceHandle`'s
  flush and ring drain) runs after all in-flight copies complete, so
  the PTS-order invariant is never broken at stream end.

  A software-decoder reorder margin (`TENBIT_REORDER_MARGIN`) accounts
  for B-frame reorder depth: the ring high-water entry count gates the
  serialized copy chain — un-copied frames wait in the decoder output
  queue until occupancy falls below the high-water mark — while the
  reorder margin is a separate dispatch lead-in that keeps the decoder
  fed ahead of the copy chain. The high-water derives from resolution:
  a per-ring byte target divided by the first frame's actual plane
  bytes (frame size is constant within a ring — one source, one coded
  size), clamped to an entry floor and ceiling. 1080p sits at the
  ceiling (~300 MB); 4K clamps to the floor (~500 MB). The floor is
  the deadlock guard — decoder output is presentation-ordered, so a
  parked consumer can always evict behind itself and reopen the gate.
  Multiple simultaneous 10-bit sources each carry their own ring (no
  cross-ring global budget — a known limitation).

  8-bit sources are unchanged on the ingest side — they go through the
  normal `createImageBitmap` / `drawImage` snapshot path — but they
  also composite into the same `rgba16float` `RenderTexture`, gaining
  the intermediate-rounding benefit (blends and gradient layers see 16-
  bit precision throughout the composite rather than 8-bit fixed-point
  accumulation).

- **Composite.** The WebGL2 `Compositor` instance targets an
  `rgba16float` `RenderTexture`. The working space is display-referred
  gamma-encoded BT.709 — there is no linear-light blending (ADR 0021:
  color converges once at ingest; the f16 composite is not a linear
  scene-light space but a precision-preserving carry of the already-
  encoded signal). All sprite operations — transforms, opacity, blend
  modes — run in this space identically to the 8-bit path.

- **GPU byte-pack and native encode sink.** After each composited
  frame, `PackYuv420p10` runs GLSL fragment passes over the
  `rgba16float` RenderTexture: they apply the BT.709 limited-range
  matrix and 10-bit quantization and write luma and chroma planes
  (byte-packed, two 10-bit samples per RGBA8 texel) into an output
  buffer sized for `yuv420p10le`. This
  pack pass is the output transform — the encode-domain color
  conversion is folded into it — and it also handles any encoder
  downscale via the sampler, eliminating a separate blit. The resulting
  raw buffer streams to the Rust video sink (`export/videosink.rs`)
  over a one-shot loopback WebSocket, which pipes ffmpeg `-f rawvideo
  -pix_fmt yuv420p10le` into the probed Main10 encoder
  (`hwencoder.rs`'s 10-bit lane: NVENC/QSV/AMF Main10 with libx265 /
  libsvtav1 software fallbacks). Raw-invoke IPC is the fallback
  transport if the loopback WebSocket cannot be established.

The CPU `yuv10.ts` reference (the BT.709/601 matrix constants, the
sample packing, and the round-trip rounding margin) is pinned by the
colocated unit test `yuv10.test.ts`; the WebGL2 f16 ingest and pack
fragment passes were checked against it on known inputs during
development via a since-retired diagnostic. The standing guard is the
end-to-end gate (`export_10bit.e2e.js`), which exports a
Hi10P H.264 source, an AV1 10-bit source, and a 4K Hi10P source (the
ring cap's entry-floor case) through the full 10-bit path and confirms
distinct-step counts above the 8-bit ceiling at the analyzer's
gradient-row meter, plus a long-GOP B-frame reorder-tail regression.

This exit ships as **experimental**: the export-settings UI labels the
10-bit option experimental and confirms the export click. The preview
cannot be guaranteed to match the 10-bit output — there is no HDR/wide-
gamut preview on the web platform, so the preview stays 8-bit/SDR — and
the path runs below realtime (4K especially), with HEVC Main10 source
conform still pending (ADR 0022).

Cross-reference: ADR 0022 records the decision and its probe-backed
rationale (WebGL2 stock f16, the WebSocket transport, copyTo ingest,
deferred HDR); ADR 0021 describes the color model whose named revisit
trigger the f16 composite realizes for the export path.

### Backpressure

`encoder.encodeQueueSize > 8` → await one tick before submitting the
next frame. Prevents heap blow-up if the encoder lags decode.

### Hardware fallback

The encoder configures with `hardwareAcceleration: 'prefer-hardware'`
first. On configure error or a sustained zero-output condition the
Worker re-configures with `'prefer-software'` and logs a warning.

## Render & Play

A user-triggered affordance ("Render & Play") runs the export
pipeline into an OS temp `.mp4` and opens an Electron window
playing the file. The popup HTML lives at `/render-play.html`; the
URL hash carries the asset src + display path. Each invocation
allocates a unique window label so multiple plays coexist.

This is the WYSIWYG verification path when the user wants to see
exactly what the export will produce. It uses the same Worker + Rust
audio + mux pipeline the normal export does — same code, same
output.

## Fixture suite

`render/fixtures/runFixture.ts` is the reusable fixture runner. Each
fixture is a small project (a few seconds, hand-picked layers)
exercising one rendering concern. The runner exports the project
through the Worker, fishes specific frames out via the Rust
`extract_video_frame` command, and SSIM-compares each against a
committed baseline.

The fixture suite is the renderer's regression net — PixiJS is its
own ground truth (no comparison against ffmpeg), so the fixtures
must be re-baselined whenever an intentional rendering change lands.
