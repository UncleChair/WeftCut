# Render

The PixiJS + WebCodecs renderer. One module produces every frame the
user ever sees — in the live preview surface and in the export
Worker. Preview pixels equal export pixels by construction.

This doc covers the architecture. For the preview-side mount + clock
+ transport see [`preview.md`](preview.md). For the audio export +
final mux see [`rendering.md`](rendering.md).

## Boundaries

- **In scope:** visual compositing — video clips, image overlays,
  text, templates, ASS/SRT subtitles, color fills, transforms,
  opacity, blend modes, transitions.
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
    SourceDecoderPool.ts     — one VideoDecoder per source media; idle-dispose
    Demuxer.ts               — mp4box.js wrapper; produces EncodedVideoChunks
    FrameRing.ts             — 1 s lookahead / 0.5 s lookbehind per source; stores ImageBitmap snapshots
    scrub.ts                 — debounced flush + seek-to-IDR + decode-forward
  sprite/
    VideoClipSprite.ts
    ImageOverlaySprite.ts
    TextSprite.ts
    TemplateSprite.ts        — owns the foreignObject raster cache for its template
    SubtitlesSprite.ts       — owns JASSUB binding
    ColorSprite.ts
  templates/
    Rasterizer.ts            — foreignObject SVG → ImageBitmap; embeds @font-face base64
    Cache.ts                 — content-hash keyed
  subtitles/
    Jassub.ts                — libass-wasm canvas-mode binding
  worker/
    exportWorker.ts          — Worker entry; imports Compositor against OffscreenCanvas
    encoder.ts               — VideoEncoder config + mp4box.js mux into video.mp4
    protocol.ts              — postMessage protocol (start/cancel/progress/done)
  audio/
    AudioGraph.ts            — Web Audio mixer
  fixtures/
    runFixture.ts            — reusable fixture runner (used by tests + Tauri command)
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

`render(tUs)` walks the mounted sprites in z-order and asks each to
update its texture / position / opacity / transform / blend mode for
the requested timestamp. Sprites resolve `Animated<T>` values via
the shared `engine.ts` helpers (which mirror the Rust-side
interpolation semantics exactly).

## Decoder pool

`SourceDecoderPool` keys decoders by `MediaId`. A decoder is created
on first `requestFrameAt(mediaId, tUs)` and reused for every
subsequent request against the same source. The pool's
`configureWithFallback` helper handles hardware-decode failures:

- **First-frame error (output count = 0):** reset the decoder with
  `hardwareAcceleration: 'prefer-software'` and mark the handle as
  downgraded.
- **`'Codec reclaimed due to inactivity'`:** close + null the
  decoder, emit one LogBus warning, lazy-rebuild on next
  `requestFrameAt`.

Each decoder owns a `Demuxer` (mp4box.js wrapper) and a `FrameRing`
that caches the most recent 1 s lookahead / 0.5 s lookbehind. The
ring is what the compositor reads — decoder threads stay one step
ahead of the playhead.

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

Idle decoders are disposed 5 s after the last request and recreated
on demand.

## Scrub

`scrub.ts` debounces drag input. On commit:

1. Issue `decoder.flush()` to drop pending output.
2. Seek the demuxer to the prior IDR.
3. Decode forward from the IDR to the requested frame.

Continuous scrub uses the same path with a tighter debounce so the
user sees a frame within ~1 frame-time per drag step.

## Sprite kinds

| Sprite | Source | Notes |
|---|---|---|
| `VideoClipSprite` | `FrameRing` snapshot → `Texture` | Consumes the `DecodedFrame` returned by `FrameStore.frameAt` — `ImageBitmap` from preview's `FrameRing`, `VideoFrame` from export's `ExportFrameStore`. PixiJS v8 `ImageSource` accepts both. |
| `ImageOverlaySprite` | `createImageBitmap` → `Texture` | One-shot bitmap creation at sprite spawn; cached for the layer's lifetime. |
| `TextSprite` | PixiJS `Text` (native canvas) | Shadow via drop-shadow filter; outline via stroke option; intro / outro presets are sprite-side animation. |
| `TemplateSprite` | `Rasterizer` (foreignObject SVG → `ImageBitmap`) | Fonts embedded as base64 `@font-face`; raster cache keyed on content hash. |
| `SubtitlesSprite` | JASSUB canvas → `Texture` | libass-wasm renders into its own canvas; we copy as a texture each frame. |
| `ColorSprite` | PixiJS `Graphics` rect | Animated fill color. |

## Templates

The `Rasterizer` composes a template's HTML + CSS into an SVG
`<foreignObject>`, embeds every referenced font as base64
`@font-face`, and feeds the SVG to `createImageBitmap`. The
resulting bitmap becomes a Pixi texture.

The cache key is the template id + canonical-JSON props + the
composition canvas dimensions. The cache is shared across all
sprite instances of the same template — common templates render
once and reuse the bitmap.

Templates' HTML + CSS + manifests are embedded in the Rust binary
via `include_str!`; see `crate::templates` (`src-tauri/src/templates/`).
The catalog is surfaced to the webview via the `list_templates`
Tauri command and the MCP `list_templates` tool. Custom templates
land outside the built-in catalog (extension point not wired yet).

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
the frame grid (project fps × duration), calls `render(tUs)` for
each, transfers the rendered frame to a `VideoEncoder`, and mp4box-
muxes the encoded chunks into an in-memory MP4. Progress events
fire on every encoded frame; the final `done` event hands the MP4
ArrayBuffer back to the main thread.

The main thread then writes the bytes to a temp `video.mp4`, awaits
the audio-only Rust export into a sibling `audio.m4a`, and asks the
Rust side to `mux_to_file(video, audio, output)`.

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
