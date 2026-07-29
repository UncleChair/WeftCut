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

Which decoder plays a source is decided per session by an overlay sitting
above the persisted [Decode Route](../CONTEXT.md#decode-routing). Preview
decode is a *deep module*: a caller picks an **engine**, and the engine hides
everything below it — hardware-vs-software lane selection, capability probes,
the per-machine cache, sticky fallback, and device-loss recovery. A resolution
names two public axes; a third lives private inside the engine:

- **Engine** — `ffmpeg` (**Standard**) or `webcodecs` (**Lite**). The
  `decode_engine` AppSetting is `auto` / `ffmpeg` / `webcodecs`; `auto`
  (**Automatic**) resolves to a concrete engine per source.
- **Source** — `original` or `proxy`. The user's axis; routing never flips it
  on its own (see [Proxies](#proxies)).
- **Lane** — `hardware` or `software`. **Private to the Standard engine**,
  never surfaced in a resolver input or output. HW-vs-SW is an implementation
  detail of `FfmpegSource`, not something a caller or the Compositor sees.

`resolveDecodeEngine` is a pure function of its inputs — the setting, whether
the native-decode component is loaded, the user's proxy opt-in, this session's
WebCodecs-original probe verdict, and a runtime "has ffmpeg terminally failed
for this source" flag. It never writes back to the route, the cache, or the
project; reopening a project re-runs it from nothing. It returns a
`DecodeResolution` handed to `SourceDecoderPool.acquire`:

```
decode_engine setting  ─┐
component available?    │
proxy opt-in / ready    ┼─► resolveDecodeEngine ─► { engine, source, target,
webcodecs probe verdict │        (pure)                 status, key }
ffmpeg-usable (runtime) ─┘                                    │
                          engine: ffmpeg    → FfmpegSource ───┤ (picks its own lane)
                          engine: webcodecs → SourceHandle ───┘
```

`status` is first-class: `ok` (a `target` is acquirable), `pending` (a probe
or proxy build is still outstanding), or `unsupported` (no engine can decode
the chosen source — see [Unsupported](#unsupported)). `key` —
`${engine}:${source}:${target}` — is the swap identity: it changes only on an
engine or source flip, so the Compositor's no-flash overlap-swap now fires
only for the rare `auto` ffmpeg→webcodecs flip or the user's original↔proxy
switch. A lane change *inside* the Standard engine does not change the key and
triggers no swap.

**Engine selection by setting:**

| Setting | Label | Resolves to |
|---|---|---|
| `auto` (default) | Automatic | `ffmpeg` when the component is loaded and hasn't failed for this source, else `webcodecs` |
| `ffmpeg` | Standard | `ffmpeg` (`unsupported` if the component isn't loaded, or it already failed for this source) |
| `webcodecs` | Lite | `webcodecs` |

The stored setting value was renamed `"native" → "ffmpeg"`; a one-shot
migration in `app-settings.ts` maps any persisted `"native"` on load. The
settings UI grays out **Standard** when the component is absent, so a pinned
`ffmpeg` with no component is only reachable via a stale/migrated value — the
resolver reports it `unsupported` rather than optimistically `ok`.

**Originals are the default.** Both engines decode the original file by
default; the quick proxy is a source the user opts into, never one the app
swaps to on its own, and `auto` never auto-proxies. This matches how
mainstream NLEs behave (`feedback_native_nle_conventions`).

**Export mirrors this overlay.** The same Automatic/Standard/Lite vocabulary
routes export decode: a per-project `decodeEngine` setting feeds
`resolveExportDecodeRouting`, which freezes a per-media routing table at
export start — no mid-run re-resolution, and native-routed sources skip the
proxy wait. The export dialog renders this section's picker options verbatim
(`settings/decodeEngineOptions.tsx` is shared by both surfaces). See
[`render.md`](render.md) §Export source resolution and
[ADR 0033](adr/0033-export-decode-joins-the-engine-overlay.md).

### The Standard engine (`FfmpegSource`)

`FfmpegSource` is the deep module: one class over two interchangeable
*transports* against one stable `FrameRing`. It privately owns the
capability-cache lookup, the HW allow-list, the class-key probe, and the
sticky HW→SW verdict. It needs the optional `@weftcut/native-decode`
component; where that isn't loadable, `auto` resolves to the Lite engine and
**Standard** is grayed out. See [ADR 0030](adr/0030-decode-engine-overlay-and-native-component.md)
for why the component is a separate, conditionally-loaded addon and what it
means for licensing.

- **Lane pick at open.** HW-eligible codec + probe ok → a `GpuTransport`
  (`lane = "hardware"`); otherwise a `SwTransport` (`lane = "software"`).
- **HW transport** — Windows d3d11va: a pooled shared GPU texture reaches the
  compositor with zero pixel bytes crossing IPC. The preload isolated world
  builds each `ImageBitmap` from the shared slot and forwards it over a
  MessagePort. Codec-agnostic — nothing on the path inspects the bitstream.
- **A slot's recycling waits for the GPU read; its delivery doesn't.** ffmpeg
  overwrites a slot in place as soon as it is acked, on its own D3D11 device,
  while Chromium reads that texture on the GPU process's — a cross-device
  dependency Chromium cannot track, so `await createImageBitmap` resolving is
  not the read having landed. Ack too early and the producer overwrites the slot
  mid-read, delivering a later frame's pixels tagged with an earlier PTS
  (`preview-gpu-order.spec.ts` locks this: every frame carries a barcode of its
  index and every delivered bitmap must match its PTS-derived index, on one
  session and on three concurrent ones). What has to wait is **recycling**, not
  **delivery** — treating the two as one costs a display interval on the
  renderer thread for every frame of every session. So the preload hands the
  bitmap over immediately and delegates the ack to the renderer, which copies one
  pixel out of the delivered bitmap on Pixi's WebGPU queue, waits for that
  queue's submitted work, and acks the slot back up the same port.
- **Waiting must be free, which is why the signal is a promise.** The same
  deferral expressed with a WebGL2 `fenceSync` needs a context of its own, and on
  an idle GPU such a fence does not signal by itself at any bound — the drain's
  flush-and-poll spin is what completes it, and WebGL2 cannot express a blocking
  wait, so that spin is busy work on the renderer thread. It cost a quiet 1080p
  track ~2 s per 20 s window and made 4K fail outright. WebGPU's
  `onSubmittedWorkDone` is a promise, so a slot that is not ready yet costs
  nothing to keep waiting for.
- **The ack is independent of paint, and completion-bound.** A frame the ring evicts, or
  one that arrives while nothing is compositing, still holds a slot, and
  `pool_size` stranded slots wedge a session for good — so the signal is taken on
  delivery and never waits on anything downstream. An unsignalled slot remains
  owned regardless of elapsed wall time, until its GPU completion signal arrives
  or the stream closes; time alone is not evidence that native may overwrite the
  shared texture. The observed 83–97 ms hold with a three-slot pool can constrain
  high-frame-rate throughput, but it no longer trades pixel ordering for that
  throughput. `HwBarrierMode` (`shared/ipc.ts`) names the strategies;
  the preload-side fence and the synchronous 1px readback — a pipeline flush, not
  a frame transfer — stay available as A/B controls, the readback also as the
  fallback where the renderer has no device to fence on.
- **SW transport** — libavcodec decodes the original in the main process and
  ships NV12 bytes over classic IPC ([ADR 0029](adr/0029-native-sw-decode-ships-bytes-not-shared-texture.md)).
  The bytes ring as `NativeNv12Frame`s and convert to RGB in the compositor's
  own `Nv12Ingest` pass (dual GLSL/WGSL — the preview renderer prefers
  WebGPU), with the matrix selected from the source's mapped color tags —
  never via `createImageBitmap`, whose buffer-frame conversion is always
  BT.601 ([ADR 0032](adr/0032-cpu-plane-yuv-converts-in-owned-shaders.md)).
  Gate: `preview-sw-color.spec.ts` (saturated charts, 709 + 601 legs).
- **SW requests continue, they don't re-seek.** The native session keeps a
  cursor (position + the frame it stopped on) across requests, so a target that
  moves forward — every playback tick — resumes the same decode pass, and only a
  backward scrub or a jump more than a second past the frontier pays a seek.
  It stops once half a second past the target is decoded, which is what paces
  delivery to content rate: one new frame per tick, no duplicates. The renderer
  adds the second brake, skipping the request entirely while
  `FrameRing.isLookaheadFull()` (time OR byte budget). Seeking per request
  instead costs the whole GOP prefix every tick — measured 137× decode
  amplification on a 240-frame GOP, which is what made this lane unusable for
  long-GOP and 10-bit sources.
- **HW→SW fallback is internal.** A HW decode error or device loss disposes the
  GPU transport and opens the SW transport **into the same `FrameRing`** — a
  fresh `streamId` so no stale GPU frame lands, the last HW frame held so
  there's no visible gap. A budget throw first gives the owning pool one
  ordered chance to reclaim retained capacity and retry hardware; only a retry
  that still loses admission takes the same SW path. The lane flips; nothing
  external fires and the swap key is unchanged. `currentLane()` reads the live
  lane for PerfHUD/diagnostics.
- **Total failure surfaces once.** Only if the SW transport also dies (or the
  component vanished after open) does `FfmpegSource` fire its single
  `onFatalError` → the Compositor re-resolves (`auto` → webcodecs, or →
  unsupported).

**HW allow-list + budget** (private to the engine). The HW lane is restricted
to a seek-validated codec allow-list — 8-bit H.264, HEVC, VP9. The GPU probe
decodes one forward frame, which proves the driver *can* hardware-decode but
not that the D3D11 session survives a backward seek; some drivers
hardware-decode codecs outside this scope (MPEG-2 is the known case) and hang
indefinitely on a backward seek. The allow-list encodes that seek-safety
dimension the one-frame probe can't test — a codec must be on it before its
probe is even kicked — but never overrules a probe's negative verdict. (The
underlying D3D11 backward-seek hang is a separate pre-existing gap the
allow-list routes around, not a fix — a tracked follow-up.) GPU admission
reserves two currencies before native allocation: at most five concurrent
sessions and at most `3 × 3840 × 2160` total coded pixel area. The area is
calibrated against the measured 30 fps fixtures; it is not pixel-rate because
source fps is not carried into admission. Thus five 1080p sessions fit, while a
fourth 4K session does not ([playback-perf](playback-perf.md)). Exhausting either
currency throws typed `hw-budget-exceeded`; the clip falls to the SW transport
rather than erroring and records no capability verdict, because admission
capacity is transient.

**Capability failures stay sticky; capacity spills do not.** A genuine HW
failure (device creation/loss, decode failure) marks that media software-only
for the rest of the app session; a total ffmpeg failure under `auto` marks the
media `webcodecs` for the session. Those verdicts do not re-promote. A budget
throw records no verdict, so it neither spreads to another clip on the same
media nor becomes a permanent property of this clip.

Above 1080p, only this capacity fallback gets the formal spill profile: the
smallest supported scale near a 960×540 target (quarter size for 4K) and half
cadence. Native still decodes every reference frame, but skips unselected
frames before copy-back, scale, packing and IPC. Device failures and native-size
mismatches use the ordinary software profile instead.

`Compositor` publishes one **priority epoch** before any active acquire or
upcoming prewarm: every currently active VideoClip plus every clip at the
nearest boundary inside the one-second lookahead, with both its base and
overlap-swap pool keys. A priority source that receives
`hw-budget-exceeded` may ask `SourceDecoderPool` to close only non-priority
FFmpeg hardware handles retained from older timeline regions. The pool awaits
each `previewGpu:close` through main's native close and budget-lease release
before `FfmpegSource` retries `previewGpu:open`; a fire-and-forget close would
race the same still-live lease.

If the priority set itself exceeds physical capacity, the rejected source uses
the spill profile without retry churn. When the playhead crosses the boundary,
the priority epoch changes: the just-departed hardware source is now
reclaimable, and any priority budget-spill handle is disposed and reacquired
through the normal pool path. That fresh open asks main for hardware again.
Thus the five-second idle retention remains useful in the ordinary case, but
cannot pin an about-to-play clip to software under measured budget pressure.

The live budget is readable — `previewGpu:budget` returns
`sessions.used/max`, `codedPixelArea.used/max`, and the latter's
`calibratedFps: 30`. The PerfHUD shows both currencies beside the per-clip lane
pills. This is diagnostic state, not an invitation to pre-check: main's
reservation is the authority. A clip reading `SW↓` next to newly available
capacity is a transient spill awaiting the next priority rebalance, not a
capability verdict.

**Two trails, logged separately.** `noteResolution` emits one LogBus row per
media per change of the resolved key, so an engine or source change (the
total-ffmpeg-failure case above, a proxy landing) leaves a trail. The lane needs
its own channel, because it is deliberately absent from that key (ADR 0030) and
putting it there would make hardware-vs-software an engine-level fact:
`noteLaneOpen` emits one `decode-lane` row per clip per hardware↔software
transition, naming the layer, the media, the lane left, the lane taken and the
reason — the `hw-budget-exceeded` overflow, a device loss, a capability failure.
Both trails log per *change*, never per frame: a first open, and a same-lane
re-open such as a playback-resolution change, are silent. A priority rebalance
that rebuilds a budget-spilled clip leaves the matching `software → hardware`
return row; capability-failure sessions never produce that return.

**Capability cache.** `<userData>/decode_capability.json` persists per-machine
probe verdicts across restarts, keyed by lane (`sw`/`hw`) and a
codec/pix-fmt/resolution-class string, so a source never re-probes a format
class it already answered. Each lane carries an `env` string — the component's
ffmpeg version for `sw`, the GPU + driver identity for `hw` — and a mismatch
wipes that whole lane's entries, since the machine truth it was measured
against changed. This is distinct from the session's sticky verdict above: the
cache answers "can this machine decode this format at all," the sticky verdict
answers "did this session's open just fail."

### The Lite engine (`SourceHandle`)

The Lite engine is WebCodecs decoding through the shared refcounted
`SourceMedia` (§[Decode](#decode) above) — the same `VideoDecoder` +
`FrameRing` pipeline every WebCodecs clip uses. On `original`, resolution
consults this session's WebCodecs-original probe: `ok` → decode the original
directly (no proxy), `untested` → `pending` while the probe kicks, `fail` →
`unsupported`. FFmpeg decodes any original, so this probe is consulted only on
`webcodecs × original`.

### Unsupported

`unsupported` replaces the old silent proxy floor: when the chosen engine
cannot decode the chosen source, the clip resolves to that first-class status,
the Compositor skips acquiring a handle and surfaces the media via an
`onUnsupported(mediaId)` notification, and PixiPreview renders a placeholder
card (not a black frame) with two actions: **Switch to Standard** and
**Generate proxy**. Switch to Standard shows only when the component is
available; on a no-component machine the card states the format is
unsupported by the Lite engine, with no switch. Generate proxy is shown
either way — it forces the per-clip proxy override on and enqueues an
on-demand build ([Proxies](#proxies)); once the quick proxy lands the clip
resolves through it (proxy playback is always the Lite engine, so this works
regardless of component availability) and the card clears. Copy is i18n'd
(en-US + zh-CN). In practice the Switch-to-Standard path is reached via a
pinned/absent Standard engine; the `webcodecs × original × fail` path depends
on the probe emitting `fail` rather than `untested`, which is a known gap.

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
runs in Rust ffmpeg — see [`docs/export.md`](export.md). The
Web Audio path is preview-only.

## Proxies

Proxy is a decode **source** the user opts into (the `source` axis of a
[resolution](#decode-engine)), never a tier the engine falls back to on its
own — the native-NLE convention (`feedback_native_nle_conventions`). The
opt-in is two-layered, both persisted on `ProjectSettings` and written through
the unrecorded `update_project_settings` mutation, so neither ever enters undo
history (`data-model.md` §ProjectSettings):

- **Prefer Proxies** — a project-scoped toggle, surfaced in the Settings
  panel (`prefer_proxies`). On, it prefers the quick proxy for every clip in
  the project that has one.
- **Per-clip override** — a control in the media pool (`proxy_overrides`,
  keyed by media id) that cycles **Auto → Proxy → Original → Auto**. Auto
  defers to the global toggle; Proxy/Original force that one clip regardless
  of the toggle. Hidden for `Bypass` sources (below).

The effective per-clip intent is `proxy_overrides[mediaId] ?? prefer_proxies`.
Preview uses the proxy only when that intent is true **and** the clip's quick
proxy exists on disk (`quickProxyPath`); otherwise it decodes the original.
That `proxyIntent(mediaId) && quickProxyPath(media) !== null` gate is the
whole safety net: a clip toggled onto proxy before its build finishes, or one
whose proxy gets cache-cleaned mid-session, falls back to the original with
no black frame and no special-case code, and a WebCodecs-unsupported original
still reaches [Unsupported](#unsupported) rather than silently proxying.

**Proxy always resolves to the Lite (WebCodecs) engine**, regardless of the
`decode_engine` setting — the quick proxy is 720p H.264 short-GOP,
WebCodecs-decodable by construction, so routing it through the Standard
engine would need a file path the proxy branch doesn't carry and buys nothing
on a source this light. One consequence: turning proxy on for a clip also
rescues the pinned-Standard / no-component case, since the proxy decodes via
WebCodecs no matter what `decode_engine` says.

Both the media-pool override's Proxy state and the Unsupported card's
**Generate proxy** action reach the same on-demand backend command,
`generate_quick_proxy(media_id)`, which enqueues the existing quick-proxy job
for a media that doesn't have one yet — a cache-cleaned proxy, or a source
that wasn't heavy enough to auto-build one at import. `Bypass` sources are
excluded: their Decode Route carries no `quick_proxy` slot and they're
already light (short-GOP H.264 ≤1080p), so there's nothing to generate. See
[`data-model.md`](data-model.md) and ADRs 0009–0011 for how the Decode Route
decides which derivatives exist for a source; the decode engine only ever
reads that decision, never writes it.

- **Quick proxy** — a 720p short-GOP scrub copy (`quick_proxy_path`),
  generated at import by `jobs/quick_proxy.rs` for sources heavy enough to
  need one, and on demand otherwise via `generate_quick_proxy`. Its short
  fixed GOP (`PROXY_GOP_FRAMES`) is what makes scrubbing frame-accurate: any
  scrub target decodes at most a few frames from its keyframe, bounding the
  seek-to-key-then-decode-forward tail (ADR 0008). This is the live preview
  source whenever the proxy axis resolves active.
- **Export master** — the full `proxy_path`, a source-resolution copy
  (ADR 0011) used only at export time; preview never reads it. Which file
  export decodes is governed solely by the persisted Decode Route, never by
  the preview proxy preference: `Bypass`/`DirectExport` export the original,
  `Proxied`/`NativeSw` export this master, and the `prefer_proxies` /
  `proxy_overrides` toggles — which only steer the preview axis — have no
  bearing on what export reads. For `Proxied`/`NativeSw` sources the export
  master is still what export reads today; routing those two routes to
  decode the original instead is separate work gated on export-side decode
  (see [`roadmap.md`](roadmap.md) §Decode engine).
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

For a per-stage breakdown rather than a single `composite ms` — including
the two costs that bracket lives outside, `setAnchorTime` and the Pixi
present — see [`playback-perf.md`](playback-perf.md), the multi-track
playback benchmark (operated per
[`playback-perf-runbook.md`](playback-perf-runbook.md)), and
`render/perf/stageTimers.ts`, the accumulator it reads. Note what the
HUD's **Dropped** counter cannot see: it judges whether the ring held a
fresh frame, so a loop stalled by a synchronous GPU drain reports zero
drops while looking visibly jerky.

## Render & Play

The "Render & Play" affordance kicks off the same Pixi+WebCodecs
pipeline used for export, writes the result to an OS temp MP4, and
opens an Electron window playing the file. It's the WYSIWYG
verification path when the user wants to see exactly what the export
will produce. The popup HTML lives at `/render-play.html`.
