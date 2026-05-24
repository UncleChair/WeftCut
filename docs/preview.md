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
       ├─ SourceDecoderPool  — per-clip VideoDecoder + ring; shared Demuxer per source
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

Internally the clock keeps raw wall-clock state so drift correction
operates with sub-frame precision. Externally observable
`positionUs()` and the `onTimeUpdate` emit stream return the value
snapped to the composition-frame grid, deduped per snap — at 30 fps
comp on a 60 Hz display, time-update listeners fire ~30/s instead of
every rAF. Timecode display is SMPTE `HH:MM:SS:FF`, NDF; see
[data-model.md](data-model.md) for the snap rule that anchors it.

`play()` releases the clock only once the decoder has filled
`WARMUP_MIN_LOOKAHEAD_US` (~150 ms) of ring past the play position,
or after a `WARMUP_MAX_WAIT_MS` (~250 ms) safety cap. The UI play
state flips immediately, so the button feels responsive; the rAF
loop's `compositeFrame` keeps running at the held position during
the gate, so the canvas shows the start frame still rather than
stuttering through partial decoder outputs. `pause()` cancels the
warm-up. This eliminates the cold-start stutter that hardware
decoders' first-frame init latency would otherwise cause.

`PlaybackEngine` exposes one frame-time per tick to every sprite in
`LiveLayers`; sprites read project state out of their own `LayerSummary`
and compute on-the-fly per-channel sample values via the shared
`Animated<T>::sample(t)` interpolation helper.

## Decode

`SourceDecoderPool` keeps one `VideoDecoder` + one `FrameRing` per
*clip* (per `layerId`). The `Demuxer` and parsed sample table live
on a refcounted `SourceMedia` keyed by `mediaId` so multiple clips of
the same source share one parse but each get their own decode
pipeline. Each handle's `FrameRing` caches 1 s lookahead / 0.5 s
lookbehind of `ImageBitmap` snapshots around the current playhead.
The ring is what the compositor reads.

Decoders are idle-disposed 5 s after last use and rebuild on the next
`requestFrameAt`. Hardware-decode failures route through
`decoderFallback.ts`: a zero-output first-frame error reconfigures
the decoder with `hardwareAcceleration: 'prefer-software'`; a
`'Codec reclaimed due to inactivity'` error closes the decoder and
lazy-rebuilds.

Forward GOP-crossings during continuous play do NOT reset the
decoder. The pump dispatches the new GOP's IDR chunk through the
same `VideoDecoder` in stream — H.264 IDR semantics clear
reference state mid-stream — and the ring carries continuously
across the boundary. Reset is reserved for backward seeks whose
target isn't in the ring and for forward seeks far enough past
the pump frontier that decoding through the gap would burn
seconds. See [ADR 0003](adr/0003-forward-gop-crossing-no-decoder-reset.md).

The `Demuxer` itself never holds the full proxy in memory. Warmup
issues a bounded `Range` request for the moov prefix only; per-sample
NAL bytes are fetched on demand into a small LRU of GOP-aligned
blocks. See [`render.md`](render.md#demuxer-byte-handling) for the
byte-cache contract — relevant when adding a new caller of
`Demuxer.sampleAt`.

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

Heavy video clips play through a 1080p H.264 proxy generated at
import by `jobs/proxy.rs`. The proxy's GOP is one source-second
(`-g <round(source_fps)>`) so that seek-to-IDR-then-decode-forward
tails stay bounded to roughly one second of source content
regardless of the source's frame rate. The proxy is what the
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

## Diagnostics

`PerfHUD.tsx` is a `import.meta.env.DEV`-gated overlay mounted in
the top-right corner of the preview surface (`Ctrl+Shift+P` toggles).
It reads the Compositor and PlaybackEngine via refs every 500 ms and
displays:

- **rAF P50 / P99** — frame-interval percentiles over a 120-entry
  circular window. Resets on `visibilitychange` so a tab-unhide
  doesn't pollute the ring with the multi-second pause interval.
- **composite ms (last · max)** — `compositeFrame` body duration.
  The running max persists until the reset button is clicked.
- **warmup ms (last · max + reason)** — time from `play()` to the
  clock actually starting. The `(lh)` suffix means the lookahead
  check fired; `(cap)` in amber means the `WARMUP_MAX_WAIT_MS` cap
  fired without the ring being ready (possible initial-frame
  stutter).
- **heap** — Chromium's `performance.memory.usedJSHeapSize /
  totalJSHeapSize`. WebView2 exposes this.
- **per-clip** — `decodeQueueSize`, ring entry count, ring's latest
  PTS for every active clip (clips with disposed handles are
  filtered out).

The HUD's reset button clears the Compositor's `compositeMsMax` AND
the engine's warmup max so a one-off cold-start spike doesn't pin
the displayed max forever. The HUD's z-index sits below page
chrome popovers / settings dialogs so it doesn't obscure them.

## Render & Play

The "Render & Play" affordance kicks off the same Pixi+WebCodecs
pipeline used for export, writes the result to an OS temp MP4, and
opens a Tauri webview popup playing the file. It's the WYSIWYG
verification path when the user wants to see exactly what the export
will produce. The popup HTML lives at `/render-play.html`.
