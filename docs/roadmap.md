# Roadmap

The foundation is in place: the project state actor + history (TypeScript,
Electron main), the workspace on-disk format, media import with proxy /
thumbnail / waveform jobs, generated media-pool thumbnails with
large / grid / list layouts,
audio IR + ffmpeg export + final mux, PixiJS + WebCodecs renderer
(preview and export share one compositor), the Motif catalog
(built-in + user-authored, with an agent authoring loop over MCP),
speech-to-text over pluggable backends (OpenAI cloud + local whisper.cpp / FunASR sidecars) + cloud TTS
behind a provider-agnostic trait surface, deterministic cached shot / frame
analysis (`analyze_clip`, `compare_frames`, and `auto_split_by_shot`),
the MCP server (streamable-HTTP,
hosted in the Electron main) with its edit / workflow / speech tools and
its in-protocol change feed, the status-bar `LogBus` console, the i18n
stack (en-US + zh-CN).

This doc tracks what's left between here and v1. Detail per area
lives in the topical doc — this is the index.

## Open work

### Keyframes — authoring, sub-lanes, and MCP tools shipped; multi-select + extras remain

`Animated<T>` is live end-to-end. `AnimTrack<T>` flows through the
`LayerSummary` views and resolves per frame in the shared Compositor
(preview == export, golden-vector-locked engines), and **authoring
shipped**: a per-property stopwatch + auto-key in the inspector,
collapsed-mode diamonds on the clip (click-seek / drag-retime / delete /
interpolation menu), and the `update_layer_param_track(s)` actor surface
(normalized, recorded, undoable). **Expanded-mode per-property sub-lanes
shipped** too (`KeyframeLane`): twirl a track open on the header to
AE-style per-property rows (union of the keyframed properties across the
track's layers), each diamond click-seek / drag-retime / delete /
interpolation-menu, with out-of-range keys dimmed. Trim and split keep
keyframes content-anchored — non-destructive, out-of-range keys retained
(so the layer validator permits keyframe times outside `[0, duration]`).
Verified by an export-sampling e2e. The same authoring is exposed over
MCP — `get_param_track`, `set_keyframe`, `remove_keyframe`,
`retime_keyframe`, `set_keyframe_easing`, `smooth_keyframes`,
`clear_keyframes`, and a low-level `set_param_track` — over the
`update_layer_param_track` write path (timeline-absolute times), with a
shared Rust↔TS golden fixture locking the transform math (see
[`mcp.md`](mcp.md)).

What remains:

- **Multi-select keyframe editing in the sub-lanes** (timeline-redesign spec
  §5). Sub-lane selection and drag are single-keyframe today; the batch
  `update_layer_param_tracks` actor command exists but no UI rides it yet.
  Add marquee box-select and cross-property/cross-layer multi-drag (one undo
  via that batch surface), then the rest of the desktop-grade batch set on
  the same selection model: time-scale a selection about an anchor
  (stretch/squash a group of keys), copy/paste keyframes (serialize the
  selected keys, layer-local times rebased on paste at the playhead), and
  per-frame nudge.
- **A color stopwatch + MCP color keyframing.** `Animated<Rgba>` now
  interpolates end-to-end — OkLab + premultiplied alpha in the shared
  `weftcut-eval` engine (a native `value_at` twin plus a wasm packed-i32 preview
  shim, locked by a Chromium `color-mix(in oklab)` golden), wired through
  `resolveView` so keyframed text and color-fill color render in preview and
  export. What remains is the authoring surface: a color stopwatch in the
  inspector and the MCP color-keyframe tools.
- **Extrapolation modes.** Outside the first/last keyframe the value clamps
  to the endpoint (`native/eval/src/lib.rs`); there is no
  loop / ping-pong / continue — the first thing a user reaches for on looping
  overlays, Motifs, and text FX. Shape: an `extrapolate: { before, after }`
  enum on the keyframed track, honored in `eval` before the segment lookup;
  extend the golden fixture. Low effort; a schema addition (ship it with its
  `.vproj` migration — see the migration note below).
- **Per-keyframe tangent model — auto-bezier that stays smooth.** `interp` is
  owned by the *segment* (stored on the left keyframe), so a key's velocity
  is split across two records and `smooth_keyframes` is a one-shot bake:
  editing a neighbor's value or time does not re-smooth, so smoothed motion
  silently goes stale (unlike AE's auto-bezier, which re-solves
  continuously), and the model has no home for the per-key interpolation
  type (auto / continuous / bezier / linear / hold) every pro UI presents.
  Cheap option: keep the segment model and re-run `smooth_one` on affected
  keys behind a per-key "auto" flag. Proper option: promote `interp` to a
  per-keyframe `{ in, out, mode }` tangent record and derive segment beziers
  at eval time (schema + engine + UI + golden).
- **Spatial motion paths.** Position is two independent scalar tracks
  (`Transform.x` / `Transform.y`), which cannot represent a curved spatial
  path — arcs, roving keyframes, and orient-along-path are impossible;
  per-axis time-remaps only produce axis-aligned eased moves. Worth building
  only if WeftCut targets motion graphics (the Motif / text-FX direction
  suggests it eventually will): model position as a single `Animated<Vec2>`
  carrying per-key *spatial* tangents separate from the *temporal* curve,
  plus a viewport path editor. Structural — and the longer it waits, the
  more keyframe data has to migrate, so flag the decision early even if the
  build stays deferred.
- **Keyframe minor / cleanup.** Animatable anchor (`Transform.anchor` is a
  static pair, so the pivot can't be keyframed — fold into the vector type
  when convenient); the `"ease"` preset loses its named identity on reload
  (stored as a raw `Bezier{p1,p2}` while EaseIn/EaseOut are named variants);
  the curve-graph UI still hand-mirrors the Rust bezier solver in one JS
  `unitBezier` (`src/renderer/render/animated.ts`) — have it call the wasm
  `unit_bezier` instead (kills the last non-audio twin); and **schema
  migration**: pre-release currently hard-rejects old `.vproj`, and the
  extrapolation / tangent / motion-path items above all touch the keyframe
  schema — once the format ships, each needs a migration planned with the
  feature, not after.

See [`data-model.md`](data-model.md).

### Effect subsystem — beyond v1

The per-layer effects subsystem ships v1: per-sprite Pixi filter chains
driven by a `layer.effects` field — the Blur and Chroma Key filters, scalar
(`Animated<f64>`) params, the `add_effect`/`update_effect`/`move_effect`/
`remove_effect` actor + MCP surface, keyframe support via the param key
`effects[<id>].params[<key>]`, a `preview_effects_enabled` LOD toggle, and an
inspector effect editor (chain list / filter picker / per-param keyframable
rows on every visual kind). See
[ADR 0027](adr/0027-per-layer-effects-pixi-filter-chains.md) and
[`render.md`](render.md). Remaining:

- **Grow the filter catalog** beyond Blur and Chroma Key (brightness /
  contrast / saturation, then the wider pixi-filters set). Each filter is one
  `effectRegistry.ts` entry, classified `f16-verified` or
  `precision-reduced` by the GL-parity gate.
- **Chroma Key v2 — keyer quality**, in priority order: despill bias color
  (preserve skin tones under heavy spill; 3 scalars), clip rollback (recover
  edge detail lost to levels clipping), despot + large-radius softness
  (needs a matte-texture multi-pass — shared infrastructure with IBK),
  IBK-style clean-plate mode (per-pixel local screen color for unevenly lit
  screens), and linear-light keying (rides colorspace bracketing). Out of
  scope for the keyer: ML background removal is a separate feature — and a
  licensing landmine: RVM is GPL-3.0 and @imgly/background-removal is
  AGPL/commercial, both incompatible with the open-source licensing plan, so
  it needs a license-clean model plus an offline-analysis + cached-alpha
  architecture; garbage/holdout masks belong to a general masking feature;
  and no shader code may be ported from OBS/Natron (GPL) — algorithm math
  from public literature only.
- **Non-scalar params** — a `ParamValue` sum type (color / bool / enum);
  v1 is scalar-only. Animated color params can now reuse the `Animated<Rgba>`
  interpolation engine (OkLab, shared `weftcut-eval`); what's missing is the
  `ParamValue` lowering through the effect-param surface.
- **Preview-effects LOD toggle UI** — the inspector effect editor (chain
  list / filter picker / per-param keyframable rows) ships; what remains is a
  UI control for the `preview_effects_enabled` toggle (still AppSetting /
  MCP-only).
- **End-to-end filtered-10-bit-export gate** — the parity gate proves the
  f16 filter-pool technique (ADR 0022), not a full filtered 10-bit export.
- **`Speed`** is time remapping, not a filter — it stays out of
  `layer.effects` and needs its own design.

### Caption sidecar / soft-subtitle export

Caption cues imported from SRT/VTT/ASS become `Text` layers on a
caption-role track and burn into the video through the normal
`TextSprite` compositor path — no separate ffmpeg stage required.
What remains as a deferred follow-up: soft-subtitle tracks
(stream-muxed SRT/ASS into MKV or MP4) and sidecar file export for
containers that carry a subtitle stream. The data is already in `Text` layers;
the work is an ffmpeg subtitle-mux stage on top of the existing
export pipeline.

### Export decode redundancy — resolved, nothing actionable left

Export decode dispatch sits ON the inherent floor across the timeline
shapes that used to thrash (single clip, sequential source re-use,
different-phase overlap, mid-GOP range entry) — measured via the
worker's `__weftcutExportPerf` counters during development. The
phase-keyed pipeline
grouping in [`render.md`](render.md) collected the old "up to ~4.35×"
lever; what remains is inherent cost, not waste: a different-phase
overlap decodes one pass per phase (sharing would need a ring deeper
than the WebCodecs buffer pool), and a mid-GOP entry decodes from the
GOP key (long-GOP sources, unavoidable without re-keyframing).
Revisit only if Speed / reverse playback lands — a backward-marching
source mapping is the one shape the forward-only pipelines don't
cover. Preview keeps its own sibling item (warm-decoder handoff
across sequential cuts, designed in [`render.md`](render.md)).

### Decode engine — export-side decode, session split

Preview decode collapsed to two engines (Standard/`ffmpeg`, Lite/`webcodecs`)
with hardware-vs-software private to the Standard engine's `FfmpegSource` (see
[`preview.md`](preview.md#decode-engine) and
[ADR 0030](adr/0030-decode-engine-overlay-and-native-component.md)). Proxy
source activation — the per-clip override, the project-wide Prefer Proxies
toggle, and the on-demand generate-proxy command that back the `source:
original | proxy` axis — is built; see [`preview.md`](preview.md) §Proxies
for how the resolver picks proxy vs. original today. Export-side decode and
the preview/export session-interface split have shipped; one piece remains
deliberately deferred:

- **Export-side decode consumes the overlay — done.** Export decode routes
  through the same engine overlay: `resolveExportDecodeRouting` freezes a
  per-media routing table at export start from the per-project `decodeEngine`
  intent (an `ffmpeg` pin degrades to `auto` when the component is absent), so
  blind-spot and pinned-Standard sources export from their originals over a
  credit-windowed native session instead of the lossy full-proxy, and skip the
  pre-export proxy wait. See [`render.md`](render.md) §Export source
  resolution, [`export-ipc-transport.md`](export-ipc-transport.md) (both
  directions of the raw-frame transport), and
  [ADR 0033](adr/0033-export-decode-joins-the-engine-overlay.md).
- **Preview/export session-interface split — done.** The shared interface was
  split into a minimal `DecodeSession` core plus named `PreviewDecodeSession`
  and `ExportDecodeSession` roles, extracted to `decoder/session.ts`. Preview and
  export no longer share one bloated contract; `ExportDecodeSession` names the
  export Worker's driving surface (`decodeRange`/`evictBefore`) as an explicit
  contract.
- **Unified `DecodedFrame` metadata/ownership — resolved as a type-honesty
  pass.** The union, its guards, and the dims helper live together in
  `decoder/decodedFrame.ts`, and `VideoClipSprite.updateFrame` accepts only
  the `BrowserConvertibleFrame` subset (compile-time exclusion of the
  CPU-plane kinds). The remaining per-kind differences are deliberate design,
  not debt: `close()` is uniform across all four kinds, the stores own
  `ptsUs`/`durationUs` in their entries (an `ImageBitmap` cannot carry PTS),
  and each kind's color fields follow its conversion path (ADR 0032). A
  metadata-envelope wrapper and an NV12/I420P10 type merge were evaluated and
  rejected — per-frame allocation on the preview hot path, and the two
  CPU-plane types' parallelism is honest (different layouts, shaders, and
  target texture formats).

The export-decode lane's deliberate scope cuts, in rough leverage order — the
v2 debt list:

- **4:2:2 chroma transport + compositing.** v1 swscales ProRes 422 to
  I420P10, halving vertical chroma before RGB conversion (the same cost
  preview eats); the faithful 422 ceiling needs a 4:2:2 transport format plus
  composite-chokepoint support.
- **Native session rebuild-once + abort UX.** The design admits exactly one
  same-engine session rebuild before an export aborts, with the failing source
  named and a Lite re-run suggested; today the native lane fails loud on the
  first surfaced session error with the generic export-failure message.
  Cross-engine/cross-source mid-export fallback stays forbidden either way
  (ADR 0033).
- **Hardware-lane readback** for export decode — not designed;
  profiling-gated.
- **Concurrent native-session caps** and any decode memory budget beyond the
  per-session credit window.
- **Per-clip decode-engine overrides** in the export dialog — the routing
  table's per-media shape leaves room for them.
- **Cross-machine bit-reproducibility gate** (the `ffmpeg` pin + software
  encode promise) — needs two-machine baseline management; build it as a
  permanent harness once the path has settled.
- **Routing decodable sources through native for performance** (the re-seek
  redundancy motive) — `auto` deliberately keeps them in-worker; revisit with
  profiling.

The native-decode component ships on **Windows, Linux, and macOS**; each
platform stages its own LGPL-shared ffmpeg runtime (macOS builds ffmpeg 8.1
from the pinned source tarball — see `fetch-ffmpeg-lgpl.mjs`). Where the
runtime is absent, the Standard engine is simply unavailable (`auto` resolves
to Lite) rather than broken.

### Preview playback smoothness — the walls are measured, and all but two are gone

[playback-perf](playback-perf.md) profiles the whole preview loop under N
tracks across 1080p/4K × ffmpeg-hw / ffmpeg-sw / WebCodecs. The headline is
that **the compositor is not the problem**: `PlaybackEngine.tick` plus the
Pixi present run 2–6 % of a 16.7 ms budget in every cell measured, while the
tick *interval* p99 reached 38–140 ms. Every wall was in frame delivery, in
retained memory, or outside the loop entirely, and each one below was named by a
measurement rather than a guess — which is also why all but one turned out to be
ours rather than a platform limit.

Where the 1080p hardware lane carried 2 simultaneous tracks and 4K carried
none, they now carry 5 and 1 reliably; a second 4K track is intermittent rather
than a stable ceiling. What each fix bought, and the landmine it left:

- **The hardware lane's read barrier was the whole multi-track wall** — and it
  took two passes to remove, because the first one only moved it. The lane blocks
  until Chromium's cross-device read of a shared-texture slot has GPU-completed,
  or native overwrites the slot mid-read; spelled as a synchronous 1px readback
  that cost a flat **19–21 ms per delivered frame per session**, roughly 20× the
  entire composite-plus-present CPU. Deferring the ack behind a `fenceSync` freed
  delivery (2 → 4 tracks at 1080p), and then the fence's own deadline **spin** —
  WebGL2 offers no blocking wait, so the drain had to flush-and-poll, and on an
  idle GPU that poll was what *completed* the fence — turned out to cost the
  remaining tail. Taking the completion signal on the renderer's presented WebGPU
  device removed the spin entirely: 4K went 0 → 1 reliable track and that track's
  tick p99 23.5 → 17.3 ms, matching a barrier-less control. Landmines it leaves:
  the barrier is **size-independent**, so do not re-try shrinking the sampled
  region; the WebGPU completion signal lands ~90 ms out regardless of load, so a
  wider deadline buys a slot-hold throughput ceiling instead of correctness; and
  the ack must be released on the deadline anyway, because `pool_size` stranded
  slots wedge a session for good. See [preview](preview.md).
- **The software lane seeked on every request**, re-walking the GOP prefix — 137×
  decode amplification on a 240-frame GOP — which is why long-GOP and 10-bit
  sources were unusable rather than merely slow. A forward-continuation cursor
  plus a lookahead horizon in the native pump took 1080p 0 → 2 tracks, ProRes and
  10-bit HEVC 0 → 1, and main-process CPU 31.7 % → 2.6 %. The transferable part:
  **a renderer-side counter cannot see producer-side waste** — the fate table read
  clean on a starved cell because the waste was spent inside libavcodec and
  discarded before any frame reached the ring.
- **The WebCodecs multi-track collapse was a re-seek livelock in our own reset
  policy**, not decoders dying: a clip falling 1 s behind triggered a
  far-forward reset that flushed the ring and seeked up to 8 s back, which
  guaranteed the next reset. The latch that should have stopped it was keyed to an
  exact target, and under playback the target changes every frame — so it only
  ever protected the paused case. Re-keying it onto the key packet took 3 tracks
  from 73.5 % drops to 0.00 % with 254 ring flushes → 0.
- **`FrameRing` is budgeted in bytes** (`decoder/frameRingBudget.ts`): a 1 GiB
  total shared across live rings, as backpressure on the FORWARD fill only. It is
  a ceiling for the pathological case, **never a tuning knob** — three measured
  don't-redos: a budget tight enough to clamp 1080p makes things *worse* (512 MiB
  drove drops 7.2 % → 55.5 %, because evicted frames get re-requested and one
  re-seek re-decodes an 8 s GOP), trimming *lookbehind* on byte pressure fails the
  same way, and halving retained bytes left the 4K tick tail untouched — retention
  was never the 4K cause.
- **The dropped-frame indicator can see judder.** The tracker judged whether the
  ring *had* a fresh frame, so a stalled loop read **zero drops while looking
  jerky**. It now counts a second cause beside drops — a composite tick arriving
  past the frame budget — free on the playing path. The threshold is additive
  (`budget + 4 ms`) and bounded on both sides on purpose: a multiplicative 1.25×
  lands at 41.7 ms and silently misses the 38.8 ms cell it exists to catch.
- **A clip that changes lane says so** (`decoder/ffmpegLaneTrail.ts`): one
  `decode-lane` LogBus row per clip per hardware↔software transition — the lane
  left, the lane taken, and the reason. The one transition it never reports is the
  return *from* a budget overflow, because that return does not happen: lane
  selection runs once per decode session and the session outlives the timeline edit
  that would free a slot, so an over-budget clip stays on software until its source
  is rebuilt — a reload, a re-import, or the pool's idle sweep.
  [preview](preview.md) records that as a documented limit, and the live session
  count is readable beside the lane pill so the state is at least legible. It is a
  separate channel rather than a field on the resolved key, for the same reason
  routing the overflow to WebCodecs was rejected: either would make
  hardware-vs-software an engine-level fact, and
  [ADR 0030](adr/0030-decode-engine-overlay-and-native-component.md) makes it
  private to the Standard engine.
- **GPU admission has two currencies.** The old fixed session count was
  simultaneously right at 1080p and unsafe at 4K. Main now atomically reserves a
  hard five-session ceiling plus `3 × 3840 × 2160` of total coded pixel area
  before native allocation. The area is explicitly calibrated at 30 fps, not
  described as pixel-rate because source fps is absent from the contract. Five
  1080p clips therefore stay hardware, while only three 4K clips do. A 4K budget
  spill ships quarter-size software frames at half cadence, skipping before
  copy-back/packing/IPC so two spills no longer create the old byte flood. The
  [order gate](preview.md#decode-engine) derives its largest fixture-specific
  concurrent count from both live currencies. It passes all eight
  `rendererFence` cells and, under the deliberately incorrect `none` barrier,
  fails all five pixel-checking cells on mismatches only while the budget,
  fallback and software controls stay green.

**Still open — what stops the renderer's main thread while delivery is perfect.**
Two cells fail on the tick tail alone with 0.00 % drops: 4K WebCodecs at one track
(tick p99 75 ms) and 1080p ffmpeg-software at three (p99 67 ms). The loop is not
overrunning its budget and it is not being starved of frames — **the whole thread
stops.** An 8 ms `setInterval` loses its cadence with the tick, 85–107 ms at a
stretch, in exactly those cells and holds a perfect p50 8.0 ms in every passing
one, so nothing about rAF delivery or ticker scheduling can explain it. Nor can
our JS: across 96 long animation frames there is not one script over the reporting
floor, `longtask` never fires, and 89–99 % of each long frame is spent *before* the
frame reaches its rendering steps — outside Chromium's task accounting entirely, at
1.5–8.1 % of one core, so the thread is waiting rather than computing.

Each cell is bound to a different half of the per-frame resource path, by control
rather than by suspicion. The **software** stall follows the bytes: the same
three-layer 1080p composition is smooth on ffmpeg-hardware and on WebCodecs and
stutters only on the route that ships decoded NV12 across the process boundary
(~280 MB/s), and shrinking those bytes 16× makes the cell perfect. The
**WebCodecs** stall follows the size of each `ImageBitmap`: 4K hardware is smooth
on the same canvas with the same decoder load, and the stall count scales with the
allocation (4.0×) rather than the bandwidth (1.34×). Excluded by matched pairs: the
canvas, the raster, the composite, retained bytes, GPU-process memory, GPU engine
saturation and Pixi's GC. The next instrument is a `toplevel` trace of
`CrRendererMain` — collectable from the harness through `contentTracing`, no
`chrome://tracing` needed — asking what covers the 100 ms hole. Not a GPU-process
trace: the GPU's engine counters are identical between the matched smooth and
stuttering cells.

A third cell fails on the tick tail alone **without** the blocked-thread half of
that signature, but intermittently rather than deterministically. After the quiet
gate was fixed to require both low app CPU and no pending derivative jobs, repeated
4K ffmpeg-hardware pairs were 5/5 smooth at one track (tick p99 16.9–17.2 ms) and
3/5 smooth at two tracks (17.5, 17.6, 27.9, 38.9 and 40.5 ms across all five runs).
Both red two-track cells held a healthy 8 ms timer (p50 8.0 ms, nothing over 50 ms)
and 0.00 % drops while `rafInterval` p99 reached 33.3–33.4 ms, about 2× vsync: the
thread was alive, and what it lost was rendering opportunities. Earlier 67–68 ms
samples, which suggested a 4×-vsync tail, are invalid because the CPU-only quiet
gate admitted measurement while derivative jobs were still running. Same
instrument, other branch of the decision tree.

**Implemented and verified on both codecs.** The fixed-cap landmine above is
now the two-currency admission policy plus the formal spill. On the
production-shaped candidate, three current-build HEVC repeats at four tracks
(3 GPU + 1 spill) and three at five tracks (3 GPU + 2 spills, final replay
state gate) all held 0.00 % drops, live rings and zero timer gaps over 50 ms;
five-track tick p99 was 17.0–18.3 ms. These are deliberately mixed,
`routePure: false` cells.

The original cliff was measured with 4K H.264, and the formal main-worktree
H.264 set on `84182572` — three four-track and three five-track
replay-state-gate cells — now holds the same shape: expected mixed lanes with
zero drift, 0.00 % drops in all six (improving on the isolated prototype's
3.16–3.66 % at five tracks), every ring tracking at close, zero timer gaps
over 50 ms. Both track counts still read STUTTER on the tick criterion alone
(p99 43.8–58.0 ms with the live-thread, no-script signature) — the 4K
two-track intermittency recorded above, present at every cap and provably not
budget-attributable, tracked separately rather than folded into this
acceptance. [playback-perf](playback-perf.md) carries the policy, evidence
filenames and exact limitation.

One decision this data settles and one it does not:

- **Settled — the `auto` default stays `ffmpeg`.** WebCodecs used to out-play the
  Standard engine on 8-bit ≤1080p, and the whole of that was the read barrier.
  With the barrier off the critical path the ordering reverses: measured in one
  sitting, 1080p max smooth tracks are H.264 **5** on ffmpeg-hw against 2 on
  WebCodecs, and HEVC **5** against ≥5 — the hardware lane's five HEVC clips all
  taking hardware, at 0.00 % drops and tick p99 18.10 ms against a 33.3 ms
  budget. Since
  [decode-bench](decode-bench.md) already gave ffmpeg the decisive **seek**
  advantage, `auto` now wins both axes, and picking per-*interaction* has lost
  its motive while keeping its cost: the swap key is
  `${engine}:${source}:${target}`, so flipping engine on a play/scrub transition
  is a visible swap by construction. Reopening this needs a second box that loses
  on sustained playback **and** loses on seek; one without the other is what
  reopened it before.
- **Open — 10-bit ingest.** `TenBitIngest` never fires on the software route (the
  transport ships NV12 by ADR 0029), so the 10-bit preview path is 8-bit. It is
  no longer slow — that leg plays one track at content rate since the lane
  stopped re-seeking per request — so what remains is purely whether the fidelity
  gap is worth a 10-bit ship format. A colour question, not a performance one.

Measured non-levers — do not spend time here: the snapshot blit
(`blitDrawImage` mean 0.02–0.03 ms), `ringLookup`, the audio sweep,
`stage.removeChildren()`, and the effect-chain sync are each ≤ 3 % of a
sub-millisecond tick; `nv12Ingest` is negligible at 1080p (p95 1.3 ms) and only
becomes real at 4K (p95 9.0 ms); and the GPU's VideoDecode engine sits at ~5 % per
1080p hardware track, so no decoder is saturated at that resolution. 4K is the
exception on both counts, and it is the open item above.

### Zero-copy GPU frame upload — deprioritized, measure first

Export composites a decoded `VideoFrame` by snapshotting it into a 2D
`OffscreenCanvas` (`VideoClipSprite`) before Pixi uploads the canvas.
The snapshot exists because Pixi's raw-`VideoFrame` upload
(`copyExternalImageToTexture`) ignores the frame's `colorSpace` and
converts every frame as BT.709/limited — a destructive pixel
mis-convert for 601 / full-range sources (screen recordings, phone
footage), not a repairable tag error. The prohibition and both
surfaces' conforming paths are documented in [`render.md`](render.md)
("the snapshot rule") and ADR 0014.

**Deliberately parked at lowest priority.** Color correctness is fully
handled today at zero marginal cost — the snapshot *is* the honoring
conversion. What zero-copy would buy is removing one per-frame blit in
offline export, a cost that is bounded, unmeasured, and instrumented
(`__weftcutExportPerf` `compositeMs`); the full replacement is heavy
(bespoke Pixi pass, a permanent WebGL dual-path, external-texture
sampling limits, a fresh conformance pass). Do not start without
profiling showing the blit matters (4K export is where it would).

**On the preview side that profiling now exists, and it says no.**
[playback-perf](playback-perf.md) brackets the snapshot blit as its own
stage: `blitDrawImage` means 0.03 ms per frame at 1080p and 0.02 ms at
4K, p95 ≤ 0.2 ms — a rounding error against a 16.7 ms budget, and a
small fraction of a `tickTotal` that is itself 2–6 % of budget. Preview
judder is elsewhere entirely (the hardware lane's read barrier, the
FrameRing's byte budget, composition-resolution raster). Export remains
unmeasured and is still the only case that could justify this work.

If profiling ever justifies it, the staged plan:

1. **colorSpace-routed hybrid first.** The raw upload's fixed-function
   conversion is *correct* for bt709/limited frames — the dominant
   content class. Route in `VideoClipSprite`: raw-bind frames whose
   `colorSpace` is bt709/limited, keep the snapshot for everything
   else. One branch plus one analyzer run; no custom shaders, the
   conformance gate stays untouched.
2. **`importExternalTexture` as last resort.** A standalone POC (run
   during development via a since-retired diagnostic) confirmed
   Chromium/Electron HONORS the matrix through `importExternalTexture` +
   `textureSampleBaseClampToEdge` (601 and 709 sample to distinct RGB),
   so full zero-copy is *possible* without losing color correctness.
   The design work it defers:
   - **Custom Pixi pass.** Pixi's `TextureSource` model only does
     `copyExternalImageToTexture`; it never imports an external
     texture. Needs a bespoke `GpuProgram` + bind group re-importing
     the per-frame `GPUExternalTexture` (it expires each frame).
   - **WebGL fallback.** `importExternalTexture` is WebGPU-only. The
     export's WebGL path (no `navigator.gpu`) keeps the snapshot, so
     both paths coexist permanently.
   - **Sampling limits.** External textures sample only via
     `textureSampleBaseClampToEdge` — no mips, bilinear only — so
     heavily downscaled clips lose filtering quality vs a canvas
     texture; large-downscale sprites may need the snapshot anyway.
   - **Color-management exactness.** `importExternalTexture` does a
     full matrix + primaries/transfer → sRGB conversion whose exact
     output differs from `drawImage` on chromatic values; the external
     texture's `GPUExternalTextureDescriptor.colorSpace` is the lever.
     Whichever path ships must re-pass the color-conformance gate (the
     analyzer is the arbiter), watching the non-primary patches where
     any primaries residual surfaces.

### macOS and Linux verification

The PixiJS + WebCodecs path runs in Electron's bundled Chromium, the same
engine on every OS, so browser behavior no longer diverges per platform.
The 3-OS CI matrix (`electron-ci.yml`) covers the structural cross-platform
work: it builds the napi addon + renderer + main bundles, packages an
unsigned installer, launches the app headlessly, fetches the platform's
static ffmpeg, and gates cross-OS *motif-render* determinism (byte-identical
captures, SSIM) on Windows + Linux + macOS.

What CI's headless, fixture-free runners do not exercise — and what remains
to verify on real macOS + Linux hardware:

- **Cross-platform video decode + export conformance.** The conformance and
  export e2e specs self-skip in CI: no fixture media is generated there and the
  export-disabling hook is set, so WebCodecs / mediabunny decode of real proxies
  and the ffmpeg encode + mux exit have only been gated on Windows. Run the
  conformance + export suite (`npm run fixtures`, then the e2e) on macOS and
  Linux to confirm frame-identical decode and conformant output.
- **Hardware decode / encode + real-display color.** CI runners are headless
  (xvfb on Linux) and lack a representative GPU, so they exercise the software
  codec paths only. A human smoke pass on real hardware covers the hardware
  WebCodecs paths and the display color the runners can't.
- **Runtime `ffmpeg-sidecar` auto-download.** CI fetches ffmpeg through its own
  build script; confirm the app's first-launch auto-download (and the proxy
  SOCKS fallback in [`setup.md`](setup.md)) works on a clean machine.

### Human UI parity — state / MCP capabilities still missing desktop surfaces

This is the audit of editing capabilities that already exist below the
renderer but cannot be completed in the normal human workspace. It is not a
blanket requirement to put every agent-orchestration primitive in a menu:
`dry_run`, history locks, and session setup can stay agent-facing. The
project-content workflows below need a human surface.

**P0 — core project editing:**

- **Track lifecycle and ordering.** `add_track`, `remove_track`, and
  `move_track` are implemented and undoable; the normal track header exposes
  only visibility / lock-style flags. Add an always-visible add affordance,
  insert-above / insert-below and move-up / move-down (or drag-reorder)
  actions, plus a confirmation that explains non-empty forced deletion.
- **Markers.** Point and region markers have add / update / remove state and
  MCP paths; search can navigate to them and the agent-mode mini timeline can
  render them. The normal timeline still needs marker rendering and hit
  targets, add-at-playhead, drag / region-resize, label + color editing, and
  delete.
- **History and checkpoints.** The normal workspace stops at Undo / Redo even
  though `project://history` exposes the commit log and named checkpoints can
  be created, listed, and restored. Ship a dockable history panel with actor
  badges and current-cursor state, plus create / restore checkpoint actions.
  The agent-mode record panel is useful partial UI, but it is available only
  inside an agent-started session and is not the general history surface.
- **Media-pool removal.** `remove_media` safely rejects referenced media and
  supports an undoable forced cascade, but the media pool has no delete
  action. Add Remove, show the referencing layers when blocked, and require a
  specific confirmation before the force path.

**P1 — workflows and project configuration:**

- **Analysis, transcription, and voice workflows.** `analyze_clip`,
  `detect_silences`, `transcribe_clip`, `synthesize_speech`, and
  `auto_split_by_shot` ship as compute / MCP workflows. File-based subtitle
  import already gives humans one caption path, and the media pool has an
  **Analyze shots** cache-warming button, but there is no normal UI to inspect
  the returned ranges / shots, tune parameters, preview a proposal, or apply
  split / delete / caption / voiceover actions. Build one reusable
  review-before-apply workflow surface rather than one opaque button per
  tool.
- **Composition settings after project creation.** `set_composition` supports
  dimensions, frame rate, sample rate, channel count, color space,
  background, and duration. Settings currently exposes only duration once a
  project exists; surface the remaining fields with the existing validation
  and composition-lock errors.
- **Video-description configuration and results.** `describe_clip` and the
  VLM configuration stores exist, but the renderer has neither provider /
  model / endpoint settings nor a place to inspect generated descriptions.
  Either expose both in Settings + an analysis result view, or explicitly
  designate this as an agent-only workflow.

**P2 — completeness and discoverability:**

- **Group maintenance.** Create / dissolve are human-operable, while add
  members, remove members, and rename remain state / MCP-only. Add these to
  the selection or group inspector once the multi-selection model settles.
- **Settings and authoring polish already tracked elsewhere.** The
  preview-effects switch is in the Effect subsystem section; keyframe batch
  editing and color authoring are in Keyframes; transition discoverability
  and chip operations are in Transitions. Keep those as one source of truth
  rather than duplicating them here.

### Polish

- Error toasts with structured-error options ("Create new track" /
  "Trim existing") instead of raw text.
- Onboarding tour on first workspace open.
- App icon, splash, About dialog.
- Crash reporter (opt-in).
- Motif-picker thumbnails for the remaining starter Motifs
  (rendered lazily via a CDP still; verify each Motif renders end-to-end
  through the picker → export path).
- Drive the menus from the command registry
  (`renderer/commands/registry.ts`, see
  [features.md §Global search palette](features.md#global-search-palette)) so
  `ACTION_DEFS` and the menu markup stop being parallel books; while there,
  render platform-pretty shortcut hints (`⌘K` / `Ctrl+K`) in the palette and
  menus instead of the raw chord string.
- Status-log deferrals ([status-log.md](status-log.md)): a "Generating
  derivatives (N)" aggregate row in the status bar, which then replaces the
  project-bar derivatives pill (removing the pill first would lose the
  specific signal); tool-level Started/Ok log wraps for the remaining
  long-running MCP tools (`synthesize_speech`, `detect_silences`);
  derivative-job log producers (proxy / thumbnails / waveform); console list
  virtualization (`react-window`) only if profiling shows real cost; a
  drag-to-resize handle for the console (height is fixed at 40vh; the CSS
  cursor is set but no pointer-drag handler is wired).

### MCP tool gating

The `tool_table!` macro registers tools at compile time, and the
catalog has no per-session filter. Unconfigured speech tools are listed
and return actionable "not configured" errors instead of being hidden. The refinement
is to omit unsupported speech tools from the advertised catalog
entirely, keyed on which providers are configured.

### Frame and shot analysis — agent tools shipped; human review / apply remains

`analyze_clip` now ships a deterministic shot report over a VideoClip's
source, preferring the 720p proxy: cleaned shot boundaries, representative
frame times, brightness / motion / sharpness statistics, black / freeze /
fade flags, and raw cut scores. Reports are content-addressed in the VSHOT
cache; `media://{id}/analysis` exposes the default whole-source report.
`compare_frames` ships the pairwise pHash-Hamming + MSSIM comparison, and
`auto_split_by_shot` consumes the same cached report to split a layer in one
undoable commit (optionally dropping short results).

The remaining product work is the human workflow called out in UI parity:
the media-pool **Analyze shots** action currently warms the cache and shows
only a pending state. Add a shot list with cover thumbnails, scores / event
flags, click-to-preview, sensitivity + minimum-shot controls, explicit
apply-as-splits / apply-as-markers actions, progress, and actionable errors.
`compare_frames` can remain an agent / diagnostic primitive unless a concrete
human deduplication workflow needs it. The heuristic detector stays behind
the `SceneDetector` seam so a learned implementation can be evaluated later
for gradual-transition accuracy without changing the tool contract.

### Transitions — v1 shipped; named deferrals remain

Transitions ship end-to-end for visual layers: **Crossfade**, **Wipe**, and
**Slide** (direction = motion direction — see the
[CONTEXT.md glossary](../CONTEXT.md#transitions)) between any mix of visual
layer kinds. Every kind renders through one two-input compositor node — both
participants bake, with their own transform / opacity / effects applied, into
pooled composition-sized render textures, and a full-frame quad composites
them with a per-kind shader at the track's z-slot; preview and export share
the path, gated by the transitions-WYSIWYG e2e. Authoring: right-click at a
cut on the timeline, a chip straddling the join (Delete key removes), an
inspector kind / direction / duration editor, and the
`add_transition` / `update_transition` / `remove_transition` MCP tools;
default duration is 1 s snapped to whole composition frames. Edits that break
a transition's overlap drop it via reconcile-on-commit — visibly logged, one
undo restores edit + transition, no shrink-back — while a split inside a
transition is blocked atomically; insufficient tail handle is a named
pre-check error carrying the available microseconds. See
[ADR 0035](adr/0035-transitions-two-input-node-reconcile-on-commit.md).

The named deferrals:

- **Push** kind (an enum variant + shader on the existing node: slide's
  boundary plus outgoing translation).
- **Wipe edge softness** (additive uniform + slider).
- **Easing / keyframeable progress** — progress is fixed linear; easing is an
  additive parameter reusing the keyframe bézier infrastructure.
- **Center-at-cut / end-at-cut alignment** — alignment is start-at-cut only;
  the variants are additive parameters.
- **Freeze-frame handle padding** (Premiere's repeat-last-frame when the
  outgoing clip lacks tail media; needs decode-session past-tail clamping).
- **Audio equal-power crossfade** — Crossfade kind only, on the
  WebAudio-preview + Rust-mixer twin seam (a second and third evaluation
  surface on the golden-guarded audio twins).
- **Policy C — the transition rides the trim**: individual mutations become
  transition-aware, reconcile degrades to a backstop (upgrade path recorded
  in ADR 0035).
- **Authoring discoverability and chip operations.** Add-transition currently
  lives in the cut context menu; add a more discoverable entry point, a chip
  context menu, and chip edge drag-resize (duration edits currently go
  through the inspector or MCP).
- **Transition-specific error for blocked in-transition splits** — the
  atomic rejection surfaces as the generic `LayerOverlap` error.

## v1 ship checklist

- [ ] All open-work sections above resolved or deliberately deferred.
- [ ] Linux: feature-complete or documented degraded mode.
- [ ] CI green: build + lint + unit + integration on all platforms.
- [ ] Code signing on Windows + macOS.
- [ ] Auto-update wired (`electron-updater`).
- [ ] Docs site live with Getting Started + agent connection guides.
- [ ] At least one third-party MCP client tested (Cursor or Cline
      alongside Claude Desktop).

## Post-v1 (not committed)

- Tree-of-edits history (branch, merge).
- WebGPU compositor backend tuned for real-time effects.
- Marketplace / remote sharing for user Motifs (the current feature is
  deliberately local-only — no registry).
- Multi-window timelines.
- Mobile companion (React Native or similar).
- Remote-server MCP variant (Tailscale-friendly) with proper auth.
- Plugin system for third-party effects via WebAssembly.
- Collaboration (CRDT-based shared editing).
- **HDR preview sink and wider-gamut working space.**
  The native encode exit exists: the 10-bit pipeline's Rust video sink
  (`export/videosink.rs`, native IPC → ffmpeg rawvideo → Main10
  encoder) ships the ffmpeg encoder surface that was the main prize of the
  old "native Rust export backend" item. What remains gated on the HDR-
  deliverable trigger is: (a) the **HDR preview sink** — `rgba16float`
  WebGPU canvas with `toneMapping:{mode:'extended'}` in Pixi; this requires
  the Pixi WebGPU pipeline-cache patch (tracked upstream as PR #12020 /
  issue #12019) or the verified runtime override, plus real HDR-glass
  verification on Windows; (b) the **wider-gamut working space** — evolving
  ADR 0021's ingest chokepoint from display-referred BT.709 to a scene-light
  or wide-color-gamut space, which changes blending semantics and needs a
  full conformance re-pass. Both remain post-v1 and both gate on HDR output
  becoming a real deliverable requirement.
  v1 10-bit export ships **experimental** (UI-labeled, with an export-time
  confirmation gate). The headline gap is preview fidelity: there is no
  HDR/wide-gamut preview on the web platform, so the 8-bit/SDR preview is
  not guaranteed to match the 10-bit file — compounded by sub-realtime
  speed (4K especially) and the pending HEVC-source conform below.
  Follow-ups in the 10-bit bucket (all post-v1; see ADR 0022): **HEVC
  Main10 source conform** — HW-opaque HEVC frames cannot `copyTo` (P1 probe
  finding), so 10-bit HEVC originals currently proxy to a SW-decodable form;
  `importExternalTexture` or a format-conversion approach is the open P6
  investigation.
  Distinct from the "WebGPU compositor backend" item above (that's real-time
  effects; this is the output pipeline and preview sink).
  (Resolved from this bucket: AV1 10-bit sources are admitted —
  `tenBitExportCapable` covers h264 + av1; dav1d under prefer-software yields
  copyTo-able I420P10 while the hardware path emits opaque frames. The ring
  cap derives from resolution — a per-ring byte target clamped to entry
  floor/ceiling bounds 4K at ~500 MB; a cross-ring global budget remains a
  known limitation if it ever matters.)
- **FFmpeg encoder registry / capability resolver — runtime resolver shipped;
  distribution gate remains.** `export/encoder_registry.rs` now accepts
  library-agnostic intent (`codec`, bit depth, acceleration, rate control,
  speed), owns the known adapters, real one-frame probes, per-encoder argument
  mapping, and process-lifetime selection cache, and returns a complete
  `EncoderPlan` or structured `EncodeUnavailable` attempts. `videosink.rs`
  consumes the plan without naming or remapping an encoder; removal of a
  library skips that adapter and never falls back to an assumed name. What
  remains is the supply-chain half: pin/hash each bundled ffmpeg build and
  check a required encode-capability matrix during packaging.
