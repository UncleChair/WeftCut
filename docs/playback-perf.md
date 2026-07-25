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

### The hardware lane's read barrier

The hardware lane pays a synchronous GPU drain per delivered frame per session
(`forceSharedTextureReadComplete` in the preload) so a pool slot cannot recycle
mid-read. It is load-bearing for correctness — without it the lane presents
frames `pool_size` out of order — and it is the prime suspect for judder the
dropped-frame counter cannot see.

The report carries its `p50`/`p95`/`max`, its **sample count**, and the derived
**thread-seconds of barrier per wall-second** summed across sessions. That last
figure is the one that decides whether the barrier is on the critical path: a
20 ms drain at 2 fps is free, the same drain at 30 fps is not.

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
`hw-budget-exceeded` and fall to the software transport in place, with no event
and no log. The sweep records the per-cell lane mix instead of rejecting those
cells — that degradation is production behaviour and is one of the things the
matrix exists to surface.

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
| 1080p ffmpeg-sw | **0** | 88.9 % of comp frames showed a late frame at ONE track |
| 1080p webcodecs | **2** | drops 7.2 % at 3 — decoder/VRAM, while ticks stayed at p95 17.5 ms |
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

### `MAX_HW_SESSIONS = 3` degrades off a cliff

The fourth 1080p clip takes a `hw-budget-exceeded` and opens on the ffmpeg
software transport in place. That one clip takes the whole session with it:

| | 3 tracks | 4 tracks |
|---|---|---|
| lane mix | 3 × `native-gpu` | 3 × `native-gpu` + 1 × `sw` |
| tick p50 | 15.1 ms | **82.6 ms** |
| presented | 59.9 fps | **13.0 fps** |
| main-process CPU | 0.7 % | **28.7 %** |
| drops | 0.0 % | 39.8 % |

The tick body still only costs 0.9 ms there — the collapse is the software
lane's NV12 delivery arriving on the renderer's main thread. Nothing fires an
event or a log when this happens.

That cell is also the internal check on the software pin: this `sw` clip was
produced *organically* by the session budget, not by the `WEFTCUT_FORCE_HW_LANE`
pin, and shows the same signature (`nv12Ingest` appears, main-process CPU jumps).

### The software lane's ceiling is serialization, not compute

| 1080p ffmpeg-sw | delivery | ring | main CPU |
|---|---|---|---|
| 1 track | 28.0 fps | 11 frames, lookahead never full | 32.8 % |
| 2 tracks | 15.0 + 15.4 fps | 5 + 6 | 51.6 % |

Total delivery is pinned near **30 frames of 1080p per second regardless of clip
count** — two clips each get half, not each get their own — while the main
process never reaches half of one core on a 16-thread box. A compute-bound lane
would saturate a core and scale with clips; this one splits a fixed budget, which
is the shape of a serialized per-frame request/deliver round-trip. Because
ProRes, DNxHR, MPEG-2 and every 10-bit source *must* use this lane, it is not an
edge case.

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

At four 1080p tracks three of the four rings are **empty** — the decoders died
rather than merely fell behind. At 4K two tracks ask for ~4 GB and get 1.6 GB.
This is why the WebCodecs legs fail with clean ticks and zero paint cost: the
wall is retained memory, not decode throughput or compositing.

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
1.6× for 16× fewer shipped pixels. A throughput-bound lane would have scaled far
closer to 16×; a purely latency-bound one would not have moved at all. It is
mostly serialization with a real size term on top — which is why ¼ rescues its
*tick* (18.7 ms, clean) while leaving it decode-starved (62.6 % drops).

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
| ProRes 422 1080p | ffmpeg-sw (only route) | 0 | delivers **93 fps** for 30 fps content, drops 0.2 % — and still juddered: tick p50 41.7 ms, presented 27.1 fps |
| HEVC 10-bit 1080p | ffmpeg-sw (only route) | 0 | delivers **3.3 fps**, 100 % drops, ring permanently empty |

Two of these are shape-changing rather than just slower:

**ProRes inverts the software lane's failure.** H.264 on that lane is starved
(28 fps for 30 fps content); ProRes is the opposite — an all-intra codec decodes
at 3.1× realtime and floods the renderer's main thread with NV12 over IPC. Its
ring reached 66 frames, past the 45 the 1.5 s window should hold, so the
`isLookaheadFull` backpressure is not stopping the pump. Same root cause in both
directions: the lane has no flow control. The 3.1× overshoot also matches the
redundant-re-decode pattern [decode-bench](decode-bench.md) records for the
copy-back lane, where a frontier re-request re-decodes the GOP prefix.
`nv12Ingest` is the largest in-loop stage cost measured anywhere at 1080p here
(p50 1.4 ms, 36 ms per wall-second) — a distant second to the delivery problem.

**10-bit sources reach the compositor as 8-bit NV12.** `tenBitIngest` never
fired on the `hi10p-1080` leg; `nv12Ingest` did. That follows from
[ADR 0029](adr/0029-native-sw-decode-ships-bytes-not-shared-texture.md) — the
software transport ships NV12 — but it means the 10-bit preview path is both the
slowest in the matrix (3.3 fps) and bit-depth-lossy, and that `TenBitIngest` is
unreachable from this route.

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
