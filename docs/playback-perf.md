# Playback Performance Matrix (playback-perf)

playback-perf is a permanent, local-only benchmark that measures the **whole
preview playback loop** under N simultaneous video tracks. Where
[decode-bench](decode-bench.md) profiles one clip at the `DecodeSession` seam,
this profiles everything above it — tick → anchor → composite → present — so it
can name which *stage* is the wall and at what *track count* the wall is hit.

This doc is what it measures and what it found. To operate it, see
[`playback-perf-runbook.md`](playback-perf-runbook.md).

Like decode-bench and the memory ratchet it stays in the repo rather than being
a one-off measurement: a durable bed for the question "how many tracks play
smoothly, and what stops the next one."

## What it measures

One cell is `(codec, resolution, decode route, track count)`. Each cell is its
own app launch over a throwaway `--user-data-dir`, builds a project whose
composition matches the fixture's own resolution, places N clips of one shared
media on N tracks, plays for a measured window, and reports.

### Per-stage cost

`renderer/render/perf/stageTimers.ts` is the accountant. It brackets the two
per-frame costs `compositeMsLast` structurally cannot see — `setAnchorTime`
(ring eviction plus the `requestFrameAt` fan-out) and the Pixi `app.render()`
present, both of which sit *outside* the `compositeFrame` body — plus the
sub-stages inside it:

| stage | what it covers |
|---|---|
| `tickInterval` | wall gap between successive tick starts — the judder signal at the source |
| `tickTotal` | the whole `PlaybackEngine.tick` body |
| `clockTick` | `clock.tick()` |
| `anchor` | `Compositor.setAnchorTime` |
| `composite` | the `compositeFrame` body, early returns included |
| `audio` | the track×layer audio walk plus `mixer.tick` |
| `sceneRebuild` | `stage.removeChildren()` — the per-frame display-list teardown |
| `layerSweep` | the per-layer visual sweep (brackets the five below) |
| `ringLookup` | `FrameRing.selectFrame`, summed over layers |
| `bitmapUpload` | `VideoClipSprite.updateFrame`, summed |
| `blitDrawImage` | the snapshot `drawImage` blit inside it, summed |
| `nv12Ingest` / `tenBitIngest` | the plane uploads plus the YUV→RGB RT pass, summed |
| `effects` | `EffectChain.sync`, summed |
| `transitions` | the composition-sized RT bakes |
| `present` | Pixi's `app.render()` |

Stages that run once per layer accumulate into ONE per-frame total, which is
what a time-share table needs — a per-call percentile would hide that eight
tracks pay the cost eight times. Stages that did not fire in a frame record
nothing rather than a zero, so an inactive stage cannot dilute its own
percentiles.

Profiling is **off by default**: every entry point returns on a monomorphic
boolean and `stageNow()` hands back 0 rather than reading a clock, so a
production session pays a branch. The bench turns it on through
`__weftcutTest.stageProfilingSet`.

**`present` lands one frame late.** It runs at `UPDATE_PRIORITY.LOW`, after
`PlaybackEngine`'s HIGH tick already closed the frame, so its sample accumulates
into the next frame's bucket. Percentiles and totals are valid; only the
"stages sum to *this* frame" reading is off by one for that row.

### Decode and delivery

Per clip, off the product's own `Compositor.getPerfSnapshot()`: `decodedFrameCount`
diffed into a delivery fps, `ringSize`, `lookaheadFull`, `decodeQueueSize`, the
resolved `sourceKind`, and whether the handle `downgraded` at runtime.

### Frame fate

A delivery fps says how many frames arrived. It does **not** say whether any of
them were painted — and the two come apart, hard enough that a cell can report
full-rate delivery with an empty ring. So `FrameRing` also counts where every
frame it was offered actually went (`FrameRingFate`), and the report renders those
counters as a flow:

| in | out unpainted | painted |
|---|---|---|
| `pushed` | `stale` (refused on arrival, already behind `anchor - lookbehind`) | `hit` |
| | `evict✗` (aged out of the window unpainted) | `clamp` (CTS / edit-list offset) |
| | `flush✗` (thrown away by a seek or resync, over `flushes` calls) | `repeat` (same frame again — a HELD frame) |

plus `miss empty` / `miss gap` for selections the ring could not serve at all.
Counters are cumulative on the ring and **diffed across the measured window** by
the harness, so warm-up churn is excluded the same way the stage timers exclude it.
One consequence: `pushed === size + evicted + flushed` holds on the ring's own
absolute counters but *not* on a window delta, because a frame pushed just before
the window can be evicted inside it. A 4K 1-track cell reading 600 pushed and 601
evicted is that, not a leak.

Why this is not redundant with `decode fps/clip`: **both engines increment their
own delivery counter before calling `FrameRing.push`**, and `push` silently
discards a frame that arrives already behind the window. The two engines then
diverge in how that shows up, which is worth knowing before reading a report:

- `FfmpegSource.decodedFrameCount()` is `ring.pushCount` — frames the ring
  *accepted*. A refused frame there presents as a **low** delivery fps.
- The WebCodecs handle's is `outputFrameCount` — frames delivered to the ring's
  *door*. A refused frame there presents as **full-rate delivery into an empty
  ring**.

`stale` is the counter that reads the same on both, and it is the one that
distinguishes "the decoder is slow" from "the decoder is fast and its output is
being thrown away" — a re-seek churn loop on a long-GOP source re-decodes the
whole GOP prefix, and every prefix frame older than the window lands there.

`repeat` deserves separate attention because it is the judder the product's own
dropped-frame indicator is structurally blind to: `judgeFrameSelection` asks only
whether the bound frame is *stale*, so painting the same frame twice reads as two
successful selections and zero drops.

**Calibrate `repeat` before reading it.** It is not an error count. A 60 Hz
display running a 30 fps composition paints every composition frame twice by
design, so the healthy baseline is ~50 %: the measured 1-track cell shows 596
repeats against 1190 hits with 0.00 % drops and a passing verdict. Read it against
`presented fps ÷ comp fps` — that ratio is the expected repeat share, and only the
excess over it is judder.

### Conversion backlog (WebCodecs only)

Outputs waiting on `createImageBitmap`, current and lifetime peak. Each one holds
an **open `VideoFrame`**, so it pins a slot in the ~13-entry hardware decode pool
(ADR 0004) — and overrunning that pool stalls the decoder silently. The pump caps
the decoder's *input* queue via `decodeQueueSize`; nothing caps this output side,
which makes the pair the two halves of "is the decoder starved, or blocked on its
own pool?"

### The hardware lane's read barrier

A pool slot cannot recycle until Chromium's read of it has GPU-completed, or the
lane presents frames `pool_size` out of order. The barrier that guarantees that
is selectable (`--barrier`, `HwBarrierMode`) because the choice is a performance
question with a correctness floor: a synchronous drain in the preload
(`readback`) costs ~20 ms of renderer thread per delivered frame per session,
while the deferred variants pay only a submit and let the ack ride a completion
signal off the critical path. Which context that signal is taken on is what
separates them — the shipped one takes it on the device the compositor presents
from, so it is serviced every frame.

The report carries the barrier's `p50`/`p95`/`max`, its **sample count**, and the
derived **thread-seconds of barrier per wall-second** summed across sessions.
That last figure is the one that decides whether the barrier is on the critical
path: a 20 ms drain at 2 fps is free, the same drain at 30 fps is not. Two
columns exist because of the deferred variants: `fence forced waits` counts
deadline fallbacks, and `spin thread-s/s` prices them — a deferred barrier that
force-waits every frame is the synchronous one wearing a hat, and the p50 alone
cannot see it. Do not difference a `readback` p50 against a deferred one; they
are not the same quantity.

The barrier is stamped **directly** around the drain. It used to be derived as
`residentMs - gvfMs - cibMs`, which also absorbs `vf.close()` and the scheduling
gap around the `createImageBitmap` await — that overstated it and made it invert
with load.

### Resources

Per-process CPU and memory from `app.getAppMetrics()` at 2 Hz. Attribution is
the point: native ffmpeg decode lands in the **main** process (the napi addon),
WebCodecs decode plus all paint work in the **renderer**, and the compositing
GPU work in the **GPU** process.

GPU engine utilization comes from Windows `typeperf` on the `VideoDecode` and
`3D` counters at 1 Hz. Those counters are **machine-wide, not per process** —
run on a quiet machine. Off Windows the sampler is inert and the GPU columns
come back empty.

## Route pinning

All three decode paths run on **one fixture**, so a route comparison is never
codec-confounded:

| route | `decode_engine` | env | resolves to |
|---|---|---|---|
| ffmpeg hardware | `ffmpeg` | `WEFTCUT_FORCE_HW_LANE=d3d11va` | `GpuTransport`, `sourceKind: native-gpu` |
| ffmpeg software | `ffmpeg` | `WEFTCUT_FORCE_HW_LANE=nvdec` | `SwTransport`, `sourceKind: sw` |
| WebCodecs | `webcodecs` | — | `SourceHandle`, `sourceKind: webcodecs` |

The software pin deserves a note: Windows advertises only `software` and
`d3d11va`, so naming `nvdec` empties main's advertised-lane filter and
`resolveHwLane` reports the lane unavailable **before probing and before any
cache write**. That is a clean software resolve which costs no probe and cannot
poison `decode_capability.json` — unlike an off-allow-list codec, it keeps the
fixture identical to the hardware leg's. `forceLane` is not usable here: it is
reachable only from decode-bench's private pool, never from the live
`Compositor.ensureClip` path.

Every cell **verifies** the pin per layer through `activeClipProbe` before and
after the measured window, asserting `sourceKind`, `hwLane`, and that
`builtFromKey` carries `:original:` rather than `:proxy:`. A cell whose lane,
`hwLane`, or resolver key changed mid-window is reported with its drift rather
than published under the label it was asked for. Because a HW or total-ffmpeg
failure marks a source software-only for the rest of the session and never
re-promotes, each cell gets its own launch — one poisoned source cannot leak
into later cells.

**The hardware leg goes impure past three tracks by design.** Concurrent GPU
sessions are capped at `MAX_HW_SESSIONS` (3); clips 4..N take a
`hw-budget-exceeded` and fall to the software transport in place, leaving only a
`decode-lane` LogBus row behind. The sweep records the per-cell lane mix instead
of rejecting those cells — that degradation is production behaviour and is one of
the things the matrix exists to surface.

## Conditions the run enforces

Rather than assume the defaults:

- The composition is created at the fixture's own resolution, so canvas and
  content match.
- `playback_resolution` is pinned `full`. The ½/¼ settings shrink both the
  raster target *and* the NV12 the native lane ships, so a leg measured at ½
  would understate every stage.
- `prefer_proxies` is set false through the test hook, which does the IPC patch
  *and* the renderer-store update — the raw `update_project_settings` command
  alone does not reach the store the decode resolver reads.
- A per-media proxy override forces Original.
- Both are then read back off `project_summary` and recorded in the cell.

**The quiet gate.** Import kicks background work that would otherwise land
inside the measured window: the quick-proxy encode (no fixture here is
`Bypass` — they are long-GOP or above 1080p), the decodability sweep, and the
timeline's filmstrip and waveform tiles. The cell waits for the whole app's CPU
to settle rather than for any one job, so decorations are covered too, and
records how long it waited and whether the gate was actually reached.

Playback starts 2 s into the clip and the window ends well inside the 60 s
fixture, so neither the clip head nor the auto-pause at end-of-material can
enter the measurement. The measured window opens only once `positionUs` is
observed advancing — `playing` is intent and flips before the warm-up gate
releases the clock — and stage counters are reset *after* the warm-up so
decoder init and first-frame texture allocation stay out of the distribution.

## The smooth/stutter verdict

Three independent failure modes, one criterion each:

| mode | criterion |
|---|---|
| decode starvation | the product's own dropped-frame count ≤ 1 % of comp frames |
| paint collapse | presented fps ≥ 90 % of this leg's 1-track baseline |
| judder | `tickInterval` p99 ≤ one comp-frame budget |

The third is the one that matters most, and it is not redundant. The product's
dropped-frame counter judges whether the ring *had* a fresh frame to select, so
a loop stalled by a synchronous GPU drain — presenting late but never selecting
a stale frame — reads as **zero drops while looking visibly jerky**. That is the
documented blind spot of the dropped-frame indicator, and without this criterion
the sweep would over-report the ceiling.

**Max smooth tracks** is the largest monotone smooth prefix: a lone smooth cell
sitting above a stuttering one is noise, not headroom. A leg's sweep stops after
two consecutive non-smooth cells, since a single cell can fail on a transient.

## What this box measured

RTX 3050 + i5-13400 (16 threads), Electron 42.4.1 / Chromium 148, 60 Hz display,
30 fps compositions, git `4a874fa2`. H.264 `yuv420p`, GOP 240, proxies off,
`playback_resolution: full`, one media shared across N tracks. Single run per
cell.

### Max smooth tracks

| leg | max smooth | what stopped the next track |
|---|---|---|
| 1080p ffmpeg-hw | **2** | tick p99 38.8 ms — the read barrier, *not* decode (delivery held 30 fps on all three clips, zero drops) |
| 1080p ffmpeg-sw | **2** | tick p99 119.4 ms at 3 tracks, with all three clips delivering ~29 fps and 5.88 % drops — the lane was 0 until it stopped re-seeking per request |
| 1080p webcodecs | **3** | drops 4.66 % at 4, with `flushes` 0 and every ring healthy — real decode capacity, not the livelock that used to cap this leg at 2 |
| 4K ffmpeg-hw | **0** | drops 26.5 % *and* tick p99 71.3 ms at one track |
| 4K ffmpeg-sw | **0** | drops 94.0 % at one track |
| 4K webcodecs | **0** | tick p99 74.3 ms at one track — with **zero** drops |

### Reproducibility

Cells are run once. Re-running the two marginal 1080p legs separates a stable
verdict from a noisy magnitude:

| leg | run 1 | run 2 |
|---|---|---|
| ffmpeg-hw, 3 tracks | drops 0.00 %, tick p99 **38.8 ms** | drops 0.00 %, tick p99 **38.8 ms** |
| webcodecs, 3 tracks | drops **7.2 %**, presented 59.5 fps | drops **28.5 %**, presented 15.1 fps, one 1436 ms tick |
| webcodecs, 4 tracks | drops **74.0 %** | drops **4.2 %** |

Within a session the hardware lane's judder reproduces closely — same p99 to the
tenth of a millisecond — which is what a fixed per-frame synchronous wait should
look like. The WebCodecs failures are erratic in magnitude while reproducing as
failures, and a 1.4-second stall is not a capacity curve; that scatter is itself
evidence for resource exhaustion and thrash rather than a steady throughput
limit. Treat every WebCodecs multi-track *magnitude* as one sample, and the
ceiling as the reproducible part.

(The repeat swept `1,3,4`, so its own "max smooth" column reads 1 for want of a
2-track cell — an artifact of the explicit track list, not a different ceiling.)

**Absolute numbers drift ACROSS sessions.** After ~2 h of continuous benching the
ffmpeg-hw leg re-measured 15–25 % worse on the same build path — tick p99
38.8 → 46.4 ms at 3 tracks, barrier p50 20.8 → 28.3 ms at 4K — with ring depth
identical, so nothing about the workload had changed. The drift tracks the
barrier, i.e. GPU state, which is also the most sensitive quantity here.

So when judging a change: **measure baseline and candidate in the same session**,
and compare shapes, ceilings, and ratios rather than absolute milliseconds. The
tables here are a reference point, not a control.

### The composite loop is not the bottleneck anywhere

`tickTotal` — the whole `PlaybackEngine.tick`, audio sweep and per-layer visual
sweep included — runs **0.2–0.9 ms** against a 16.7 ms display budget in every
cell measured, and `present` another 0.2–0.4 ms. Together that is **2–6 % of
budget**, while `tickInterval` p99 reaches 38–140 ms. The stall is time in which
the ticker is *not being called*, so it lives outside every stage this harness
can bracket. Per-stage shares of a sub-millisecond tick are therefore a guide to
*within-loop* attribution only — not a route to the wall.

Consistent with that, every candidate inside the loop measured negligible at
1080p: `ringLookup`, `audio`, `sceneRebuild` and `effects` each ≤ 3 % of a
sub-ms tick; `nv12Ingest` p95 1.3 ms. The one in-loop cost that does become real
is `nv12Ingest` at 4K — p95 9.0 ms, p99 12.1 ms — i.e. the YUV→RGB pass matters
only once the frame is 4K.

### The hardware lane's read barrier is a fixed sync wait, not a transfer

| | 1080p, 1 clip | 4K, 1 clip |
|---|---|---|
| barrier p50 | 19.3 ms | 20.8 ms |
| `createImageBitmap` p50 | 0.20 ms | 0.20 ms |

**Four times the pixels costs 8 % more barrier.** So the drain is not moving
frame bytes — it is waiting on a flush boundary, and `createImageBitmap` is
uniformly cheap because it only enqueues. Per-session barrier also *falls* as
sessions are added (1080p: 19.3 ms at one clip, 4.9 at two, 5.1 at three) while
the total per composited frame stays near one display interval — the signature of
a shared wait rather than per-frame work.

Its weight: **0.29–0.71 thread-seconds per wall-second**, against the
0.03 thread-s/s the entire composite plus present consumes. The barrier is
roughly **20×** the loop it is stalling. This supersedes the reading recorded in
the revert of `e8371231`, which attributed the cost to a full-frame
`createImageBitmap` transfer; at equal session count the cost is flat across
resolution.

The WebCodecs leg is the control that isolates it: same fixture, same
compositor, same track counts, no barrier — and tick p95 stays 17.4–17.8 ms from
one track to four.

### `MAX_HW_SESSIONS = 3` overflows silently, and that is now the whole problem

The fourth 1080p clip takes a `hw-budget-exceeded` and opens on the ffmpeg
software transport in place. It used to take the whole session with it; since
that lane stopped re-seeking per request, it does not:

| 4 tracks (3 × `native-gpu` + 1 × `sw`) | before | after |
|---|---|---|
| tick p50 | **82.6 ms** | **16.6 ms** |
| presented | **13.0 fps** | **43.7 fps** |
| main-process CPU | **28.7 %** | **3.6 %** |
| drops | 39.8 % | 3.96 % |
| per-clip delivery | — | 30.2 / 30.2 / 30.2 / 30.0 |

The cell still misses the verdict, but on `tick p99` 103.1 ms with delivery
perfect — which is what the *pure*-hardware 3-track cell does too (p99 40.3 ms,
0.00 % drops, barrier 0.47 thread-s/s). The remaining cost at four tracks is the
read barrier and the tick tail, not the lane the overflow lands on.

**Nothing fired an event or a log when the overflow happened**, and since it no
longer announces itself as a stutter, that silence — not the routing — was the
defect this cell exposed. The bench could see the transition only by diffing
`activeClipProbe().sourceKind` per layer, which is why this matrix has a lane-mix
column at all. It is now also a `decode-lane` LogBus row per transition
([preview.md](preview.md#decode-engine)).

That cell is also the internal check on the software pin: this `sw` clip was
produced *organically* by the session budget, not by the `WEFTCUT_FORCE_HW_LANE`
pin, and shows the same signature (`nv12Ingest` appears, main-process CPU rises).

### The software lane re-seeked on every request

| 1080p ffmpeg-sw | delivery | ring | main CPU |
|---|---|---|---|
| 1 track | 28.0 fps | 11 frames, lookahead never full | 32.8 % |
| 2 tracks | 15.0 + 15.4 fps | 5 + 6 | 51.6 % |

Delivery was pinned near 30 frames of 1080p per second *regardless of clip
count* — two clips each got half rather than each getting their own. That shape
reads like a serialized round-trip, and this doc said so; it was wrong, and the
correction is worth keeping because of how the wrong reading was reachable.
**Every renderer-side counter agrees the lane is healthy.** `stale` 0,
`flushes` 0, ring shallow but non-empty. The waste was spent inside libavcodec
and discarded in Rust *before any frame reached the ring*, so no instrument
above the addon could see it.

`preview_sw`'s `serve_request` seeked on **every** request and then emitted a
fixed 4-frame burst. The renderer issues one request per tick with the target
advanced one frame, so each tick paid `av_seek_frame` plus a decode-forward from
the landing keyframe to the target — and on a long GOP that prefix grows as the
playhead walks through it. Replaying a 30 fps playback cadence against
`SwVideoStream` directly, 150 ticks (5 s of content):

| fixture | seek per request | forward continuation |
|---|---|---|
| prores-1080 (all-intra) | 2.72× realtime · **4.0× duplicate delivery** | 10.05× · 1 seek |
| mpeg2-1080 (GOP 15) | 5.31× realtime · 4.0× | 25.4× · 1 seek |
| h264-1080 (GOP 240) | **0.17× realtime** · 20 629 frames decoded to deliver 150 | 15.4× · 1 seek |
| hi10p-1080 (GOP 240) | **0.09× realtime** · same 137× amplification | 8.76× · 1 seek |

Both of the lane's failures fall out of that one table. An intra source has no
prefix, so the fixed burst is pure duplication — 3 of every 4 frames re-decoded
and re-shipped, which is the 93 fps flood and (since `FrameRing.push` accepts
duplicate PTS) the 66-frame ring that looked like a window overrun. A long-GOP
source pays the prefix instead: ~700 fps of raw H.264 decode ÷ 137 frames per
request ≈ 5 served requests per second × 4 frames = the 28 fps observed, and
~385 fps for 10-bit HEVC gives its 3.3.

**Fixed** in two places:

- The native session carries a cursor across requests (position, the frame it
  stopped on, the decode frontier, an EOF latch). A target at/after the previous
  one and within `FORWARD_CONTINUE_US` (1 s — the twin of the WebCodecs lane's
  `FORWARD_SEEK_RESET_US`) resumes the same decode pass; only a backward scrub or
  a long jump seeks. It decodes until 500 ms past the target and stops, so at
  30 fps exactly one new frame falls inside the horizon per tick and the lane
  self-paces to content rate with no feedback channel.
- `FfmpegSource.requestFrameAt` now honours `isLookaheadFull()`. Until then that
  signal was computed on every ffmpeg source and consulted by nobody, so the byte
  ceiling could bound what the ring *retained* but never what the decoder
  *produced*.

| 1080p ffmpeg-sw, 1 track | before | after |
|---|---|---|
| H.264 — drops · delivery · ring · tick p99 · main CPU | 88.35 % · 27.8 fps · 10 · 30.0 ms · 31.7 % | **0.00 % · 30.0 fps · 31 · 17.8 ms · 2.6 %** |
| ProRes — drops · delivery · ring · tick p50 · presented | 0.50 % · 93.6 fps · 70 · 41.7 ms · 27.1 fps | **0.00 % · 30.0 fps · 31 · 16.7 ms · 60.1 fps** |
| HEVC 10-bit — drops · delivery · ring | 99.50 % · 4.0 fps · 0 | **0.00 % · 30.0 fps · 31** |

Max smooth tracks on this route: **H.264 0 → 2** (two tracks deliver 30.0 fps
*each*, against 13.5 + 14.5, at 5.8 % main CPU against 51.4 %), **ProRes 0 → 1**,
**10-bit HEVC 0 → 1**. Wasted frames are **0** in every smooth cell; ProRes alone
had been binning 1302 of 1884.

What remains is a different wall with a different shape: at 3 tracks (H.264) and
2 (ProRes / 10-bit) every clip still decodes at ~30 fps with 0.00 % drops while
`tickInterval` p99 reaches 67–119 ms against a `tickTotal` p50 of 3.6 ms. The
loop is not overrunning its budget, it is not being called — the same signature
as the 4K single-track stall, now reproducible at 1080p on a route where nothing
is 4K, and pointing at the NV12 IPC receive path (~190 MB/s of frame bytes at two
1080p tracks) that no stage timer brackets.

### The FrameRing's lookahead is resolution-blind, and that is the 4K wall

`DEFAULT_LOOKAHEAD_US` 1 s + `DEFAULT_LOOKBEHIND_US` 0.5 s is a **time** window,
identical for both engines and indifferent to frame size. The bitmaps it retains
are GPU-backed, so the bill lands in GPU memory:

| leg | ring depth | ImageBitmap bytes retained | GPU-process memory | drops |
|---|---|---|---|---|
| 1080p webcodecs, 1 track | 47 | ~0.37 GB | 1.16 GB | 0.0 % |
| 1080p webcodecs, 3 tracks | 50 / 59 / 49 | ~1.25 GB | 2.11 GB | 7.2 % |
| 1080p webcodecs, 4 tracks | 40 / **0 / 0 / 0** | ~0.32 GB | 1.32 GB | 74.0 % |
| 4K webcodecs, 1 track | 58 | **~1.9 GB** | **2.91 GB** | 0.0 % |
| 4K webcodecs, 2 tracks | 64 / 61 | **~4.0 GB** asked for | 1.63 GB delivered | 83.5 % |

At four 1080p tracks three of the four rings are **empty**, and at 4K two tracks
ask for ~4 GB and get 1.6 GB. Both fail with clean ticks and zero paint cost, so
neither is decode throughput or compositing.

The empty rings are **not** dead decoders, which is what this table looked like
before frame-fate counters existed. The frame-fate instrument shows those clips
decoding at 40 fps — faster than the healthy 1-track cell — with every frame
refused at `push` as already behind the window, and their rings flushed ~6 times
a second. That is a re-seek livelock in `PacketPump`'s reset policy, described
under [Multi-track collapse](#multi-track-collapse-is-a-re-seek-livelock-not-a-buffer-size).
Bounding retained bytes (`frameRingBudget.ts`) was the first attempt at this cell
and did not fix it; a *tighter* bound made it much worse, because starving the
forward fill is one of the ways to trigger the same livelock.

### What the ¼-resolution control ruled out

Re-running one track of every leg at `playback_resolution: quarter` shrinks the
raster target 16× — and on the ffmpeg lanes it also shrinks the decoded frame
before it is shipped (`setPlaybackScaleDiv` reaches ffmpeg handles only;
WebCodecs always decodes full size). What it changed:

| leg | tick p99 full → ¼ | barrier p50 full → ¼ | delivery full → ¼ |
|---|---|---|---|
| 1080p ffmpeg-hw | 22.9 → 22.4 ms | 19.3 → 15.3 ms | 30.0 → 30.0 fps |
| 4K ffmpeg-hw | 71.3 → **71.7** ms | 20.8 → **20.8** ms | 31.0 → 31.0 fps |
| 4K webcodecs | 74.3 → **76.3** ms | — | 30.0 → 29.7 fps |
| 1080p ffmpeg-sw | 30.1 → 18.7 ms | — | 28.0 → 44.6 fps |
| 4K ffmpeg-sw | 76.6 → 19.2 ms | — | 2.2 → 5.6 fps |

Two conclusions, both negative and both load-bearing:

**Raster size is not the 4K wall.** Sixteen times fewer pixels to draw left the
4K tail *unchanged* on both the hardware lane (71.3 → 71.7 ms) and WebCodecs
(74.3 → 76.3 ms). Whatever stalls the loop at 4K is not the amount of
compositing being done.

**The barrier is size-independent — third confirmation.** On the 4K hardware leg
¼ shrinks the decoded frame itself, and the barrier still measured 20.8 ms,
identical to full. Together with 1080p ≈ 4K at full, this closes the question:
the drain is a fixed wait, and no amount of shrinking the frame will pay it down.

The software lane is the one thing ¼ helps, and only partly: 1080p delivery rose
1.6× for 16× fewer shipped pixels. Read against the re-seek finding above, that
ratio makes sense — the divisor shrinks the swscale output and the IPC payload,
but not the decode of the GOP prefix, which is where the work was going. It is
why ¼ rescued the lane's *tick* (18.7 ms, clean) while leaving it decode-starved
(62.6 % drops). These numbers predate the cursor fix; the control is kept because
it is still the decisive test for whether a lane's wall is size-bound.

### Multi-track collapse is a re-seek livelock, not a buffer size

At 3–4 concurrent 1080p H.264 WebCodecs clips, playback does not degrade — it
falls off a cliff and never recovers. Frame-fate counters name the mechanism:

| tracks | pushed | stale on arrival | ring flushes | wasted | conversion peak | drops |
|---|---|---|---|---|---|---|
| 1 | 616 | **0** | **0** | 1.1 % | 1 | 0.00 % |
| 2 | 1236 | **0** | **0** | 1.5 % | 1 | 0.00 % |
| 3 | 158 | **1722** | **254** | **94.9 %** | 1 | 73.50 % |
| 4 | 1549 | **2137** | **231** | 62.3 % | 1 | 58.07 % |

At three tracks two of the clips push **zero** frames into their rings across a
20 s window while decoding at **40 fps** — faster than the healthy single-track
cell's 30.8. Every frame they produce is refused as already behind the window, and
their rings are flushed ~6 times a second.

The loop, between two policies each defensible alone:

1. A clip falls more than `FORWARD_SEEK_RESET_US` (1 s) behind. `decideReset`'s
   far-forward arm fires.
2. The reset flushes the ring and seeks to the nearest key packet — up to 8 s
   earlier on a 240-frame GOP.
3. The frontier is now ~8 s behind the target, so the far-forward arm is *still*
   true. `PacketPump` knows this; the `seekResolvedForTargetUs` latch exists for
   it.
4. That latch is scoped to *"have I already seeked for this exact target"*, and
   **under playback the target changes every frame** — so it never holds. Every
   pump pass re-seeks and re-flushes, discarding the prefix it just decoded.

One transient lag latched it and nothing unlatched it, which is why the ceiling
was hard (always 2 tracks) while the magnitude was erratic (3 tracks measured
7.2 %, 28.5 %, 50.5 %, 73.5 % across runs) and why **4 tracks measured better than
3**. At 1–2 tracks no clip ever falls a full second behind, and `flushes` is
exactly 0.

**Fixed** in two parts, both in `PacketPump`:

- The latch is keyed on the **key packet** (`seekedKeyTimestamp`) instead of the
  target, so it holds under a moving playhead. A seek that would land on the key
  the pump is already decoding forward from is a no-op and is skipped. Scoped to
  `far-forward`: a *backward* target inside the same GOP genuinely needs the
  re-seek, since the pump only moves forward.
- `resetReason()` replaces the boolean reset decision, so the flush can depend on
  which condition fired. `ring.flush()` now happens only on
  `backward-beyond-ring`, where the cached frames really are the wrong region. On
  a far-forward reset they are not — `requestFrameAt`'s `setAnchor` has already
  evicted whatever fell outside the new window.

| tracks | flushes | stale | drops | tick p99 | verdict |
|---|---|---|---|---|---|
| 1 | 0 → 0 | 0 → 0 | 0.00 → 0.00 % | 18.6 → 18.3 ms | smooth → smooth |
| 2 | 0 → 0 | 0 → 0 | 0.00 → 0.00 % | 20.0 → 18.0 ms | smooth → smooth |
| 3 | **254 → 0** | **1722 → 0** | **73.50 → 0.00 %** | **96.4 → 18.3 ms** | STUTTER → **smooth** |
| 4 | **231 → 0** | **2137 → 38** | **58.07 → 4.66 %** | **52.5 → 17.9 ms** | STUTTER → STUTTER |

Max smooth tracks **2 → 3**. Three corroborating details: per-clip delivery
normalised from 39.4 fps back to 29.5 (the excess *was* the churn); tick p99 came
down to 17.9–18.3 ms in **all four** cells, which is why this is a fix and not
session drift; and the `decoder … error: Decoding error.` lines that appeared only
in the collapsing cell went to zero, so those errors were an **effect** of
hammering `reset()` + `configure()` every pass, not a cause of the lag.

Four tracks still misses the 1 % drop budget at 4.66 %, but it now fails on that
criterion alone with `flushes` 0 and every ring holding frames — genuine decode
capacity, which is flow control's problem (`04-sw-lane-flow-control`), not a
livelock.

Two things this rules out. **The ADR-0004 hardware pool is not involved**:
`conversionBacklog.peak` is 1 in every cell, so at most one `VideoFrame` is ever
pinned awaiting `createImageBitmap` — the preview path's snapshot-and-close really
does exempt it, concurrency included. **GOP length is not what separates H.264
from HEVC**: both fixtures are `keyint=240 min-keyint=240 scenecut=0`, so the
remaining question is the narrower "what makes a clip fall a full second behind
even once".

### Preview rasterizes at composition resolution, not panel resolution

`<PixiApplication width={composition.width} height={composition.height}>` and
`renderer.resize(app.screen…)` size the drawing buffer from the **composition**;
`playback_resolution` only multiplies it by 1 / 0.5 / 0.25, and the canvas is
scaled to the panel purely in CSS (`objectFit: contain`). A 4K composition in a
960×540 panel therefore rasterizes ~16× the pixels the panel can show, at Full.

Recorded as a latent inefficiency, **not** as the current bottleneck: the ¼
control above shows reclaiming those pixels does not move the 4K tail on this
box. It would matter on a GPU where fill rate, rather than this one, is the
constraint.

### Material types beyond H.264

| material | route | max smooth | character |
|---|---|---|---|
| HEVC 8-bit 1080p | webcodecs | **≥4** (never reached) | drops 0.0 % and tick p95 17.2 ms at four tracks — the best result in the matrix |
| HEVC 8-bit 1080p | ffmpeg-hw | 1 | tick p99 84.8 ms at two tracks |
| HEVC 8-bit 4K | ffmpeg-hw | 0 | barrier reaches **1.01 thread-s/s**; tick p50 95.8 ms, presented 11.2 fps |
| HEVC 8-bit 4K | webcodecs | 0 | drops 0.0 %, tick p50/p95 16.6/17.4 ms, p99 106.2 ms — the same 1 %-tail shape as 4K H.264 |
| ProRes 422 1080p | ffmpeg-sw (only route) | **1** | 30.0 fps, 0.00 % drops, tick p50 16.7 ms at one track; 2 tracks keep 30.0 fps each and fail on the tick tail alone |
| HEVC 10-bit 1080p | ffmpeg-sw (only route) | **1** | 30.0 fps, 0.00 % drops — was the matrix's worst cell at 3.3 fps and 100 % drops |

One of these was shape-changing rather than just slower:

**ProRes inverted the software lane's failure**, and that is how the lane's real
bug was found. H.264 on that route was starved (28 fps for 30 fps content) while
ProRes was the opposite — an all-intra codec delivering at 3.1× realtime and
flooding the renderer's main thread with NV12 over IPC, its ring at 66 frames
past the 45 the 1.5 s window should hold. One mechanism produced both: a seek and
a fixed 4-frame burst per request, which is duplication with no prefix to walk
and prefix-thrash with one. See
[the software lane](#the-software-lane-re-seeked-on-every-request).
`nv12Ingest` is the largest in-loop stage cost measured anywhere at 1080p
(p50 1.4 ms, 36 ms per wall-second) — it was a distant second to the delivery
problem, and is now the lane's largest *in-loop* cost outright.

**10-bit sources reach the compositor as 8-bit NV12.** `tenBitIngest` never
fired on the `hi10p-1080` leg; `nv12Ingest` did. That follows from
[ADR 0029](adr/0029-native-sw-decode-ships-bytes-not-shared-texture.md) — the
software transport ships NV12 — and it means the 10-bit preview path is
bit-depth-lossy, and that `TenBitIngest` is unreachable from this route. It was
also the slowest cell in the whole matrix (3.3 fps) until the lane stopped
re-seeking per request; it now plays one track at content rate, so what is left
here is a fidelity gap, not a speed one.

## What it deliberately is not

- **Not a CI gate.** GPU numbers off a headless runner are meaningless, so the
  harness is local-only by construction, and the exit code is non-zero only when
  the run could not be *measured* (no build, no hook, no fixture) — never
  because playback was slow.
- **Not a proxy-vs-original comparison.** Every leg decodes the original with
  proxies explicitly off.
- **Not a GPU-time measurement.** Every stage number is CPU wall time on the
  thread that submits the work. `renderer.render()` submits; it does not wait for
  the GPU. The machine-wide `typeperf` engine counters are the only GPU-side
  signal here, and they cannot be attributed to a process.
- **Not multi-source.** All N clips share one media, so they share one open and
  parse and differ only in their decode pipeline — the same
  same-source pairing decode-bench uses.

## Running it

Prerequisites, flags, the validity checklist, the same-session A/B rule, and how
to read each column live in [`playback-perf-runbook.md`](playback-perf-runbook.md).
The short version:

```bash
npm run build:e2e                       # from apps/desktop — the harness drives out/, not the dev server
npm run bench:decode:fixtures           # from apps/desktop/e2e
npm run bench:playback                  # from apps/desktop/e2e
```

Two things that invalidate a run rather than slow it down: a machine that is not
quiet (the GPU counters are machine-wide) and comparing absolute milliseconds
across sessions (this box drifts 15–25 % over hours). Both are covered in the
runbook.
