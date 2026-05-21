# Preview

The preview surface is a PixiJS v8 `Application` mounted against a
`<canvas>` on the main thread. The same renderer module runs inside an
`OffscreenCanvas` Worker for export — preview and export share one
compositor and produce identical pixels by construction. See
[`docs/render.md`](render.md) for the renderer architecture; this doc
covers the preview-side surface and transport.

## Component tree

```
<PreviewSurface>             — React mount, canvas host, transport handle
  └─ Compositor              — PixiJS Application owner; per-frame composite
       ├─ PlaybackEngine     — play / pause / seek / scrub
       │    ├─ clock         — synthetic clock + Web Audio drift correction
       │    └─ AudioGraph    — Web Audio mixer
       ├─ SourceDecoderPool  — one VideoDecoder per source media
       └─ LiveLayers         — per-layer Sprite instances mounted on the stage
            ├─ VideoClipSprite
            ├─ ImageOverlaySprite
            ├─ TextSprite
            ├─ TemplateSprite
            ├─ SubtitlesSprite
            └─ ColorSprite
```

`PreviewSurface.tsx` is the only React file. Everything below it is plain
TypeScript driven by an imperative handle (`play()`, `pause()`,
`seekTo(usec)`, `runPixiExport(...)`).

## Clock

A synthetic `currentTimeUs` is the source of truth. It advances on a
`requestAnimationFrame` loop while playing; while paused it's set
directly by `seekTo`. When audio is playing the clock corrects against
`audioCtx.currentTime` to absorb scheduler jitter.

`PlaybackEngine` exposes one frame-time per tick to every sprite in
`LiveLayers`; sprites read project state out of their own `LayerSummary`
and compute on-the-fly per-channel sample values via the shared
`Animated<T>::sample(t)` interpolation helper.

## Decode

`SourceDecoderPool` keeps one `VideoDecoder` per source media. Each
decoder owns:

- A `Demuxer` (mp4box.js wrapper) that pulls `EncodedVideoChunk`s out of
  the underlying file.
- A `FrameRing` with 1 s lookahead / 0.5 s lookbehind around the current
  playhead. The ring is the cache the compositor reads.

Decoders are idle-disposed 5 s after last use; they re-spin on the next
`requestFrameAt`. The pool's `configureWithFallback` helper handles
hardware-decode failures: on a zero-output first-frame error, the
decoder resets with `hardwareAcceleration: 'prefer-software'` and the
handle is marked downgraded. On `'Codec reclaimed due to inactivity'`
the decoder closes and emits one LogBus warning; the next
`requestFrameAt` rebuilds it.

## Scrub

`scrub.ts` debounces drag input and, on commit, calls `decoder.flush()`,
seeks to the prior IDR, and decodes forward to the requested frame.
Continuous scrub uses the same path with a tighter debounce so the user
sees a frame within ~1 frame-time of each drag step.

## Audio

`AudioGraph` is a Web Audio mixer keyed by layer id. Each `AudioLayer`
gets a `BufferSource` chained through a per-clip `GainNode` (for
animated gain) and merged into a master bus. `seekTo` re-schedules every
source against the new clock origin; pause stops scheduling but holds
state for the next play.

The audio compositor that produces the final m4a at export time still
runs in Rust ffmpeg — see [`docs/rendering.md`](rendering.md). The
Web Audio path is preview-only.

## Proxies

Heavy video clips play through a 1080p H.264 1-second-GOP proxy
generated at import by `jobs/proxy.rs`. The proxy is what the
decoder pool opens for that media id; the original is referenced only
at export time when the user wants full-quality output.

`MediaDerivativesPatch.proxy_path = Some(None)` invalidates a stale
proxy and triggers a re-encode on next open.

## Subtitles

`SubtitlesSprite` owns a JASSUB (libass-wasm) renderer. JASSUB writes
into its own canvas; the sprite sets that canvas as a Pixi texture each
frame. The texture is regenerated every render because libass tracks
its own animation state internally.

## Templates

`TemplateSprite` owns a `foreignObject` SVG raster. The template's HTML
+ CSS is composed into an SVG `<foreignObject>`, fonts are embedded as
base64 `@font-face` declarations, and the SVG is converted to an
`ImageBitmap` via `createImageBitmap`. The resulting bitmap becomes a
Pixi texture. The raster cache is keyed on content hash
(template id + props + composition canvas size), shared across sprite
instances of the same template.

## Render & Play

The "Render & Play" affordance kicks off the same Pixi+WebCodecs
pipeline used for export, writes the result to an OS temp MP4, and
opens a Tauri webview popup playing the file. It's the WYSIWYG
verification path when the user wants to see exactly what the export
will produce. The popup HTML lives at `/render-play.html`.
