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
| `lanes` | not the route you asked for. Past `MAX_HW_SESSIONS` (3) the hardware leg is *legitimately* mixed — that is a finding, not a fault — but a 1-track cell on the wrong lane is a broken pin |
| `routeDrift` (JSON) | non-empty means the lane, HW lane, or resolver key changed mid-window. The cell measured two different things |
| `quietReached` / `quietWaitS` (JSON) | `false` means background work (quick-proxy encode, decodability sweep, filmstrip tiles) was still running inside the window |
| `barrier n` | on a hardware leg, a small sample count means the window caught few delivered frames |

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

**WebCodecs magnitudes are one sample each.** The same 1080p 3-track cell
measured 7.2 %, 28.5 % and 50.5 % drops across three runs while its *ceiling*
stayed at 2 tracks. Read WebCodecs ceilings, not WebCodecs magnitudes. The
ffmpeg-hw judder reproduces closely within a session.

**`--playback-resolution` is a diagnostic, never a comparison.** Sweeping it
answers whether a lane's wall is latency-bound (a smaller frame changes nothing)
or throughput-bound (it scales) — that is how the raster hypothesis was killed.
Legs measured at different values are not comparable with each other, and the
matrix is pinned `full`.

## How to read the report

Each run writes
`apps/desktop/e2e/bench-results/playback-perf-<date>-<gitsha>[-<tag>].json`
(gitignored — a local artifact, not review material) and prints three markdown
tables: the track sweep, the per-stage hotspots at one track and at the last
measured count, and the max smooth track count per leg with what limited it. The
JSON is rewritten after every cell, so a crash late in a long sweep keeps
everything already measured — recover it with `--report`.

Read the columns in this order:

1. **verdict + the limiting reason** — what broke, and at which track count. The
   three criteria are drops ≤ 1 %, presented fps ≥ 90 % of the leg's own 1-track
   baseline, and `tickInterval` p99 ≤ one comp-frame budget. The third catches
   judder the other two structurally cannot see.
2. **`tick p50` vs `tick p99`** — p50 near the display interval with a p99
   several times it means the loop is being *stalled*, not overloaded. Look for a
   synchronous cost, not an expensive stage.
3. **`ms per wall-sec` BEFORE `share of tickTotal`.** A stage can own most of a
   tiny tick and still be irrelevant: `tickTotal` has measured 0.2–0.9 ms against
   a 16.7 ms budget in every cell so far, so no share of it has ever been the
   wall. This is the single easiest way to misread the report.
4. **`barrier thread-s/s`**, the per-process CPU split, and ring depth — where
   the time and the memory go when they are not in the tick.

For the deeper JSON fields — `ringAtEnd` (ring bounds against the playhead at
window close, which separates "never decoded" from "decoded and evicted"),
`perClip[].barrierN`, `proxyState`, `consoleErrors` — read the cell object
directly; the markdown is a summary, not the whole record.

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
