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
       │    ├─ clock         — audio-master clock (anchor-derived; wall fallback)
       │    └─ AudioGraph    — Web Audio mixer
       ├─ SourceDecoderPool  — per-clip VideoDecoder + ring; shared mediabunny Input per source
       └─ LiveLayers         — per-layer Sprite instances mounted on the stage
            ├─ VideoClipSprite
            ├─ ImageOverlaySprite
            ├─ TextSprite
            ├─ MotifSprite
            └─ ColorSprite
```

`PreviewSurface.tsx` is the only React file. Everything below it is plain
TypeScript driven by an imperative handle (`play()`, `pause()`,
`seekTo(usec)`, `runPixiExport(...)`).

## Clock

The audio hardware clock is the master. While the `AudioContext` is
running, the playing position is DERIVED from `ctx.currentTime`
against the engine's `ClockAnchor` — the same pair every `AudioMixer`
schedules its chunks against, so playhead and audio share one clock by
construction ([`audio.md`](audio.md) §Clock). While the context is
suspended (autoplay policy, before the first gesture) the clock falls
back to `performance.now()` deltas; the flip back re-anchors from the
current position, so switching sources never jumps the playhead.
While paused the position is set directly by `seekTo`.

Internally the clock keeps the raw (unsnapped) position. Externally
observable `positionUs()` and the `onTimeUpdate` emit stream return
the value snapped to the composition-frame grid, deduped per snap — at
30 fps comp on a 60 Hz display, time-update listeners fire ~30/s
instead of every rAF. Timecode display is SMPTE `HH:MM:SS:FF`, NDF;
see [data-model.md](data-model.md) for the snap rule that anchors it.

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
*clip* (per `layerId`). The mediabunny `Input` + `EncodedPacketSink`
live on a refcounted `SourceMedia` keyed by `mediaId` so multiple clips
of the same source share one open/parse but each get their own decode
pipeline (a per-clip `PacketPump` driving the `VideoDecoder`). Each
handle's `FrameRing` caches 1 s lookahead / 0.5 s
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

The source is never fully resident in memory. mediabunny reads through
a `weftcut-media://` HTTP Range `CustomSource` (`AssetRangeSource`),
pulling only the bytes a packet needs; the `PacketPump`'s `getKeyPacket` /
`getNextPacket` calls await those uncached Range reads natively. See
[`render.md`](render.md#byte-handling) for the byte contract.

## Decode engine

Which decoder actually plays a source is decided per session by an overlay
sitting above the persisted [Decode Route](../CONTEXT.md#decode-routing): the
`decode_engine` AppSettings tier (`auto` / `native` / `webcodecs`), the
capability cache (per-machine probe verdicts for the native lanes), and this
session's WebCodecs-original probe. `resolveEngineTier` is a pure function of
those three inputs — it never writes back to the route, the cache, or the
project — and returns one of four tiers, handed to
`SourceDecoderPool.acquire`:

```
decode_engine setting ─┐
capability cache       ┼─► resolveEngineTier ─► SourceDecoderPool.acquire
DecodeRoute (read-only)┘         │                (forceStrategy, sourcePath | url)
                                  ├─ native-hw
                                  ├─ webcodecs-original
                                  ├─ native-sw
                                  └─ proxy
```

- **`native-hw`** — the native engine's hardware lane (Windows d3d11va
  today): a pooled shared GPU texture reaches the compositor with zero pixel
  bytes crossing IPC.
- **`webcodecs-original`** — WebCodecs decodes the original file directly;
  no proxy involved. This is what the retiring [Session bridge](../CONTEXT.md#decode-routing)
  used to approximate with a temporary override; the tier now covers the
  same ground as an ordinary resolution outcome.
- **`native-sw`** — the native engine's software lane (`SwSourceHandle`):
  libavcodec decodes the original in the main process and ships NV12 bytes
  to the renderer ([ADR 0029](adr/0029-native-sw-decode-ships-bytes-not-shared-texture.md)).
- **`proxy`** — the fallback: preview decodes whichever proxy the Decode
  Route has already resolved for this source (see [Proxies](#proxies)).

Both native tiers additionally require the optional `@weftcut/native-decode`
component to be loadable on this machine; where it isn't, `auto` and
`native` skip past them entirely. See [ADR 0030](adr/0030-decode-engine-overlay-and-native-component.md)
for why that component is a separate, conditionally-loaded addon and what it
means for licensing.

**Tier order is set by the `decode_engine` setting:**

| Setting | Order tried |
|---|---|
| `auto` (default) | `native-hw` → `webcodecs-original` → `native-sw` → `proxy` |
| `native` | `native-hw` → `native-sw` → `webcodecs-original` → `proxy` |
| `webcodecs` | `webcodecs-original` → `proxy` |

`auto` tries WebCodecs before the native software lane because a browser
decode of the original beats a cross-process software decode when both are
available; forcing `native` prefers the native engine's own lanes first and
falls back to WebCodecs only if neither native lane opens the source.
Forcing `webcodecs` never engages the native engine at all. Every step is
logged; a tier that fails resolution (probe miss, component unavailable,
runtime downgrade) is skipped silently in favor of the next one — no dialog,
no retry loop.

**Originals are the default.** Every tier above `proxy` decodes the original
file; the quick proxy is reached only once nothing else resolves, or once
the user explicitly asks for one. This matches how mainstream NLEs behave
(`feedback_native_nle_conventions`): proxy is a convenience the user opts
into, never something the app swaps to on its own mid-session.

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

Proxy is the decode engine's tier-4 fallback (see [Decode engine](#decode-engine)):
preview reaches it only when no higher tier resolves for a source, or when
the user opts into one explicitly from the media panel. It is never the
steady-state preview source for a codec WebCodecs or the native engine can
already open directly — see [`data-model.md`](data-model.md) and
ADRs 0009–0011 for how the Decode Route decides which derivatives exist for
a source in the first place; the decode engine only ever reads that
decision, never writes it.

- **Quick proxy** — a 720p short-GOP scrub copy (`quick_proxy_path`),
  generated at import by `jobs/quick_proxy.rs`. This is the file tier 4
  hands to `SourceDecoderPool.acquire` when it's the one available. Its
  short fixed GOP (`PROXY_GOP_FRAMES`) is what makes scrubbing
  frame-accurate: any scrub target decodes at most a few frames from its
  keyframe, bounding the seek-to-key-then-decode-forward tail (ADR 0008).
- **Export master** — the full `proxy_path`, a source-resolution copy
  (ADR 0011) used only at export time; preview never reads it.
  `MediaDerivativesPatch.proxy_path = Some(None)` (or a
  `proxy_format_version` bump) invalidates a stale proxy and triggers a
  re-encode on next open.

## Motifs

`MotifSprite` binds a Motif's captured PNG frame as a Pixi texture. The Motif's
page is driven to the playhead's layer-relative time in an offscreen Electron
window and grabbed as a taint-free PNG via the DevTools Protocol
(`Page.captureScreenshot`) — unlike an SVG `<foreignObject>`, that real browser
raster is not cross-origin-tainted (the wall that ruled out HTML/CSS rasterizing
before). In preview the frame is captured on demand, with a RAM lookahead ring
for heavy Motifs; the cache is keyed on content identity (motif id + version +
props + render size + fps + content-duration frames), shared across sprite
instances of the same Motif. See [`motifs.md`](motifs.md).

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
  totalJSHeapSize`. Chromium/Electron exposes this.
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
opens an Electron window playing the file. It's the WYSIWYG
verification path when the user wants to see exactly what the export
will produce. The popup HTML lives at `/render-play.html`.
