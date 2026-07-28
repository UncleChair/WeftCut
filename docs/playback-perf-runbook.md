# playback-perf runbook

How to run a preview-playback measurement session and trust the result.

What the harness measures, and what it has already found, is
[`playback-perf.md`](playback-perf.md); this file is the operating guide. Live
work items are `.scratch/playback-perf/` (local — `.scratch/` is gitignored, so
the tickets do not travel with the repo).

## Prerequisites

Windows for the ffmpeg-hardware leg; the software and WebCodecs legs are
cross-platform. From `apps/desktop`:

```bash
npm run napi:build           # @weftcut/core — CLOSE THE DEV APP FIRST, it locks the .node
npm run napi:build:decode    # @weftcut/native-decode — required by both ffmpeg legs
npm run build:e2e            # the __weftcutTest hook surface
```

Then from `apps/desktop/e2e`:

```bash
npm run bench:decode:fixtures    # shared fixture matrix (idempotent, gitignored, ~2.5 GB)
```

`build:e2e` is not optional. A plain `npm run build` tree-shakes `__weftcutTest`
away and the run dies on a 30 s `waitForFunction` with no other clue; the harness
turns that into an explicit "rebuild with `npm run build:e2e`" and exits 2.

**Rebuild `build:e2e` after every renderer change you want measured.** The bench
drives the built bundle in `out/`, not the dev server — editing a probe and
re-running the bench without rebuilding measures the old code.

## Run it

```bash
npm run bench:playback                                  # the default sweep
npm run bench:playback -- --route hw --max-tracks 4     # one leg
npm run bench:playback -- --codec h264 --resolution 2160 --route hw --tracks 4,5 --replay-after-warmup --tag t13-h264
npm run e2e -- --playback-perf                          # as a gate, after Playwright
```

| flag | default | notes |
|---|---|---|
| `--codec h264,hevc,prores,hi10p` | `h264` | fixture name is `<codec>-<resolution>` |
| `--resolution 1080,2160` | `1080,2160` | composition is created at this size |
| `--route hw,sw,webcodecs` | all three | see [Route pinning](playback-perf.md#route-pinning) |
| `--max-tracks N` | 8 | sweeps 1..N, stopping after 2 consecutive non-smooth cells |
| `--tracks 1,3,5` | — | explicit list; **disables the early stop** |
| `--window-s N` / `--warmup-s N` | 20 / 5 | measured window and warm-up |
| `--replay-after-warmup` | off | pause/seek 2 s/play after warm-up, then require four consecutive live ring-coverage polls before resetting counters; use for heavy spill cells |
| `--playback-resolution full\|half\|quarter` | `full` | a diagnostic axis, not a comparison axis — see below |
| `--tag NAME` | — | suffixes the report file so chunked runs don't clobber |
| `--report PATH` | — | re-render tables from a report on disk, running nothing |

Exit codes: `0` the matrix completed, `2` the run could not be *measured* (no
build, no hook, no fixture). **Never non-zero because playback was slow** — this
is an instrument, not a gate.

Cost: roughly 60–100 s per cell (launch, splash, import, quiet gate, warm-up,
window, teardown). A full six-leg H.264 sweep is ~45 min. Each cell is its own
app launch, so a sticky per-source downgrade cannot leak into later cells.

## Before you trust a number

**Run on a quiet machine.** The `typeperf` GPU-engine counters are machine-wide,
not scoped to the process. Close anything that decodes or renders — including a
second copy of the app.

**Check these columns before reading anything else:**

| column | what invalidates the cell |
|---|---|
| `lanes` / `routePure` | a 1-track cell on the wrong lane is a broken pin. A hardware cell that exceeds either live admission currency is legitimately mixed: at 4K, 4/5 tracks should be 3 GPU + 1/2 formal SW spills and `routePure: false` |
| `routeDrift` (JSON) | non-empty means the lane, HW lane, or resolver key changed mid-window. The cell measured two different things |
| `quietReached` / `quietWaitS` / `quietGate` (JSON) | an ordinary measured cell must have `quietReached: true`: total Electron CPU below 20% **and** no active derivative-job pill for four consecutive polls. A 300 s miss is now `InvalidRun`, not a measured cell. `quietGate` records how many polls each signal blocked |
| `replayGate` (JSON) | when replay is requested, `used` must be true and every recorded ring must have covered the live playhead. Clock progress alone is not enough |
| `barrier n` | on a hardware leg, a small sample count means the window caught few delivered frames |

For budget-shaped expectations, read `window.api.previewGpu.budget()`. Its two
authoritative currencies are `sessions.used/max` and
`codedPixelArea.used/max`; the latter is calibrated at 30 fps and is not a
pixel-rate claim. Do not predict admission from the session count alone, and do
not turn the diagnostic snapshot into a client-side gate — main's atomic
reservation remains authoritative.

A cell that errored reports `{kind: "error"}` or `{kind: "invalid"}` inline and
the batch continues; one bad session never aborts the rest of the matrix.

## Judging a change — the one rule that matters

**Measure baseline and candidate in the SAME session, and compare shapes,
ceilings and ratios — not absolute milliseconds.**

After ~2 h of continuous benching this box re-measured the ffmpeg-hw leg 15–25 %
worse on an *identical* workload — tick p99 38.8 → 46.4 ms at 3 tracks, barrier
p50 20.8 → 28.3 ms at 4K — with ring depth unchanged to within 2 %. The drift
tracks the read barrier, i.e. GPU state, which is also the single most sensitive
number in the report. The tables in `playback-perf.md` are a reference point, not
a control.

So the A/B recipe is:

1. `git stash` your change, `npm run build:e2e`, run the leg with `--tag base`.
2. Restore the change, `npm run build:e2e`, run the same leg with `--tag cand`.
3. Compare. If the two runs are hours apart, they are not comparable.

**WebCodecs magnitudes are one sample each.** The same 1080p H.264 3-track cell
has measured 0.00 %, 7.2 %, 28.3 %, 28.5 %, 50.5 % and 73.5 % drops across runs.
Read WebCodecs ceilings rather than magnitudes — with the caveat that on *this*
leg even the ceiling moves (2 in one sitting, 3 in another), so it is the one
place where a ceiling needs repeats before it is written down. The ffmpeg legs
reproduce closely within a session, and the HEVC WebCodecs leg is stable at ≥5
tracks, so the instability is codec-specific rather than route-wide.

## Traps that have produced a wrong conclusion here

Every one of these shipped a false reading at least once in this spec.

- **A green gate is not evidence that it exercised the thing.** The hardware
  order gate ran a full session green while silently taking the `readback`
  fallback on every session, because a bare `launchApp()` sits on the project
  picker with no Pixi Application and therefore no device — and a barcode check
  passes under *every* correct barrier. Any run that pins a variant must report
  what it **applied**, and a mismatch invalidates the cell the way `routeDrift`
  does. Same class: `preview-hw-conformance` skips entirely on Windows, and a gate
  that always skips looks identical to one that passes.
- **A negative control has to go red in the right SHAPE.** `--barrier none` fails
  with every Δ an integer multiple of `pool_size` — the producer lapping the
  consumer by whole pool cycles. Red for another reason is not the control.
- **A scripted `transportPlay()` that no-ops reads as a perfect cell** — 0 drops,
  0 late ticks, 0 profiler frames. Assert the playhead advanced before trusting
  anything downstream of it.
- **An acceptance metric that predates a mechanism cannot measure it.** A cell
  force-spinning 2 s per 20 s reported `barrier thread-s/s` 0.01 because the share
  derived from a percentile of the *submit* cost. Price a minority-of-frames cost
  with a SUM — any percentile hides it — and re-derive the metric when the
  mechanism changes.
- **A renderer-side counter cannot see producer-side waste.** A starved software
  cell's frame-fate table reads clean because the waste was spent inside
  libavcodec and discarded before any frame reached the ring. The discriminator is
  a native-level probe of decoded-vs-delivered, and driving `SwVideoStream` from a
  `#[ignore]` test A/B'd two policies in 90 s where the matrix took 20 minutes.
- **Two similar magnitudes are not evidence of a shared cause when there are only
  two of them.** Take the suspected cause away and re-measure instead; it is
  nearly always the cheaper experiment.
- **Low CPU is not proof the derivative queue is empty.** ffmpeg jobs can leave
  four low-CPU polls in the gaps between work while quick-proxy, thumbnail, or
  waveform jobs are still active. The quiet gate must also see the renderer's
  derivative-job pill absent for the whole consecutive window. The
  `quietGate.derivativeBusyPolls` count is the audit trail; a fresh 4K import on
  this box has needed ~15 s to clear even though the old CPU-only gate returned
  after ~1.55 s.
- **A replay clock tick is not proof the decoders recovered.** A backward seek
  flushes every ring; opening the window on the first advancing position sample
  includes refill startup in a supposedly steady-state result. The replay gate
  requires every ring to bracket the live playhead for four consecutive 250 ms
  polls and invalidates after 30 s. Never replace it with a fixed sleep.

**`--playback-resolution` is a diagnostic, never a comparison.** Sweeping it
answers whether a lane's wall is latency-bound (a smaller frame changes nothing)
or throughput-bound (it scales) — that is how the raster hypothesis was killed.
Legs measured at different values are not comparable with each other, and the
matrix is pinned `full`.

## How to read the report

Each run writes
`apps/desktop/e2e/bench-results/playback-perf-<date>-<gitsha>[-<tag>].json`
(gitignored — a local artifact, not review material) and prints the track sweep,
the per-stage hotspots at one track and at the last measured count, frame fate,
where the tick gap went, any renderer decoder/budget console lines, and the max
smooth track count per leg with what limited it. The JSON is rewritten after every
cell, so a crash late in a long sweep keeps everything already measured — recover
it with `--report`.

Read the columns in this order:

1. **verdict + the limiting reason** — what broke, and at which track count. The
   three criteria are drops ≤ 1 %, presented fps ≥ 90 % of the leg's own 1-track
   baseline, and `tickInterval` p99 ≤ one comp-frame budget. The third catches
   judder the other two structurally cannot see.
2. **`tick p50` vs `tick p99`** — p50 near the display interval with a p99
   several times it means the loop is being *stalled*, not overloaded. Look for a
   synchronous cost, not an expensive stage.
3. **`rafInterval` vs `rafLag`** — they decompose that gap. All of it in
   `rafLag` means the frame arrived on its vsync and this thread was late to it;
   `rafInterval` blowing out to an integer multiple of the vsync means vsyncs went
   unserved. Then **Where the tick gap went**, as a decision tree: no long frames
   under a large tick p99 means the gap never reached this thread; a `script (top)`
   entry means it is our JS outside the tick bracket; long frames with no script
   and a stalled `timer max` mean the thread was blocked in something that is not
   script; long frames with no script and a healthy timer (p50 8.0 ms, nothing over
   50 ms) mean the thread was alive and lost only a rendering opportunity.
4. **`ms per wall-sec` BEFORE `share of tickTotal`.** A stage can own most of a
   tiny tick and still be irrelevant: `tickTotal` has measured 0.2–0.9 ms against
   a 16.7 ms budget in every cell so far, so no share of it has ever been the
   wall. This is the single easiest way to misread the report.
5. **`barrier thread-s/s`**, the per-process CPU split, and ring depth — where
   the time and the memory go when they are not in the tick.

For the deeper JSON fields — `ringAtEnd` (ring bounds against the playhead at
window close, which separates "never decoded" from "decoded and evicted"),
`perClip[].barrierN`, `proxyState`, `quietGate`, `replayGate`,
`consoleErrors`, and `longFrames.frames[]`
(each long frame's `startTime`/`renderStart`/`styleAndLayoutStart` split, plus
`timerCadence.worst` with timestamps so a timer stall can be lined up against
one) — read the cell object directly; the markdown is a summary, not the whole
record.

## Extending the harness

- **A new fixture**: add a row to `BENCH_MATRIX` in
  `e2e/scripts/gen-decode-bench-fixtures.mjs`, keeping the existing shape. The
  `--fixture` filter, ffprobe validation, gitignore and npm script pick it up for
  free. Name it `<codec>-<resolution>` or the leg builder won't find it.
- **A new stage probe**: add the id to `STAGE` and its name to `STAGE_NAMES` in
  `render/perf/stageTimers.ts`, then bracket the call site with
  `stageNow()` / `stageAdd()`. Add the name to `HOT` in the orchestrator to have
  it printed. Per-layer stages accumulate into one per-frame total automatically.
- **Keep probes inert in production.** `stageNow()` returns 0 and every entry
  point returns on a monomorphic boolean while profiling is off; never call
  `performance.now()` directly in a hot path you are instrumenting.
- **A probe that allocates or posts tasks belongs in the harness, not in
  `stageTimers.ts`.** The long-frame `PerformanceObserver` and the timer-cadence
  interval are installed from `playback-perf.mjs` over the measured window for
  exactly that reason — one allocates per entry, the other *is* a task, and
  neither may exist in a production session at all.
