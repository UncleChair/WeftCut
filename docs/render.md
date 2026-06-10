# Render

The PixiJS + WebCodecs renderer. One module produces every frame the
user ever sees — in the live preview surface and in the export
Worker. Preview pixels equal export pixels by construction.

This doc covers the architecture. For the preview-side mount + clock
+ transport see [`preview.md`](preview.md). For the audio export +
final mux see [`rendering.md`](rendering.md).

## Boundaries

- **In scope:** visual compositing — video clips, image overlays,
  text, ASS/SRT subtitles, color fills, transforms, opacity, blend
  modes, transitions.
- **Out of scope:** audio (handled by Web Audio in preview, ffmpeg in
  export), file muxing (handled by ffmpeg `-c copy`), source
  probing / proxy generation / waveforms / thumbnails (all
  Rust-side).
- **Out of scope explicitly:** per-layer effects. The effects
  subsystem was deleted with the renderer migration; a future
  redesign may reintroduce it on the PixiJS path.

## Directory layout

```
apps/desktop/src/render/
  Compositor.ts              — PixiJS Application owner; per-frame composite
  clock.ts                   — synthetic clock + Web Audio drift correction
  PlaybackEngine.ts          — transport (play/pause/seek/scrub)
  decoder/
    SourceDecoderPool.ts     — per-clip VideoDecoder + ring; refcounted shared mediabunny Input per source; idle-dispose
    mediaInput.ts            — opens a mediabunny Input over an asset:// Range CustomSource (AssetRangeSource)
    PacketPump.ts            — single-flight async packet→decoder loop (getKeyPacket/getNextPacket)
    probeSourceDecodable.ts  — export pre-flight: can this machine's WebCodecs decode the original?
    FrameRing.ts             — 1 s lookahead / 0.5 s lookbehind per clip; stores ImageBitmap snapshots
    scrub.ts                 — debounced scrub coalescer (decode-during-drag)
  sprite/
    VideoClipSprite.ts
    ImageOverlaySprite.ts
    TextSprite.ts
    MotifSprite.ts           — binds a Motif's captured PNG frame as a texture
    SubtitlesSprite.ts       — owns JASSUB binding
    ColorSprite.ts
  motifs/                    — Motif raster cache + frame descriptor helpers
                               (capture/cache pipeline covered in motifs.md)
  subtitles/
    Jassub.ts                — libass-wasm canvas-mode binding
  worker/
    exportWorker.ts          — Worker entry; imports Compositor against OffscreenCanvas
    encoder.ts               — VideoEncoder config + mediabunny Output mux into video.mp4
    protocol.ts              — postMessage protocol (start/cancel/progress/chunk/done)
  audio/
    AudioGraph.ts            — Web Audio mixer
```

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
`render/animated.ts`'s `resolveAnimated`, the byte-for-byte mirror of
Rust `state/animated.rs::value_at`; color tracks statically until the
Rgba engine twin lands — then hands the resolved scalar view to the
sprite to update its texture / position / opacity / transform / blend
mode. A shared golden-vector fixture
(`render/animatedGolden.fixture.json`) locks the two engines together:
both sides assert it in their unit suites, so an interpolation change
that lands on one side only fails the other side's gate.

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
reads through an `asset://` Range `CustomSource` (`AssetRangeSource`):
each read issues an HTTP `Range` request and returns exactly the
requested bytes. Tauri's asset handler honors Range — the same path
HTML5 `<video>` seeks through — whereas a plain `fetch(url)` buffers
the whole body before exposing `body.getReader()`, defeating streaming.

One Range caveat: the asset handler caps each `206` body at ~1 MB, so
`AssetRangeSource.read` loops, re-issuing Range requests until it has
the exact byte count mediabunny asked for — a single short read would
hand the decoder truncated data and wedge it.

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
| `VideoClipSprite` | `FrameRing` snapshot → `Texture` | Consumes the `DecodedFrame` returned by `FrameStore.frameAt` — `ImageBitmap` from preview's `FrameRing`, `VideoFrame` from export's `ExportFrameStore`. PixiJS v8 `ImageSource` accepts both. |
| `ImageOverlaySprite` | `createImageBitmap` → `Texture` | One-shot bitmap creation at sprite spawn; cached for the layer's lifetime. |
| `TextSprite` | PixiJS `Text` (native canvas) | Shadow via drop-shadow filter; outline via stroke option; intro / outro presets are sprite-side animation. |
| `MotifSprite` | CDP-captured PNG frame → `Texture` | Binds the Motif's frame for the playhead's layer-relative time (on demand, RAM lookahead, or persisted PNG); frames come from the webcap CDP capture path, not an in-process raster; see [`motifs.md`](motifs.md). |
| `SubtitlesSprite` | JASSUB canvas → `Texture` | libass-wasm renders into its own canvas; we copy as a texture each frame. |
| `ColorSprite` | PixiJS `Graphics` rect | Animated fill color. |

## Motifs

A Motif is a parameterized, time-varying web overlay (a lower-third, a
countdown, a title card). Because the export Worker has no DOM, a Motif is
captured to a bitmap on the **main process** for both surfaces: the export
Worker receives the bitmaps rather than producing them, so one capture path
feeds preview and export and preview-equals-export holds.

`MotifSprite` obtains the frame for the playhead's layer-relative time
(captured on demand, from a RAM lookahead ring, or from a persisted PNG
sequence) and binds it as a texture; the layer transform and opacity are
applied to the sprite. Capture drives the Motif's page to time `t` in a hidden
WebView2 host and grabs a taint-free PNG via the DevTools Protocol
(`Page.captureScreenshot`) — a real browser raster, so unlike an SVG
`<foreignObject>` it is not cross-origin-tainted.

A Motif's `index.html` + manifest (+ optional `assets/`) are embedded in the
Rust binary and served to the host over the `motif:` URI scheme; see
`crate::motifs` (`src-tauri/src/motifs/`). The catalog is surfaced to the
webview via the `list_motifs` Tauri command and the MCP `list_motifs` tool.

See [`motifs.md`](motifs.md) for the authoring contract, the capture harness,
and the raster cache.

## Subtitles

`SubtitlesSprite` mounts a JASSUB (libass-wasm) renderer with the
project's canvas dimensions. JASSUB renders into its own canvas; the
sprite sets that canvas as a Pixi texture each frame. Because
libass tracks its own animation state internally, the texture must
be refreshed every render — there's no static-vs-animated short
cut.

For media-backed subtitles (`SubtitlesParams::Media(media_id)`), the
sprite reads the file via `convertFileSrc(path)` and passes the
contents to JASSUB. For inline subtitles (`InlineSrt(body)`), the
body is fed directly.

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

### Backpressure

`encoder.encodeQueueSize > 8` → await one tick before submitting the
next frame. Prevents heap blow-up if the encoder lags decode.

### Hardware fallback

The encoder configures with `hardwareAcceleration: 'prefer-hardware'`
first. On configure error or a sustained zero-output condition the
Worker re-configures with `'prefer-software'` and logs a warning.

## Render & Play

A user-triggered affordance ("Render & Play") runs the export
pipeline into an OS temp `.mp4` and opens a Tauri webview popup
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
