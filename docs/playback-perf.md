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
| `rafInterval` | gap between the rAF frame timestamps the browser handed Pixi — the cadence it *delivered* |
| `rafLag` | from this frame's rAF timestamp to the tick body starting — the lateness this thread added |
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

`rafInterval` and `rafLag` decompose `tickInterval` rather than adding to it:
`tickInterval ≈ rafInterval + Δ rafLag`, so a gap sits in exactly one of them and
each names a different subsystem. The rAF timestamp comes from
`ticker.lastTime + ticker.elapsedMS` — `Ticker.update` assigns `lastTime` only
after its listeners run, so during the tick those two sum to the stamp the browser
handed this frame, and that value is equal to `document.timeline.currentTime`
inside the callback.

Profiling is **off by default**: every entry point returns on a monomorphic
boolean and `stageNow()` hands back 0 rather than reading a clock, so a
production session pays a branch. The bench turns it on through
`__weftcutTest.stageProfilingSet`.

**`present` lands one frame late.** It runs at `UPDATE_PRIORITY.LOW`, after
`PlaybackEngine`'s HIGH tick already closed the frame, so its sample accumulates
into the next frame's bucket. Percentiles and totals are valid; only the
"stages sum to *this* frame" reading is off by one for that row.

### Where a tick gap went

The stage timers can prove the loop was not slow. They cannot say what the thread
was doing instead, because a gap between two ticks is by definition outside every
bracket. Two harness-side probes cover that, installed over the measured window
from `playback-perf.mjs` rather than from `stageTimers.ts` — a
`PerformanceObserver` allocates per entry and a timer is a task, and that module
is allocation-free while recording.

- **`long-animation-frame` + `longtask`.** Both fire only above 50 ms, which is
  below every gap worth chasing. A long *frame* carries the internal split —
  `startTime` → `renderStart` (everything before the rendering steps, where every
  rAF callback including `PlaybackEngine.tick` lives) → `styleAndLayoutStart` →
  end — plus per-script attribution for any script over the API's own 5 ms floor.
  A stall inside our JS therefore names itself; a long frame with no scripts and
  no long task says the time was not spent in script or in any Blink task at all.
- **A plain `setInterval` on the same main thread.** This is the one that
  separates a *blocked* thread from one Chromium simply did not give a rendering
  opportunity to: a timer cannot fire while the thread is blocked, and fires right
  through a withheld `BeginMainFrame`. Its baseline is exact — a passing cell
  measures p50 8.0 ms with zero gaps over 50 ms — so a lost fire is a signal, not
  noise.

The report prints them as one table, written to be read as a decision tree: no
long frames under a large tick p99 means the gap never reached this thread; a
script attribution means it is our JS outside the tick bracket; long frames with
no script and a stalled timer mean the thread was blocked in something that is
not script; long frames with no script and a healthy timer mean the thread was
alive and what it lost was a rendering opportunity.

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

A deferred barrier's deadline (`FENCE_DEADLINE_MS`) is arbitrating the idle case
only — 2–4 tracks force nothing at either bound — and for it, tighter is
strictly better. On an idle GPU the fence never signals on its own, so widening
converts no timeouts into natural signals; it only parks a pool slot longer and
pays more per timeout:

| 1080p, 1 track | deadline 33.3 ms | deadline 66.7 ms |
|---|---|---|
| `fenceWaitP50` | 34.9 ms | 88.5 ms |
| `fenceForcedWaits` | 98 | 206 |
| spin per 20 s window | 1.96 s | 4.12 s |
| `tick p99` | 23.7 ms (smooth) | 34.1 ms (STUTTER) |

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

**The hardware leg goes impure past the admission budget by design.** Main
reserves both a hard session slot and the source's coded `width × height` before
native allocation. Exhausting either currency returns `hw-budget-exceeded`; that
clip falls to the software transport in place and leaves a `decode-lane` LogBus
row. The sweep records the per-cell lane mix instead of rejecting it. In
particular, a four- or five-track 4K cell is expected to report
`routePure: false`: three clips are admitted to GPU and the remainder are formal
software spills. Calling that cell route-pure would hide the production behaviour
the matrix exists to measure.

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
to stay below 20 % while the derivative-job pill stays absent for four
consecutive polls. If that state is not reached within 300 s the cell is
`InvalidRun`; it never opens a measurement window with `quietReached: false`.
`quietGate` records which signal kept it waiting.

Playback starts 2 s into the clip and the window ends well inside the 60 s
fixture, so neither the clip head nor the auto-pause at end-of-material can
enter the measurement. The measured window opens only once `positionUs` is
observed advancing — `playing` is intent and flips before the warm-up gate
releases the clock — and stage counters are reset *after* the warm-up so
decoder init and first-frame texture allocation stay out of the distribution.
For heavy spill cells, `--replay-after-warmup` then pauses, seeks back to 2 s and
plays again. It does not reset on the first clock tick: every ring must be
non-empty and bracket the live playhead for four consecutive 250 ms polls. The
state-based wait is stored as `replayGate`, and a 30 s miss invalidates the cell.

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
30 fps compositions. H.264 `yuv420p`, GOP 240, proxies off,
`playback_resolution: full`, one media shared across N tracks. Most rows are a
single run per cell; the 4K hardware row has the repeated distribution called
out below. Rows measured in different sittings are not comparable in absolute
milliseconds (see Reproducibility below).

### Max smooth tracks

| leg | max smooth | what stopped the next track |
|---|---|---|
| 1080p ffmpeg-hw | **5** | not reached. Every cell from 1 to 5 tracks holds 0.00 % drops and 30.0 fps per clip with every clip on hardware — the 4- and 5-track cells at tick p99 17.2 and 17.1 ms, the flat figure the pure lane holds everywhere. Was 2, capped by the read barrier's synchronous drain and then by its deadline spin |
| 1080p ffmpeg-sw | **2** | tick p99 119.4 ms at 3 tracks, with all three clips delivering ~29 fps and 5.88 % drops — the lane was 0 until it stopped re-seeking per request |
| 1080p webcodecs | **2** | drops 28.33 % at 3, with `flushes` 0, `stale` 318 and decode running 31.6–32.5 fps — real decode capacity, not the livelock that used to cap this leg at 2. Recorded as **3** before, on a 3-track cell that measured 0.00 %; see Reproducibility |
| 1080p HEVC ffmpeg-hw | **5** | not reached. All five clips take hardware: 0.00 % drops, 60.1 fps presented, tick p99 **18.10 ms** against a 33.3 ms budget, main-process CPU 0.909 %, zero wasted frames of 3000, and `nv12Ingest` never fires. Was 1, capped by the barrier |
| 1080p HEVC webcodecs | **≥5** | not reached — 0.00 % drops and tick p99 ≤ 25.2 ms from one track to five. The best result in the matrix |
| 4K ffmpeg-hw | **1 reliable; 2 intermittent** | With the derivative-aware quiet gate, five paired 2-track cells measured tick p99 **17.5, 17.6, 40.5, 27.9, 38.9 ms**: 3 smooth, 2 STUTTER. Every paired 1-track baseline was smooth at 16.9–17.2 ms. The red cells fail on tick alone with 0.00 % drops, `rafInterval` p99 33.3–33.4 ms, a healthy 8 ms timer, and no attributed script: the thread is alive but intermittently loses a rendering opportunity. Was 0: that whole cliff was the read barrier, first its synchronous drain and then its deadline spin. The former 67/68 ms evidence is invalid because derivative jobs ran inside those windows; see Reproducibility |
| 4K ffmpeg-sw | **0** | drops 94.0 % at one track |
| 4K webcodecs | **0** | tick p99 75–82 ms at one track — with **zero** drops |

The two 1080p H.264 legs are what decided the decode-engine default: with the
barrier gone the hardware lane wins the sustained axis 5 tracks to 2, and it
already held the seek axis ([decode-bench](decode-bench.md)), so `auto`
preferring the Standard engine is correct on both. The decision and the exact
condition that would reopen it are recorded in
[preview](preview.md#decode-engine).

**The hardware route is also the quieter one where the two score the same.** It
records zero long animation frames and zero 8 ms-timer gaps over 50 ms in every
1080p cell of both codecs. WebCodecs records 2–5 of each in **every** cell, the
smooth ones included, with no script over the reporting floor and tick maxima of
83–109 ms — [the per-`ImageBitmap` allocation stall](#a-tick-gap-is-the-main-thread-stopping-not-the-loop-being-starved)
at 1080p intensity. Too few events to move a p99, so it costs no verdict here.

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

**One WebCodecs *ceiling* has moved, which that rule does not cover.** The 1080p
H.264 3-track cell measured 0.00 % drops when the re-seek livelock was fixed, and
28.33 % on a later sitting — so this leg's ceiling reads 3 in one sitting and 2 in
another. `flushes` is **0** in the failing run, so the livelock has not returned;
the shortfall is `stale` 318 and `missEmpty` 772 against decode running
31.6–32.5 fps, i.e. capacity. Read this leg as "2, marginally 3" rather than
either number: it is the one leg whose ceiling is not reproducible, and the
HEVC WebCodecs leg beside it — five tracks at 0.00 % — shows the instability is
about this codec on this route, not about the route.

**And 28.33 % is not a new number.** The same cell is recorded below at 7.2 %,
28.5 %, 50.5 % and 73.5 % across four runs, from before the livelock fix — where
the note is that the *ceiling* was the hard part (always 2) and only the magnitude
moved. A later sitting landing mid-spread is that same behaviour, not a
regression; what it does say is that the 3 this leg was credited with rested on
one favourable sitting, and a ceiling change on this one leg needs repeats before
it is worth writing down.

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

**The 4K hardware second track is intermittent, and the old 67/68 ms comparison
was not valid.** The old quiet gate looked only for four consecutive sub-20% CPU
polls. A fresh import's derivative queue dips below that threshold between ffmpeg
jobs: a targeted probe saw the `Generating derivatives` pill still present when
the gate returned after ~1.55 s, still present after the 5 s warm-up, and disappear
only inside the measured window. The two 67.0/68.9 ms reports waited 1.549/1.555 s
and are invalidated. The gate now also requires the derivative pill to stay absent;
the same fixture then waits 15–16 s and records why it waited in `quietGate`.

Five valid same-sitting pairs on `35cf93d3` put every 1-track baseline at
16.9–17.2 ms and the 2-track tick p99 at **17.5, 17.6, 40.5, 27.9, 38.9 ms**:
3/5 smooth, 2/5 STUTTER. Drops stayed 0.00 % and presented fps stayed
58.6–60.0. This is not admission: two 4K sessions consume 2/5 session slots and
two thirds of the coded-area budget, so both execute the same admitted path.

It is not a branch regression at `45a98405` either. Corrected-gate isolated runs
gave `3e5adabf` 43.5/40.6/42.1 ms and `45a98405` 17.3/36.3/33.9 ms. The
documented 17.4 ms source,
`playback-perf-2026-07-26-5a1c7357-t11-2160.json`, labels a
`rendererFence` cell even though a clean `5a1c7357` checkout does not recognise
that barrier; it was a dirty worktree containing the implementation later
committed as `3e5adabf`. The same implementation has therefore measured both
green and red.

The clean red shape is the live-thread branch of
[the tick-gap decision tree](#a-tick-gap-is-the-main-thread-stopping-not-the-loop-being-starved):
`rafInterval` p99 is 33.3–33.4 ms, the timer remains at 8.0 ms with nothing over
50 ms, no script is attributed, and drops are 0.00 %. It is not the
blocked-thread mechanism whose timer stalls. Credit this leg with **1 reliable
track, with a second track that is intermittent**, rather than presenting either
one favourable invocation or one red invocation as a deterministic ceiling.

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
only once the frame is 4K. What the thread is doing during the gap instead is the
next section.

### A tick gap is the main thread STOPPING, not the loop being starved

"The loop is not being called" was the right reading of the stage timers and the
wrong conclusion. **The whole main thread stops.** An independent 8 ms
`setInterval` — nothing to do with rAF, Pixi, or the ticker — loses its cadence in
exactly the cells whose tick tail blows out, and holds it exactly in the cells
that pass:

| cell | verdict | tick p99 | 8 ms timer: fires / p50 / max / gaps >50 ms | long frames | long **tasks** |
|---|---|---|---|---|---|
| 1080p sw, 3 tracks | STUTTER | 67.30 ms | **903** / **23.6** / **107.3** / **40** | 27 | 0 |
| 1080p hw, 3 tracks | smooth | 17.40 ms | 2501 / 8.0 / 18.0 / 0 | 0 | 0 |
| 1080p webcodecs, 3 tracks | smooth | 17.50 ms | 2469 / 8.0 / 77.7 / 4 | 4 | 0 |
| 4K webcodecs, 1 track | STUTTER | 75.00 ms | 2402 / 8.0 / **85.4** / **12** | 17 | 0 |
| 4K hw, 1 track | smooth | 17.60 ms | 2502 / 8.0 / 14.5 / 0 | 0 | 0 |

A withheld `BeginMainFrame` cannot stop a timer, so nothing about rAF delivery or
ticker scheduling explains this. For 85–107 ms at a time the thread runs **no task
at all** — while drawing 1.5–8.1 % of one core, so it is waiting, not computing.

`rafInterval` and `rafLag` locate the gap inside the frame, and the *2*-track
software cell — one below the failure — is the cleanest read of them: its
`rafInterval` max is **16.90 ms**, a perfect 60 Hz delivery with no gap anywhere,
while `tickInterval` reaches 26.80 ms and every millisecond of the excess is
`rafLag`. The stall starts as pure lateness before a single vsync is lost. In the
cells that fail, both blow out
together, and every large `rafInterval` is an **integer multiple of the 16.67 ms
vsync** (50.1 = 3×, 66.7 = 4×, 116.9 = 7×, 166.7 = 10×): the compositor keeps
time, and k−1 vsyncs go unserved because the thread is not there to serve them.

It is not our JS. Across 96 long animation frames in the failing cells there is
**not one script** over the API's 5 ms reporting floor, `longtask` never fires at
all, and **89–99 % of each long frame is spent before `renderStart`** — before the
frame reaches its rendering steps, which is where every rAF callback lives. The
rendering steps themselves cost 0.4–1.3 ms (4K webcodecs) and 5–14 ms (1080p sw
×3), matching `tickTotal`. So the time is neither in one long JS task nor in one
long Blink task: it is outside Chromium's task accounting.

What the two failing cells do *not* share is a cause. They fail on different axes
and with different shapes — the software cell in bursts (30+ consecutive long
frames 0.11 s apart, then quiet for seconds), the WebCodecs cell periodically
(modal gap 0.88 s with clean 2× harmonics):

- **1080p ffmpeg-sw follows the per-frame bytes.** The route differential above is
  the control: the same three-layer 1920×1080 composition is smooth on hardware
  (p99 17.40) and on WebCodecs (p99 17.50) and stutters on software (p99 67.30),
  which excludes the raster, the canvas, the track count and the composite, and
  leaves the one thing only this route does — ship decoded NV12 across the process
  boundary (3 × 9.33 MB per composition frame ≈ 280 MB/s) and upload it from CPU
  memory. Shrinking those bytes 16× makes the cell perfect — see the
  ¼-resolution control below.
- **4K WebCodecs follows the size of each `ImageBitmap`.** 4K hardware is smooth on
  the same canvas with the same decoder load, so what differs is what the frame
  *is*: an imported shared texture versus a 33.2 MB GPU-backed bitmap created and
  closed 30×/s. The long-frame count on that route scales with the allocation
  rather than the throughput — 4 events at 8.29 MB/frame (~746 MB/s) against 17–25
  at 33.2 MB/frame (~1000 MB/s), so 4.0× the allocation for 1.34× the bandwidth
  gives 4–6× the stalls. The 1080p cell shows the same signature four times in
  20 s and still passes, so this is one phenomenon at two intensities, not a
  4K-only cliff.

Excluded by matched pairs rather than by argument: **the GPU is not saturated in
these cells** — 4K hardware and 4K WebCodecs at one track put the VideoDecode
engine at 49.1 % vs 48.9–53.6 % and 3D at 15.0 % vs 14.6–15.7 %, identical, and
one of them is smooth. (Saturation is real at 4K, but it takes several concurrent
hardware sessions to reach; that is a different cell and a different section.) **GPU-process
memory does not order the cells** either: the software cell stalls holding 0.36 GB
while the smooth 1080p WebCodecs cell holds 2.14 GB. And **Pixi's GC is not
involved**: `GCSystem`/`RenderableGCSystem` run at `gcFrequency` 30 s with
`gcMaxUnusedTime` 60 s (and `TextureGCSystem` is deprecated into them), which is
30–250× slower than the observed stall rate.

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

### Hardware admission is now a two-currency budget

Main admits a GPU preview only when **both** of these reservations fit:

| currency | maximum | what binds |
|---|---:|---|
| concurrent sessions | 5 | protects against unbounded tiny-session fan-out |
| coded pixel area | 24,883,200 = `3 × 3840 × 2160` | a monotone proxy for the measured decode-load cliff |

The public snapshot calls the second currency `coded-pixel-area` and reports
`calibratedFps: 30`. It is deliberately **not** called pixel-rate: admission does
not yet carry source fps, so the data only calibrates this area at the 30 fps
fixtures measured here. At 1080p the hard five-session limit binds; at 4K the
area limit binds after three sessions. Mixed resolutions add their coded areas
and still share the five-session ceiling.

The renderer-probed coded dimensions travel in `previewGpu:open`. Main reserves
before the native session or shared textures exist, then compares native's
actual dimensions with the reservation. Invalid dimensions, duplicate ids,
area overflow and session overflow all fail closed. A native-size mismatch is a
separate transient fallback: main closes the just-opened native session and
releases the lease, and the renderer does not poison that media's hardware
capability verdict. Rollback and normal close attempt every imported-frame
release before releasing the lease.

`hw-budget-exceeded` is also a capacity result, not a capability verdict. A
refused clip stays software for that source lifetime, but a later independent
open can use a released reservation. Both live currencies are visible in
`previewGpu:budget` and the PerfHUD.

**A formal spill makes the 4K refusal survivable.** Only a genuine budget
refusal above 1080p gets this profile. For a 4K source the software transport
ships 960×540 frames at half cadence (approximately 15 fps for these 30 fps
fixtures): native still decodes reference frames in order, but skips the
unselected frames before copy-back, scale, packing and IPC. Budget spills at or
below 1080p keep the user's requested scale and full cadence. Device failures,
dimension mismatches and other fallbacks also keep the ordinary profile; they
must not masquerade as capacity spills.

### Why the fixed count was replaced

The two tables below are **historical before data from fixed-cap prototypes**,
not descriptions of the current budget. They explain the policy.

At 1080p, raising the old fixed count from three to five helped and cost nothing
measurable:

| historical 1080p hw route | fixed cap 3 | fixed cap 5 |
|---|---|---|
| HEVC 4 tracks | smooth · 3 gpu + 1 sw · p99 23.5 ms · main 4.7 % | smooth · 4 gpu · p99 24.7 ms · main **1.0 %** |
| HEVC 5 tracks | **STUTTER** · 43.69 % drops · 48.6 fps · p99 45.1 ms · main 8.7 % | **SMOOTH** · 0.00 % · 60.1 fps · p99 **18.2 ms** · main **1.0 %** |
| H.264 4 tracks | smooth · 3 gpu + 1 sw · p99 19.2 ms · main 3.6 % | smooth · 4 gpu · p99 **17.2 ms** · main **0.9 %** |
| H.264 5 tracks | smooth · 3 gpu + 2 sw · p99 23.7 ms · main 6.8 % | smooth · 5 gpu · p99 **17.1 ms** · main **0.8 %** |

Five pure hardware tracks left VideoDecode at 24.2 % for H.264 and
11.5–18.7 % for HEVC. That is why the hard session ceiling remains five rather
than becoming a blanket three.

At 4K, the old five-session policy walked off an engine cliff:

| historical 4K H.264 / 4 tracks | fixed cap 3: 3 gpu + 1 sw | fixed cap 5: 4 gpu |
|---|---|---|
| drops | **39.18 %** | **89.35 %** |
| decode fps per clip | 9.08 / 9.32 / 9.17 / 29.46 | **0.00 × 4** |
| GPU VideoDecode | 94.4 % | **99.9 %** |
| ring at close | 12 / 12 / 11 / 26, tracking | all **0**, bound to the 0.5 s poster |
| ring fate | pushed 1175, serveHit 562 | pushed **0**, serveHit **0** |

Three concurrent 4K sessions were nearly clean at 91.9 % VideoDecode; the
fourth starved all four. A simple fixed cap of three was still not sufficient:
at five tracks its two full-size/full-cadence software spills froze the renderer
for 17–36 s. The area reservation prevents the fourth hardware open, while the
formal 540p/half-cadence spill removes the byte flood that made the lower fixed
cap unsafe.

The slot pool did not size this budget. A bare three-slot NV12 pool is nominally
9.3 MB per 1080p session and 37.3 MB per 4K session; the historical five-session
4K pool was only 186.6 MB against roughly 4.5 GB process-wide dedicated memory.
The measured cliff was VideoDecode load, while most retained memory belonged to
the resolution-blind FrameRing.

### Current policy verification — HEVC and H.264 both accepted

The production-shaped candidate later checkpointed as `adfbd7f5` has three
current-build HEVC repeats per heavy cell. The JSON names retain base SHA
`35cf93d3` because measurement preceded the checkpoint:

| current 4K HEVC | runs | lane mix | drops | tick p99 | timer gaps >50 ms | ring result |
|---|---:|---|---:|---:|---:|---|
| 4 tracks | 3 | 3 gpu + 1 sw | 0.00 % in all | 17.1 / 17.2 / 17.1 ms | 0 / 0 / 0 | 28–29 / 28 / 28 / 15, every ring tracking |
| 5 tracks, replay state gate | 3 | 3 gpu + 2 sw | 0.00 % in all | 17.0 / 18.3 / 17.6 ms | 0 / 0 / 0 | 27–29 on GPU, 15–16 on spill, every ring tracking |

These cells are intentionally `routePure: false`. Across the five-track runs,
the replay gate took 1.32–1.37 s, total pushed frames were 2396–2402, and every
run recorded 6000–6005 serve hits. The policy therefore preserves the three
healthy hardware sessions and keeps the main thread alive under two spills for
this codec.

H.264, the codec in the original engine-cliff table, first produced
three-repeat **isolated prototype** evidence for the same 3-gpu +
quarter-size/half-cadence shape. Four tracks had 0.00 % drops, all rings
tracking, and zero timer gaps over 50 ms in all three runs; five tracks kept
all rings tracking and the timer alive in all three, though drops were
3.16–3.66 % and tick p99 varied 23.1–56.8 ms. Those six retained JSONs are
named `playback-perf-t13-cap3-spill540p15[-4t]-r1..r3.json`.

The formal main-worktree run on the final IPC/admission implementation with the
final replay state gate is now collected — `84182572`, six cells named
`playback-perf-2026-07-27-84182572-t13-h264-{4,5}-r1..r3.json`:

| current 4K H.264 | runs | lane mix | drops | tick p99 | timer gaps >50 ms | ring result |
|---|---:|---|---:|---:|---:|---|
| 4 tracks, replay state gate | 3 | 3 gpu + 1 sw | 0.00 % in all | 57.1 / 58.0 / 57.5 ms | 0 / 0 / 0 | 28 / 28 / 28 / 16, every ring tracking |
| 5 tracks, replay state gate | 3 | 3 gpu + 2 sw | 0.00 % in all | 54.1 / 55.1 / 43.8 ms | 0 / 0 / 0 | 28–29 on GPU, 15–16 on spill, every ring tracking |

Every cell is `routePure: false` with zero drift; the replay gate released in
1.85–2.16 s (against HEVC's 1.32–1.37 s); `VideoDecode` sat at 69–71 %. Both
track counts fail the smooth verdict on the tick criterion alone — 0.00 %
drops, presented 51.7–54.9 fps, a live 8 ms timer with nothing over 18.5 ms,
97–98 % pre-render share and no script over the floor — which is the 4K
hardware intermittency's documented shape, and the p99 range reproduces the
prototype's. Five-track drops improved on the prototype's 3.16–3.66 % to
0.00 %. The acceptance items (rings tracking at close, five-track liveness,
n ≥ 3 with run-independent verdicts) are met on the original codec; the tick
tail is not cap-attributable and stays with the 2-track intermittency above.

(An earlier same-day attempt measured a machine-wide d3d11va outage, not the
build — zero GPU sessions across seven consecutive launches of either codec,
`VideoDecode` 0, hours after the HEVC set had passed 3/3 on identical code; a
1-track probe after ~10 min idle was healthy again. Those artifacts are
preserved as `*-envfail`. It is the quiet-machine rule made concrete.)

**Ordering remains a release gate.** The order spec now computes the largest
admitted count for its fixture from both live currencies, while retaining pool
1/3/5 coverage. Under `rendererFence`, all eight cells passed with 299 checked,
0 missing and 0 mismatched frames per ordering cell. Under the deliberately
incorrect `none` barrier, the five pixel-checking cells failed on mismatches
only (181–252 of 299), while budget/fallback and software controls stayed green.
That is the slot-reuse race the negative control exists to expose.

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
`tickInterval` p99 reaches 67–119 ms against a `tickTotal` p50 of 2.9–3.6 ms. The
loop is not overrunning its budget — and it is not being starved of frames
either. What stops is the whole main thread; see
[the tick gap](#a-tick-gap-is-the-main-thread-stopping-not-the-loop-being-starved).

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

**The software lane's own wall IS size-bound**, and ¼ is what proves it. The
1-track rows above predate the cursor fix and were still decode-starved (¼ rescued
the tick at 18.7 ms while leaving 62.6 % drops), so re-read at the track count
that fails today — 3 × 1080p H.264 — where nothing is starved on either side:

| 1080p ffmpeg-sw, 3 tracks | full | ¼ |
|---|---|---|
| tick p50 / p99 / max | 16.60 / **67.30** / 116.50 ms | 16.70 / **17.10** / 17.80 ms |
| `rafInterval` max · `rafLag` max | 116.90 · 112.80 ms | 16.90 · **1.20** ms |
| long frames >50 ms · timer gaps >50 ms | 27 · 40 | **0** · **0** |
| delivery per clip · drops · presented | 29.9 fps · 0.00 % · 52.1 fps | 30.0 fps · 0.00 % · **60.0 fps** |
| `nv12Ingest` p50 · CPU main / renderer | 2.50 ms · 9.4 / 8.1 % | 0.10 ms · 4.5 / 1.6 % |

Sixteen times fewer bytes shipped and uploaded is a *completely* clean cell. That
is attributable to the bytes rather than to the raster only because the route
differential below already excludes the raster at this resolution and track
count — the hardware and WebCodecs routes rasterize the same full-size canvas with
the same three layers and are both smooth.

`--playback-resolution` stays a diagnostic and never a comparison axis; this is
what the diagnostic is for.

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
| HEVC 8-bit 1080p | webcodecs | **≥5** (never reached) | drops 0.0 % and tick p99 ≤ 25.2 ms from one track to five — the best result in the matrix |
| HEVC 8-bit 1080p | ffmpeg-hw | **5** | 0.00 % drops through five tracks, all of them on hardware, with `nv12Ingest` never firing; the five-track cell holds tick p99 18.10 ms against a 33.3 ms budget. Was 1 (tick p99 84.8 ms at two), and the whole of that was the read barrier |
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

### Measured non-levers — do not spend time here

Each of these was bracketed by its own instrument and came back too small to
matter. Re-optimizing any of them buys nothing, so a plausible-sounding
proposal to do so should be answered with this list rather than a fresh
profiling run:

- **The snapshot blit** (`blitDrawImage`): mean 0.02–0.03 ms, p95 ≤ 0.2 ms —
  a rounding error against a 16.7 ms budget. This is also the measurement that
  keeps zero-copy GPU upload parked (see [render](render.md)).
- **`ringLookup`, the audio sweep, `stage.removeChildren()` and the
  effect-chain sync**: each ≤ 3 % of a `tickTotal` that is itself only 2–6 %
  of budget.
- **`nv12Ingest`**: negligible at 1080p (p95 1.3 ms).
- **The GPU's VideoDecode engine** sits at ~5 % per 1080p hardware track, so
  no decoder is saturated at that resolution.

4K is the exception on the last two counts — `nv12Ingest` reaches p95 9.0 ms
there — and that belongs to the open main-thread stall above, not to a
per-stage cost.

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
