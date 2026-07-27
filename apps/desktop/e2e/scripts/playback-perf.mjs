// Preview-playback performance matrix. LOCAL-ONLY, beside decode-bench.mjs and
// the memory ratchet, and opt-in for the same reason: it drives the real app for
// minutes per cell and profiles a GPU, so it must never enter the per-PR CI
// matrix.
//
// What it answers, and why decode-bench cannot: decode-bench measures ONE clip
// at the `DecodeSession` seam. This measures the WHOLE preview loop with N
// clips on N tracks — tick → anchor → composite → present — so it can say which
// STAGE is the wall and at what track count the wall is hit. The per-stage
// numbers come from `render/perf/stageTimers.ts`, which brackets the two costs
// `compositeMsLast` structurally cannot see (`setAnchorTime` and the Pixi
// present) plus the per-layer sub-stages inside the composite.
//
// The "Frame fate" table answers the other half — not how long a stage took but
// where each decoded frame WENT. It exists because `decode fps/clip` is a
// `decodedFrameCount` diff and both engines bump that counter before calling
// `FrameRing.push`, so a clip that decodes at full rate into a ring that discards
// every frame is indistinguishable from a healthy one by throughput alone. The
// counters come from `FrameRing`'s `fate` (see `FrameRingFate`).
//
// The three decode paths are pinned on ONE fixture, so a route comparison is
// never codec-confounded:
//   ffmpeg hardware — decode_engine=ffmpeg + WEFTCUT_FORCE_HW_LANE=d3d11va
//   ffmpeg software — decode_engine=ffmpeg + WEFTCUT_FORCE_HW_LANE=nvdec
//                     (Windows never advertises nvdec, so main's advertised-lane
//                     filter empties and `resolveHwLane` reports unavailable
//                     BEFORE probing and before any cache write — a clean
//                     software resolve that neither costs a probe nor poisons
//                     `decode_capability.json`)
//   webcodecs       — decode_engine=webcodecs
// Every cell VERIFIES the pin per layer via `activeClipProbe` before and after
// the measured window and reports the run invalid on drift, so a silently
// downgraded lane can never be published under a hardware label.
//
// Crossed with those routes is the read-barrier axis — `--barrier`, pinned by
// WEFTCUT_HW_BARRIER, and meaningful on the hardware route ONLY, since it
// selects what is waited on between snapshotting a shared texture and acking the
// slot back to the native pool (see `HwBarrierMode` in `src/shared/ipc.ts` for
// the mechanism):
//   rendererFence — the shipped default: the preload runs no barrier and hands
//              the ack obligation to the renderer with the bitmap; the renderer
//              takes the completion signal on Pixi's WebGPU device and acks back
//              over the same port. Both fence variants defer the ack; what
//              separates them is that WebGPU's signal is a promise, so waiting
//              costs nothing, while WebGL2's has to be spun for. Compare them
//              inside ONE sitting — that is what this axis is for.
//   fence    — the same deferral on a PRIVATE offscreen 1×1 WebGL2 context in
//              the preload. Still a hard completion signal and still off the
//              critical path, but on an idle GPU that fence does not signal on
//              its own at any bound: its deadline fallback is a flush-and-poll
//              SPIN (WebGL2 cannot express a blocking wait — Chromium reports
//              `MAX_CLIENT_WAIT_TIMEOUT_WEBGL` as 0) and the spin is what
//              completes it. `spin thread-s/s` is where that shows up.
//              `rendererFence` reports 0 there because it has nothing to poll —
//              read its `fence forced waits` instead, which is saturated by
//              design at low track counts (see `DEADLINE_MS` in
//              renderer/render/decoder/transports/slotFenceQueue.ts).
//   readback — the barrier the fences replaced: correct, shipped for years, and
//              now the control every other variant is read against
//   gpuflush — a GPU-side drain with no CPU readback. INCORRECT on the same
//              ground as `none`: submitting the copy is not what the ack waits
//              for, COMPLETION is, so it reorders too. Kept only to re-run that
//              comparison, never as a candidate.
//   none     — no barrier at all. KNOWINGLY INCORRECT — the lane presents
//              frames out of order — and here only to price the ceiling: what
//              the loop would cost if the wait were free. A `none` number
//              therefore BOUNDS a possible win; it never reports one, because
//              no shippable lane can run that way.
// `barrier p50` is NOT one quantity across variants, and two of them must never
// be differenced: under `readback` it is the whole wait, under `fence` only the
// submit that still blocks (~0.1 ms) — the rest of the wait moved off the
// critical path and is reported apart from it. A `fence` row is therefore not a
// like-for-like reduction of a `readback` row; it is a different cost. What
// decides whether that cost was MOVED or merely renamed is the deadline
// fallback, and nothing in `barrier p50` will say it: a forced wait costs
// roughly what the old barrier cost in DURATION and burns CPU spinning for it.
// Occasional is fine; ROUTINE is strictly worse than the `readback` it replaces
// — the same stall, now paid for twice. Two columns price it: `fence forced
// waits` is how often, `spin thread-s/s` is how much thread time, and only the
// second separates 200 harmless spins from 200 ruinous ones. `spin thread-s/s`
// is also already INSIDE `barrier thread-s/s`, so the total stays the one
// number an acceptance criterion can be written against.
// The pin is verified per clip, not trusted, exactly as the route pin is: a
// variant that cannot get the GL context it needs falls back to `readback`, by
// design and without a word, so each cell compares the mode its clips actually
// ran (`barrierModeObserved`) against the one its label claims and invalidates
// itself on a mismatch. A cell that reached the tables therefore ran the
// variant it is named after, or ran with the env unset and the product default.
// It is a leg axis rather than something flipped between invocations because
// absolute numbers on this box drift 15–25% across sittings — wider than the
// effect being measured — so only variants run back to back inside one sitting
// compare. With `--barrier` absent the variable is left unset: main resolves
// unset to `fence` anyway, but the leg then measures the untouched path rather
// than one that took the env branch.
//
// Requirements 3 of the experiment brief are enforced, not assumed: the
// composition is created at the fixture's own resolution, `playback_resolution`
// is pinned `full` (½/¼ would shrink both the raster target AND the shipped
// NV12), `prefer_proxies` is set false explicitly, a per-media proxy override
// forces Original, and each clip's `builtFromKey` is asserted to carry
// `:original:` rather than `:proxy:`.
//
// Run:
//   1. npm run napi:build && npm run napi:build:decode   (close the dev app — it locks the .node)
//   2. npm run build:e2e                                 (the __weftcutTest hook)
//   3. npm run bench:playback:fixtures                   (from e2e/, generates the matrix)
//   4. npm run bench:playback                            (from e2e/)
//
// Run on a QUIET machine: the typeperf GPU-engine counters are machine-wide.
//
// Exit codes: 0 the matrix completed, 2 the run was invalid (no build, no hook,
// no fixture). Never non-zero because playback was slow — this is an
// instrument, not a gate.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { benchFixturePath } from "./gen-decode-bench-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../..");
const MAIN = path.join(DESKTOP, "out", "main", "index.js");
const RESULTS_DIR = path.join(DESKTOP, "e2e", "bench-results");
const ELECTRON_EXE = path.join(
  DESKTOP, "..", "..", "node_modules", "electron", "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);

const log = (m) => console.log(`[playback-perf] ${m}`);

/// The run could not measure what it exists to measure (exit 2), as opposed to
/// measuring it and finding slow playback (which is a RESULT, never a failure).
/// Thrown, never `process.exit`ed — exiting inside a try skips the `finally` and
/// leaks the Electron process plus the temp dirs.
class InvalidRun extends Error {}

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const CODECS = arg("codec", "h264").split(",");
const RESOLUTIONS = arg("resolution", "1080,2160").split(",");
const ROUTES = arg("route", "hw,sw,webcodecs").split(",");
/// `null` — the single element when the flag is absent — means "launch with
/// WEFTCUT_HW_BARRIER unset", which is not the same leg as an explicit `fence`
/// even though both resolve to it: this is the path the app takes with nobody
/// experimenting on it.
const BARRIER_FLAG = arg("barrier", "");
const BARRIERS = BARRIER_FLAG ? BARRIER_FLAG.split(",") : [null];
const MAX_TRACKS = Number(arg("max-tracks", "8"));
const EXPLICIT_TRACKS = arg("tracks", "") ? arg("tracks", "").split(",").map(Number) : null;
const WINDOW_S = Number(arg("window-s", "20"));
const WARMUP_S = Number(arg("warmup-s", "5"));
// Optional heavy-cell replay: warm the decoder/texture path, seek back to a
// stable early position, re-prove clock progress AND consecutive live ring
// coverage, then reset counters. Off by default, so the ordinary benchmark
// shape is unchanged.
const REPLAY_AFTER_WARMUP = argv.includes("--replay-after-warmup");
/// The matrix pins `full` — anything else shrinks BOTH the raster target and the
/// NV12 the native lane ships, so it is not comparable. Exposed only because
/// sweeping it is the decisive diagnostic for whether a lane's wall is
/// latency-bound (a smaller frame changes nothing) or throughput-bound.
const PLAYBACK_RESOLUTION = arg("playback-resolution", "full");
/// Consecutive FAIL cells that end a leg's sweep. Two, not one: a single cell
/// can fail on a transient (a background job that outlived the quiet gate), and
/// stopping on it would under-report the ceiling.
const FAIL_STREAK_STOP = 2;
/// Fraction of a comp-frame budget of dropped frames a cell may show and still
/// count as smooth.
const DROP_BUDGET = 0.01;
/// Presented-fps floor as a fraction of the leg's own 1-track baseline.
const PRESENT_FLOOR = 0.9;
const COMP_FPS = 30;

/// Which lane each route must resolve to, and the env that pins it. `sourceKind`
/// is the discriminator `activeClipProbe` and `getPerfSnapshot` share, so the
/// assertion cannot disagree with what the HUD would show.
const ROUTE_SPEC = {
  hw: {
    label: "ffmpeg-hw",
    setting: "ffmpeg",
    env: { WEFTCUT_FORCE_HW_LANE: "d3d11va" },
    sourceKind: "native-gpu",
    keyPrefix: "ffmpeg:original:",
  },
  sw: {
    label: "ffmpeg-sw",
    setting: "ffmpeg",
    env: { WEFTCUT_FORCE_HW_LANE: "nvdec" },
    sourceKind: "sw",
    keyPrefix: "ffmpeg:original:",
  },
  webcodecs: {
    label: "webcodecs",
    setting: "webcodecs",
    env: {},
    sourceKind: "webcodecs",
    keyPrefix: "webcodecs:original:",
  },
};

const RES_DIMS = { 1080: [1920, 1080], 2160: [3840, 2160] };

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const max = (a) => (a.length ? Math.max(...a) : NaN);
const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[(s.length - 1) >> 1];
};

// Re-render the tables from a report already on disk, without re-running
// anything. The JSON is rewritten after every cell, so an interrupted sweep
// still holds every completed cell — this is how you read one back.
const REPORT_ONLY = arg("report", "");
if (REPORT_ONLY) {
  printTables(JSON.parse(fs.readFileSync(REPORT_ONLY, "utf8")));
  process.exit(0);
}

// ── Preconditions ───────────────────────────────────────────────────────────
if (!fs.existsSync(MAIN)) {
  console.error("[playback-perf] no built app at apps/desktop/out — run `npm run build:e2e` first.");
  process.exit(2);
}

const BARRIER_MODES = ["readback", "fence", "gpuflush", "none", "rendererFence"];
for (const b of BARRIERS) {
  if (b !== null && !BARRIER_MODES.includes(b)) {
    console.error(`[playback-perf] unknown barrier ${b} (${BARRIER_MODES.join("|")})`);
    process.exit(2);
  }
}
// An ambient value would ride into the leg labelled as the unset control and be
// published under a label that does not name it — the same dishonesty the
// per-layer route verification exists to prevent, one level up.
if (!BARRIER_FLAG && process.env.WEFTCUT_HW_BARRIER) {
  console.error(
    `[playback-perf] WEFTCUT_HW_BARRIER=${process.env.WEFTCUT_HW_BARRIER} is set in this shell — pass it as --barrier so the leg labels name it, or unset it.`,
  );
  process.exit(2);
}
// Sweeping the barrier across the software and WebCodecs routes would spend a
// second sitting-slot per cell re-measuring an identical lane under two labels:
// nothing outside the hardware transport reads the variable.
const nonHwRoutes = ROUTES.filter((r) => r !== "hw" && ROUTE_SPEC[r]);
if (BARRIER_FLAG && nonHwRoutes.length > 0)
  log(`note: the barrier axis exists on the hw route only — ${nonHwRoutes.join(", ")} run once each with WEFTCUT_HW_BARRIER unset, not once per --barrier value.`);

const legs = [];
for (const codec of CODECS) {
  for (const res of RESOLUTIONS) {
    const fixture = `${codec}-${res}`;
    let file;
    try {
      file = benchFixturePath(fixture);
    } catch {
      console.error(`[playback-perf] unknown fixture ${fixture} — add it to BENCH_MATRIX.`);
      process.exit(2);
    }
    if (!fs.existsSync(file)) {
      console.error(`[playback-perf] missing fixture ${fixture} at ${file} — run \`npm run bench:decode:fixtures\`.`);
      process.exit(2);
    }
    for (const route of ROUTES) {
      if (!ROUTE_SPEC[route]) {
        console.error(`[playback-perf] unknown route ${route} (hw|sw|webcodecs)`);
        process.exit(2);
      }
      for (const barrier of route === "hw" ? BARRIERS : [null])
        legs.push({ codec, res: Number(res), route, fixture, file, barrier });
    }
  }
}

const { _electron: electron } = await import("@playwright/test");

// ── GPU engine sampler (Windows typeperf; MACHINE-WIDE, not per process) ─────
// Lifted from decode-bench.mjs. `engtype_3D` is where the composite/present and
// every `createImageBitmap` conversion land; `engtype_VideoDecode` is the
// hardware decoder.
function startGpuSampler() {
  if (process.platform !== "win32") return { stop: () => ({ videoDecode: [], gpu3d: [] }) };
  const counters = [
    "\\GPU Engine(*engtype_VideoDecode)\\Utilization Percentage",
    "\\GPU Engine(*engtype_3D)\\Utilization Percentage",
  ];
  const child = spawn("typeperf", [...counters, "-si", "1"], { windowsHide: true });
  child.on("error", () => {});
  let header = null;
  const videoDecode = [];
  const gpu3d = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('"')) continue;
      const cells = line.split('","').map((c) => c.replaceAll('"', ""));
      if (header === null) { header = cells; continue; }
      let vd = 0, d3 = 0;
      for (let i = 1; i < cells.length; i++) {
        const v = Number(cells[i]);
        if (Number.isNaN(v)) continue;
        if (header[i]?.includes("engtype_VideoDecode")) vd += v;
        else if (header[i]?.includes("engtype_3D")) d3 += v;
      }
      videoDecode.push(Math.min(100, vd));
      gpu3d.push(Math.min(100, d3));
    }
  });
  return { stop: () => { child.kill(); return { videoDecode, gpu3d }; } };
}

/// Aggregate `app.getAppMetrics()` samples per process type. Attribution is the
/// whole point: native ffmpeg decode lands in `Browser` (the napi addon in
/// main), WebCodecs decode + paint in `Tab`, and GPU-process work in `GPU`.
function aggregateMetrics(samples) {
  const cpu = {};
  const memMb = {};
  for (const procs of samples) {
    const perType = {};
    const memPerType = {};
    for (const p of procs ?? []) {
      const t = p.type ?? "unknown";
      perType[t] = (perType[t] ?? 0) + (p.cpu?.percentCPUUsage ?? 0);
      const bytes = p.memory?.privateBytes ?? p.memory?.workingSetSize ?? 0;
      // Electron reports workingSetSize in KB; privateBytes is null off Windows.
      memPerType[t] = (memPerType[t] ?? 0) + bytes;
    }
    for (const [t, v] of Object.entries(perType)) (cpu[t] ??= []).push(v);
    for (const [t, v] of Object.entries(memPerType)) (memMb[t] ??= []).push(v / 1024);
  }
  const out = { cpu: {}, memMb: {} };
  for (const [t, v] of Object.entries(cpu)) out.cpu[t] = { mean: mean(v), max: max(v) };
  for (const [t, v] of Object.entries(memMb)) out.memMb[t] = { mean: mean(v), max: max(v) };
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Per-window deltas of a clip's cumulative `FrameRing` fate counters.
///
/// Deltas, not absolutes: warm-up legitimately churns (the first seek flushes,
/// the decoder walks a GOP prefix to reach the play position), so absolutes
/// would fold cold-start cost into a steady-state measurement. The same reason
/// `stageProfilingReset()` runs after the warm-up sleep.
///
/// `before` missing means the clip was not in the opening snapshot, which for
/// this harness would itself be a finding — the route gate waits for every layer
/// to resolve AND fill a ring before the window opens. Treated as 0 so the row
/// still prints rather than vanishing.
function fateDelta(before, after) {
  if (!after) return null;
  const out = {};
  for (const k of Object.keys(after)) out[k] = after[k] - (before?.[k] ?? 0);
  return out;
}

/// Window delta of one cumulative per-session counter, for the same reason
/// `fateDelta` exists — an absolute bills the measured window for work paid
/// during warm-up. Null when the counter is absent, so a build or a transport
/// that never reports it reads as "not measured" rather than as zero cost.
///
/// Clamped at 0 because a session re-opened mid-window restarts its counter, and
/// a negative term would silently DISCOUNT the cost the counter exists to
/// expose.
function counterDelta(before, after) {
  if (after === undefined || after === null) return null;
  return Math.max(0, after - (before ?? 0));
}

// ── Stall probes ────────────────────────────────────────────────────────────
// Two instruments for a `tickInterval` gap that no stage timer explains, run
// together because the pair is what attributes it.
//
// 1. `long-animation-frame` / `longtask`. Both fire only above 50 ms, and every
//    gap of interest here is 50–170 ms. A long *frame* carries the internal
//    split — `startTime` → `renderStart` (everything before the rendering steps,
//    which is where the rAF callbacks live) → `styleAndLayoutStart` → end — plus
//    per-script attribution for any script over the API's own 5 ms floor. So a
//    stall inside our JS names itself, and a stall with zero scripts and zero
//    long tasks says the time went somewhere that is not script at all.
//
// 2. A plain `setInterval` on the same main thread. This is what separates a
//    BLOCKED thread from one Chromium simply did not give a rendering
//    opportunity to: a timer cannot fire while the thread is blocked, and fires
//    right through a withheld `BeginMainFrame`. The period is coarse enough to
//    see a 50 ms+ stall and the callback is a single timestamp push, so it does
//    not become the thing being measured.
//
// Installed from the harness rather than from `stageTimers.ts` on purpose: a
// PerformanceObserver allocates per entry and a timer is a task, and that module
// is allocation-free while recording and has no business scheduling work.
const TIMER_PROBE_MS = 8;

async function installStallProbes(page, periodMs) {
  return page.evaluate((period) => {
    const w = window;
    const st = { supported: [], frames: [], tasks: [], nFrames: 0, nTasks: 0, error: null };
    w.__pbperfLongFrames = st;
    w.__pbperfObservers = [];
    const tc = { periodMs: period, samples: [], last: 0 };
    w.__pbperfTimer = tc;
    tc.handle = setInterval(() => {
      const now = performance.now();
      if (tc.last !== 0 && tc.samples.length < 20_000) {
        tc.samples.push([now, now - tc.last]);
      }
      tc.last = now;
    }, period);
    st.supported = PerformanceObserver.supportedEntryTypes.filter(
      (t) => t === "long-animation-frame" || t === "longtask",
    );
    const CAP = 400;
    for (const type of st.supported) {
      try {
        const po = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (e.entryType === "long-animation-frame") {
              st.nFrames += 1;
              if (st.frames.length >= CAP) continue;
              st.frames.push({
                startTime: e.startTime,
                duration: e.duration,
                // `renderStart` 0 means the frame never reached rendering.
                renderStart: e.renderStart,
                styleAndLayoutStart: e.styleAndLayoutStart,
                blockingDuration: e.blockingDuration,
                scripts: (e.scripts ?? []).map((s) => ({
                  name: s.name,
                  invoker: s.invoker,
                  invokerType: s.invokerType,
                  sourceURL: s.sourceURL,
                  sourceFunctionName: s.sourceFunctionName,
                  startTime: s.startTime,
                  duration: s.duration,
                  forcedStyleAndLayoutDuration: s.forcedStyleAndLayoutDuration,
                  pauseDuration: s.pauseDuration,
                })),
              });
            } else {
              st.nTasks += 1;
              if (st.tasks.length >= CAP) continue;
              st.tasks.push({
                name: e.name,
                startTime: e.startTime,
                duration: e.duration,
                attribution: (e.attribution ?? []).map((a) => ({
                  containerType: a.containerType,
                  containerName: a.containerName,
                  containerSrc: a.containerSrc,
                })),
              });
            }
          }
        });
        po.observe({ type });
        w.__pbperfObservers.push(po);
      } catch (e) {
        st.error = `${type}: ${String(e)}`;
      }
    }
    return { supported: st.supported, error: st.error, timerPeriodMs: period };
  }, periodMs);
}

async function drainStallProbes(page) {
  return page.evaluate(() => {
    const w = window;
    for (const po of w.__pbperfObservers ?? []) {
      try { po.disconnect(); } catch { /* already gone */ }
    }
    w.__pbperfObservers = [];
    const tc = w.__pbperfTimer ?? null;
    let timer = null;
    if (tc) {
      clearInterval(tc.handle);
      const gaps = tc.samples.map((s) => s[1]).sort((a, b) => a - b);
      const at = (q) =>
        gaps.length === 0
          ? 0
          : gaps[Math.min(gaps.length - 1, Math.max(0, Math.ceil(q * gaps.length) - 1))];
      timer = {
        periodMs: tc.periodMs,
        n: gaps.length,
        p50Ms: at(0.5),
        p95Ms: at(0.95),
        p99Ms: at(0.99),
        maxMs: gaps.length ? gaps[gaps.length - 1] : 0,
        nOver33: gaps.filter((g) => g > 33.3).length,
        nOver50: gaps.filter((g) => g > 50).length,
        // Kept with their timestamps so a timer stall can be lined up against a
        // long animation frame's `startTime`.
        worst: tc.samples
          .slice()
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([t, g]) => ({ atMs: t, gapMs: g })),
      };
    }
    return { longFrames: w.__pbperfLongFrames ?? null, timer };
  });
}

/// Sum every fate counter across a cell's clips. The per-clip spread matters too
/// (see `wastePerClip`), but the cell-level total is what compares two cells.
function fateSum(perClip) {
  const fates = perClip.map((p) => p.ringFate).filter(Boolean);
  if (fates.length === 0) return null;
  const out = {};
  for (const f of fates) for (const [k, v] of Object.entries(f)) out[k] = (out[k] ?? 0) + v;
  return out;
}

/// Frames decoded and then discarded without ever being painted. Three distinct
/// mechanisms, deliberately summed: whichever one dominates, the meaning is the
/// same — decode work paid for and binned. `decodeFps` cannot see any of it.
function wasteOf(f) {
  return f.staleDropped + f.evictedUnserved + f.flushedUnserved;
}

// ── Environment block ───────────────────────────────────────────────────────
async function envBlock() {
  const app = await electron.launch({
    executablePath: fs.existsSync(ELECTRON_EXE) ? ELECTRON_EXE : undefined,
    args: [MAIN],
    env: { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: "1" },
  });
  try {
    const w = await app.firstWindow({ timeout: 60_000 });
    await w.waitForLoadState("domcontentloaded").catch(() => {});
    const versions = await app.evaluate(() => process.versions);
    const gpu = await app.evaluate(({ app: a }) => a.getGPUInfo("basic"));
    // Which renderer backend actually served the preview decides how to read the
    // present column — the preview Application asks for WebGPU and falls back.
    const backend = await w
      .evaluate(() => {
        const c = document.querySelector("canvas");
        return c ? (c.getContext("webgpu") ? "webgpu-capable" : "gl") : "no-canvas";
      })
      .catch(() => "unknown");
    let ffmpeg = "unknown";
    try { ffmpeg = execSync("ffmpeg -version", { encoding: "utf8" }).split("\n")[0]; } catch {}
    let sha = "unknown";
    try { sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch {}
    return {
      electron: versions.electron,
      chrome: versions.chrome,
      gpu: gpu?.gpuDevice?.map((d) => `${d.vendorId?.toString(16)}:${d.deviceId?.toString(16)}`) ?? [],
      gpuNames: gpu?.auxAttributes?.glRenderer ?? null,
      canvasBackendProbe: backend,
      ffmpeg,
      gitSha: sha,
      cpus: `${os.cpus()[0]?.model ?? "?"} ×${os.cpus().length}`,
      totalMemGb: Math.round(os.totalmem() / 2 ** 30),
      platform: `${process.platform} ${process.arch}`,
      date: new Date().toISOString(),
    };
  } finally {
    await app.close().catch(() => {});
  }
}

// ── One cell ────────────────────────────────────────────────────────────────
/// Launch, build an N-track project on one shared media, pin the route, wait for
/// the machine to go quiet, play for the measured window, and return everything
/// sampled. One launch per cell: a HW failure or a total-ffmpeg failure marks a
/// source software-only / webcodecs-only for the REST OF THE SESSION and never
/// re-promotes, so a reused app would let one bad cell poison every later one.
async function runCell(leg, tracks) {
  const spec = ROUTE_SPEC[leg.route];
  const [width, height] = RES_DIMS[leg.res];
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "weftcut-pbperf-"));
  const projectParent = fs.mkdtempSync(path.join(os.tmpdir(), "weftcut-pbperf-proj-"));
  const app = await electron.launch({
    executablePath: fs.existsSync(ELECTRON_EXE) ? ELECTRON_EXE : undefined,
    args: [`--user-data-dir=${userData}`, MAIN],
    env: {
      ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: "1", ...spec.env,
      ...(leg.barrier ? { WEFTCUT_HW_BARRIER: leg.barrier } : {}),
    },
  });
  const consoleErrors = [];
  let gpuSampler = null;
  let metricsTimer = null;
  let replayGate = { used: false };
  try {
    const page = await app.firstWindow({ timeout: 60_000 });
    await page.waitForLoadState("domcontentloaded");
    // The WebCodecs lane can downgrade prefer-hardware → prefer-software
    // internally with no observable state change; its only trace is this line.
    page.on("console", (m) => {
      const t = m.text();
      if (/decoder .* error:/i.test(t) || /hw-budget-exceeded/i.test(t)) consoleErrors.push(t);
    });

    try {
      await page.waitForFunction(
        () =>
          typeof window.__weftcutTest?.newProjectAndEnter === "function" &&
          typeof window.__weftcutTest?.transportPlay === "function" &&
          typeof window.__weftcutTest?.stageProfilingSnapshot === "function",
        undefined,
        { timeout: 30_000 },
      );
    } catch {
      throw new InvalidRun("__weftcutTest playback-bench hooks absent — rebuild with `npm run build:e2e`.");
    }

    // Settings BEFORE any layer exists: `ensureClip` reads `decode_engine` live,
    // so a late flip would resolve the first clip on the wrong engine.
    await page.evaluate(
      (patch) => window.api.backend.invoke("app_settings_set", { patch }),
      { decode_engine: spec.setting, playback_resolution: PLAYBACK_RESOLUTION, preview_effects_enabled: true },
    );

    await page.evaluate(
      (o) => window.__weftcutTest.newProjectAndEnter(o),
      { parentFolder: projectParent, name: `pbperf-${leg.fixture}-${leg.route}${leg.barrier ? `-${leg.barrier}` : ""}-${tracks}t`,
        canvas: { width, height, fpsNum: COMP_FPS, fpsDen: 1 } },
    );
    await page.waitForSelector('[data-testid="timeline-ruler"]', { timeout: 60_000 });
    // The editor mounts BEHIND the splash; nothing coordinate-addressed works
    // until it detaches (~2.5 s).
    await page.waitForSelector(".splash-screen", { state: "detached", timeout: 60_000 });

    // Proxies off BEFORE the first clip resolves. The raw
    // `update_project_settings` command does not reach the renderer store the
    // decode resolver reads — the hook does both halves.
    await page.evaluate(() => window.__weftcutTest.setPreferProxies(false));

    const placed = await page.evaluate(
      async ({ file, n }) => {
        try {
          const first = await window.__weftcutTest.importAndPlaceMedia({ mediaAbsPath: file, tStartUs: 0 });
          await window.__weftcutTest.setProxyOverride(first.mediaId, false);
          const layerIds = [first.layerId];
          for (let i = 1; i < n; i++) {
            const r = await window.__weftcutTest.placeMediaLayer({ mediaId: first.mediaId, tStartUs: 0 });
            layerIds.push(r.layerId);
          }
          return { ok: true, mediaId: first.mediaId, layerIds };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
      { file: leg.file, n: tracks },
    );
    if (!placed.ok) throw new InvalidRun(`timeline build failed: ${placed.error}`);
    if (placed.layerIds.length !== tracks)
      throw new InvalidRun(`asked ${tracks} tracks, placed ${placed.layerIds.length}`);

    // Confirm the two proxy switches really read false, rather than trusting the
    // default. This is the experiment's "proxies explicitly off" requirement.
    const proxyState = await page.evaluate(
      () => window.api.backend.invoke("project_summary", {}).then((s) => ({
        preferProxies: s?.settings?.prefer_proxies ?? null,
        overrides: s?.settings?.proxy_overrides ?? null,
      })),
    ).catch(() => null);

    const probeAll = () =>
      page.evaluate(
        (ids) => ids.map((id) => {
          try { return window.__weftcutTest.activeClipProbe(id); } catch { return null; }
        }),
        placed.layerIds,
      );

    // ── Route verification (pre) ───────────────────────────────────────────
    // Poll until every layer has resolved AND filled a ring: resolution is
    // async (the WebCodecs-original probe, the HW capability probe) and an
    // unresolved clip reads as `null`, not as the wrong lane.
    const deadline = Date.now() + 120_000;
    let pre = null;
    for (;;) {
      pre = await probeAll();
      const ready = pre.every((p) => p && p.builtFromKey && p.ringSize > 0);
      if (ready) break;
      if (Date.now() > deadline) {
        throw new InvalidRun(
          `clips never resolved+filled within 120 s: ${JSON.stringify(pre.map((p) => p && { k: p.builtFromKey, r: p.ringSize }))}`,
        );
      }
      await sleep(250);
    }
    for (const p of pre) {
      if (!p.builtFromKey.startsWith(spec.keyPrefix))
        throw new InvalidRun(`layer ${p.layerId} built from ${p.builtFromKey}, expected ${spec.keyPrefix}*`);
      if (p.builtFromKey.includes(":proxy:"))
        throw new InvalidRun(`layer ${p.layerId} is decoding a PROXY (${p.builtFromKey}) — proxies were meant to be off`);
    }
    const laneMixPre = {};
    for (const p of pre) laneMixPre[p.sourceKind] = (laneMixPre[p.sourceKind] ?? 0) + 1;
    // A leg is "pure" only when EVERY layer sits on the intended lane. The
    // hardware leg goes impure past `MAX_HW_SESSIONS`: the overflow clips ride
    // the software transport in place, with no state change to observe. It IS
    // logged — `noteLaneOpen` emits a `decode-lane` LogBus row for exactly this
    // transition — but worded `hardware → software`, which neither of
    // `consoleErrors`' patterns matches, so that array comes back EMPTY from
    // runs where every spill fired. Only `perClip[].downgraded` and `laneMix`
    // prove a leg spilled here. Recorded, not rejected — that degradation IS
    // production behaviour and is one of the findings this matrix exists to
    // surface.
    const routePure = pre.every((p) => p.sourceKind === spec.sourceKind);

    // ── Quiet gate ─────────────────────────────────────────────────────────
    // Import kicks background work that would otherwise land inside the
    // measured window: the quick-proxy encode (every fixture here is long-GOP
    // or >1080p, so none is `Bypass`), the decodability sweep, and the
    // timeline's filmstrip/waveform tiles. Wait for the whole app to go quiet
    // rather than for any one job, so decorations are covered too.
    const readMetrics = () => app.evaluate(({ app: a }) => a.getAppMetrics());
    const quietStart = Date.now();
    let quietRuns = 0;
    let quietReached = false;
    let quietPolls = 0;
    let quietCpuBusyPolls = 0;
    let quietDerivativeBusyPolls = 0;
    while (Date.now() - quietStart < 300_000) {
      const [m, derivativeJobsPending] = await Promise.all([
        readMetrics().catch(() => null),
        page.evaluate(() => document.querySelector(".derivatives-pill") !== null),
      ]);
      const total = (m ?? []).reduce((s, p) => s + (p.cpu?.percentCPUUsage ?? 0), 0);
      quietPolls++;
      if (total >= 20) quietCpuBusyPolls++;
      if (derivativeJobsPending) quietDerivativeBusyPolls++;
      // CPU can dip between ffmpeg jobs while the derivative queue is still
      // active. The status pill is driven directly by job started/complete/error
      // events, so both signals must stay quiet for the full consecutive window.
      quietRuns = total < 20 && !derivativeJobsPending ? quietRuns + 1 : 0;
      if (quietRuns >= 4) { quietReached = true; break; }
      await sleep(500);
    }
    const quietWaitS = (Date.now() - quietStart) / 1000;
    if (!quietReached) {
      throw new InvalidRun(
        `quiet gate never reached within 300s (polls=${quietPolls}, cpuBusy=${quietCpuBusyPolls}, derivativeBusy=${quietDerivativeBusyPolls})`,
      );
    }

    // ── Play ───────────────────────────────────────────────────────────────
    // Start 2 s in so the window never straddles the clip head, and end well
    // inside the 60 s fixture so the auto-pause at end-of-material can't stop
    // the clock mid-measurement.
    await page.evaluate(() => window.__weftcutTest.transportSeekUs(2_000_000));
    await page.evaluate(() => window.__weftcutTest.stageProfilingSet(true));
    await page.evaluate(() => window.__weftcutTest.transportPlay());

    // `playing` is INTENT — it flips before the warm-up gate releases the clock.
    // An advancing `positionUs` is the only proof playback actually started.
    const probeRes = () => page.evaluate(() => window.__weftcutTest.previewResourceProbe());
    let last = (await probeRes())?.positionUs ?? 0;
    const playDeadline = Date.now() + 30_000;
    for (;;) {
      await sleep(200);
      const p = await probeRes();
      if (p && p.positionUs > last) break;
      last = p?.positionUs ?? last;
      if (Date.now() > playDeadline) throw new InvalidRun("clock never advanced after transportPlay");
    }

    await sleep(WARMUP_S * 1000);

    if (REPLAY_AFTER_WARMUP) {
      await page.evaluate(() => window.__weftcutTest.transportPause());
      await page.evaluate(() => window.__weftcutTest.transportSeekUs(2_000_000));
      await page.evaluate(() => window.__weftcutTest.transportPlay());

      let replayLast = (await probeRes())?.positionUs ?? 0;
      const replayDeadline = Date.now() + 30_000;
      for (;;) {
        await sleep(200);
        const p = await probeRes();
        if (p && p.positionUs > replayLast) break;
        replayLast = p?.positionUs ?? replayLast;
        if (Date.now() > replayDeadline)
          throw new InvalidRun("clock never advanced after replay-after-warmup");
      }

      // A single advancing clock sample proves transport intent, not decoder
      // recovery. A backward replay flushes rings and re-seeks every source; if
      // the measurement opens immediately, that bounded first-frame refill can
      // be mislabeled as steady-state load. Require every ring to bracket the
      // LIVE play position for four consecutive polls. This is state-based (and
      // reported), not a fixed sleep that could hide a decoder which never
      // catches up.
      const gateStart = Date.now();
      const stablePollsRequired = 4;
      let stablePolls = 0;
      let polls = 0;
      let lastCoverage = null;
      while (Date.now() - gateStart < 30_000) {
        const [resource, clips] = await Promise.all([probeRes(), probeAll()]);
        const positionUs = resource?.positionUs ?? null;
        lastCoverage = clips.map((p) => ({
          layerId: p?.layerId ?? null,
          ringSize: p?.ringSize ?? 0,
          ringFirstPtsUs: p?.ringFirstPtsUs ?? null,
          ringLastPtsUs: p?.ringLastPtsUs ?? null,
          boundFramePtsUs: p?.boundFramePtsUs ?? null,
        }));
        const covered = positionUs !== null && clips.every(
          (p) =>
            p &&
            p.ringSize > 0 &&
            p.ringFirstPtsUs !== null &&
            p.ringLastPtsUs !== null &&
            p.ringFirstPtsUs <= positionUs &&
            p.ringLastPtsUs >= positionUs,
        );
        polls++;
        stablePolls = covered ? stablePolls + 1 : 0;
        if (stablePolls >= stablePollsRequired) {
          replayGate = {
            used: true,
            waitS: (Date.now() - gateStart) / 1000,
            polls,
            stablePollsRequired,
            positionUs,
            coverage: lastCoverage,
          };
          break;
        }
        await sleep(250);
      }
      if (!replayGate.used) {
        throw new InvalidRun(
          `replay rings never covered the live position for ${stablePollsRequired} consecutive polls: ${JSON.stringify(lastCoverage)}`,
        );
      }
    }

    // Reset AFTER the warm-up so cold-start decoder init and the first-frame
    // texture allocations stay out of the distribution.
    await page.evaluate(() => window.__weftcutTest.stageProfilingReset());
    const stallProbeSupport = await installStallProbes(page, TIMER_PROBE_MS);
    const t0 = Date.now();
    const startRes = await probeRes();
    const startPerf = await page.evaluate(() => window.__weftcutTest.compositorPerfSnapshot());

    gpuSampler = startGpuSampler();
    const metricSamples = [];
    metricsTimer = setInterval(() => {
      void readMetrics().then((m) => metricSamples.push(m)).catch(() => {});
    }, 500);

    await sleep(WINDOW_S * 1000);

    clearInterval(metricsTimer);
    metricsTimer = null;
    const gpu = gpuSampler.stop();
    gpuSampler = null;
    const wallS = (Date.now() - t0) / 1000;
    const endRes = await probeRes();
    const endPerf = await page.evaluate(() => window.__weftcutTest.compositorPerfSnapshot());
    const stages = await page.evaluate(() => window.__weftcutTest.stageProfilingSnapshot());
    const { longFrames, timer: timerCadence } = await drainStallProbes(page);
    const post = await probeAll();
    await page.evaluate(() => window.__weftcutTest.transportPause());
    await page.evaluate(() => window.__weftcutTest.stageProfilingSet(false));

    // ── Route verification (post) ──────────────────────────────────────────
    const drift = [];
    for (let i = 0; i < pre.length; i++) {
      const a = pre[i], b = post[i];
      if (!b) { drift.push(`${a.layerId}: probe vanished`); continue; }
      if (a.sourceKind !== b.sourceKind) drift.push(`${a.layerId}: ${a.sourceKind}→${b.sourceKind}`);
      if (a.hwLane !== b.hwLane) drift.push(`${a.layerId}: hwLane ${a.hwLane}→${b.hwLane}`);
      if (a.builtFromKey !== b.builtFromKey) drift.push(`${a.layerId}: key changed`);
    }

    // ── Derived ────────────────────────────────────────────────────────────
    const contentS = ((endRes?.positionUs ?? 0) - (startRes?.positionUs ?? 0)) / 1e6;
    const presented = (endRes?.presentedCompositeCount ?? 0) - (startRes?.presentedCompositeCount ?? 0);
    const compFrames = Math.max(1, contentS * COMP_FPS);
    const dropped = (endPerf?.underrun?.droppedFrames ?? 0) - (startPerf?.underrun?.droppedFrames ?? 0);
    const startByLayer = new Map((startPerf?.clips ?? []).map((c) => [c.layerId, c]));
    const perClip = (endPerf?.clips ?? []).map((c) => {
      const s = startByLayer.get(c.layerId);
      return {
        layerId: c.layerId,
        sourceKind: c.sourceKind,
        downgraded: c.downgraded,
        decodeFps: ((c.decodedFrameCount ?? 0) - (s?.decodedFrameCount ?? 0)) / wallS,
        ringSize: c.ringSize,
        lookaheadFull: c.lookaheadFull,
        decodeQueueSize: c.decodeQueueSize,
        // Which barrier this clip's frames ACTUALLY took, as opposed to the one
        // the leg pinned. Null until an instrumented frame lands, and on every
        // transport that has no barrier at all. Checked below.
        barrierModeObserved: c.handoff?.barrierModeObserved ?? null,
        barrierN: c.handoff?.n ?? null,
        barrierP50: c.handoff?.barrierP50 ?? null,
        barrierP95: c.handoff?.barrierP95 ?? null,
        barrierMax: c.handoff?.barrierMax ?? null,
        // The barrier split into the work it forces and the wait it imposes.
        // Null on any route or build that does not instrument it — the same
        // absent-means-no-column treatment the fields above get.
        barrierDrawP50: c.handoff?.barrierDrawP50 ?? null,
        barrierReadP50: c.handoff?.barrierReadP50 ?? null,
        // `fence` only: the wait it deferred rather than removed. `fenceWaitP50`
        // rides its own sample ring — only some frames carry a wait — so it is
        // NOT aligned with the frame window the percentiles above cover and the
        // two cannot be added. `fencePendingQueuePeak` nearing the pool size
        // means the deferral has starved the producer of slots; it is a
        // high-water mark over the session, so it is read absolute like
        // `conversionPeak` below and never diffed.
        fenceWaitP50: c.handoff?.fenceWaitP50 ?? null,
        fencePendingQueuePeak: c.handoff?.fencePendingQueuePeak ?? null,
        // Both forced-spin counters are CUMULATIVE over the session —
        // `HandoffTimings` keeps them as maxima so they survive ring eviction —
        // so both are diffed against the window open, like `decodeFps` and
        // `ringFate`. Read absolute they would bill this window for spins paid
        // while the first frames primed the ring, before the window existed.
        fenceForcedWaits: counterDelta(s?.handoff?.fenceForcedWaits, c.handoff?.fenceForcedWaits),
        fenceForcedWaitMs: counterDelta(s?.handoff?.fenceForcedWaitMsTotal, c.handoff?.fenceForcedWaitMsTotal),
        cibP50: c.handoff?.cibP50 ?? null,
        residentP50: c.handoff?.residentP50 ?? null,
        // Where this clip's frames went during the window. `decodeFps` above is
        // a `decodedFrameCount` diff, and BOTH engines bump that counter before
        // calling `ring.push` — so a clip whose frames all arrive too late to
        // keep reports full-rate delivery with an empty ring. These counters are
        // what tell the two apart.
        ringFate: fateDelta(s?.ringFate, c.ringFate),
        // WebCodecs only: outputs waiting on `createImageBitmap`, each holding
        // an open VideoFrame and therefore a hardware decode-pool slot (ADR
        // 0004). The peak is a lifetime max, so it is read absolute, not diffed.
        conversionInFlight: c.conversionBacklog?.inFlight ?? null,
        conversionPeak: c.conversionBacklog?.peak ?? null,
      };
    });
    // ── Barrier verification ───────────────────────────────────────────────
    // Held to the same standard as the route pin, and invalid on the same
    // terms: a variant that cannot get the GL context it needs degrades to
    // `readback` — deliberately, correctly, and silently — so a leg can run a
    // variant it is not named after. That failure is worse than a missing cell:
    // a `none` leg secretly running `readback` publishes "removing the barrier
    // buys nothing" and retires the question on an artefact. An unpinned leg is
    // held to the product default because that is what main resolves an unset env
    // to — keep this in step with `HW_BARRIER_DEFAULT` in
    // src/main/previewGpu.ts or every unpinned cell invalidates itself on a
    // stale expectation.
    const expectedBarrier = leg.barrier ?? "rendererFence";
    const barrierObserved = perClip.map((p) => p.barrierModeObserved).filter(Boolean);
    const barrierDrift = perClip
      .filter((p) => p.barrierModeObserved && p.barrierModeObserved !== expectedBarrier)
      .map((p) => `${p.layerId}: ${p.barrierModeObserved}`);
    if (barrierDrift.length > 0)
      throw new InvalidRun(`barrier pin did not hold, expected ${expectedBarrier} — ${barrierDrift.join("; ")}`);
    // Distinct from a mismatch: a clip with no observation never delivered an
    // instrumented frame, or sits on a transport with no barrier (the software
    // clips a hardware leg grows past MAX_HW_SESSIONS), and neither is drift.
    // Nothing observed ANYWHERE under a pin is the case that must not pass — the
    // cell cannot say which variant produced it, and an unattributable cell in a
    // variant comparison is the artefact this whole check exists to exclude.
    if (leg.barrier && barrierObserved.length === 0)
      throw new InvalidRun(`barrier ${leg.barrier} pinned but no clip reported one — the pin cannot be confirmed`);

    // Thread-seconds the renderer spends held up by the barrier, per
    // wall-second, summed over every hardware session (each blocks
    // independently, on the same thread). The p50 alone cannot say whether the
    // barrier is on the critical path — 20 ms at 2 fps is free, 20 ms at 30 fps
    // is not — and this is the figure that can.
    //
    // It spans TWO mechanisms, so a `fence` row and a `readback` row reaching
    // the same value do NOT mean the same thing: the synchronous per-frame drain
    // (priced from `barrierP50`, which on the `fence` path is submit-only), plus
    // the wall-clock the deferred path spent spinning in its deadline fallback.
    // The second term is not optional bookkeeping — a forced spin blocks the
    // main thread and contributes nothing to `barrierP50`, so without it this
    // number reads near zero for a `fence` leg that is burning the loop, which
    // is precisely the direction that flatters the candidate.
    const fenceSpinShare = perClip.reduce(
      (s, p) => s + (p.fenceForcedWaitMs !== null ? p.fenceForcedWaitMs / 1000 / wallS : 0),
      0,
    );
    const barrierWallShare = fenceSpinShare + perClip.reduce(
      (s, p) => s + (p.barrierP50 !== null ? (p.barrierP50 * p.decodeFps) / 1000 : 0),
      0,
    );
    const metrics = aggregateMetrics(metricSamples);

    return {
      kind: "ok",
      tracks,
      wallS,
      contentS,
      realtimeRatio: contentS / wallS,
      presentedFps: presented / wallS,
      dropped,
      compFrames,
      dropRatio: dropped / compFrames,
      routePure,
      laneMix: laneMixPre,
      routeDrift: drift,
      // Ring bounds against the playhead at window close. A clip whose decoder
      // reports full-rate delivery while its ring reads empty has produced
      // frames and LOST them — these PTS bounds are what separates "never
      // decoded" from "decoded and evicted".
      ringAtEnd: post.map((p) => p && ({
        layerId: p.layerId,
        ringSize: p.ringSize,
        ringFirstPtsUs: p.ringFirstPtsUs,
        ringLastPtsUs: p.ringLastPtsUs,
        boundFramePtsUs: p.boundFramePtsUs,
        sourceDisposed: p.sourceDisposed,
        spriteBound: p.spriteBound,
      })),
      positionUsAtEnd: endRes?.positionUs ?? null,
      consoleErrors,
      quietReached,
      quietWaitS,
      quietGate: {
        polls: quietPolls,
        cpuBusyPolls: quietCpuBusyPolls,
        derivativeBusyPolls: quietDerivativeBusyPolls,
      },
      replayGate,
      proxyState,
      compositeMsLast: endPerf?.compositeMsLast ?? null,
      compositeMsMax: endPerf?.compositeMsMax ?? null,
      swapsInFlight: endPerf?.swapsInFlight ?? null,
      stages,
      stallProbeSupport,
      longFrames,
      timerCadence,
      perClip,
      barrierWallShare,
      fenceSpinShare,
      metrics,
      gpu: {
        videoDecodeMean: mean(gpu.videoDecode),
        videoDecodeMax: max(gpu.videoDecode),
        gpu3dMean: mean(gpu.gpu3d),
        gpu3dMax: max(gpu.gpu3d),
        samples: gpu.videoDecode.length,
      },
    };
  } finally {
    if (metricsTimer) clearInterval(metricsTimer);
    if (gpuSampler) gpuSampler.stop();
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(projectParent, { recursive: true, force: true });
  }
}

// ── Verdict ─────────────────────────────────────────────────────────────────
/// Three independent failure modes, one criterion each:
///   decode starvation → the product's own dropped-frame counter
///   paint collapse    → presented frames per wall-second falling against this
///                       leg's own 1-track baseline
///   judder            → the tick-interval tail crossing a whole comp-frame
///                       budget, i.e. a tick arriving so late that a
///                       composition frame boundary went unserved
///
/// The third is NOT redundant, and it is the one that matters most. The
/// product's dropped-frame counter judges whether the ring HAD a fresh frame to
/// select, so a loop that is stalled by a synchronous GPU drain — presenting
/// late but never selecting a stale frame — reads as zero drops while looking
/// visibly jerky. On this codebase that is the documented blind spot of the
/// `lag`/dropped-frame indicator, so the sweep would over-report the ceiling
/// without it. Judged absolutely against the comp-frame budget rather than
/// against a baseline: "a tick was later than one whole frame" is machine- and
/// resolution-independent.
function verdict(cell, baseline) {
  if (cell.kind !== "ok") return { pass: false, reasons: ["cell errored"] };
  const budgetMs = 1000 / COMP_FPS;
  const reasons = [];
  if (cell.dropRatio > DROP_BUDGET)
    reasons.push(`drops ${(cell.dropRatio * 100).toFixed(2)}% > ${(DROP_BUDGET * 100).toFixed(0)}%`);
  if (baseline && cell.presentedFps < PRESENT_FLOOR * baseline.presentedFps)
    reasons.push(`presented ${cell.presentedFps.toFixed(1)}fps < ${(PRESENT_FLOOR * 100).toFixed(0)}% of baseline ${baseline.presentedFps.toFixed(1)}fps`);
  const tickP99 = cell.stages?.byStage?.tickInterval?.p99Ms ?? 0;
  if (tickP99 > budgetMs)
    reasons.push(`tick p99 ${tickP99.toFixed(1)}ms > ${budgetMs.toFixed(1)}ms comp-frame budget`);
  return { pass: reasons.length === 0, reasons };
}

// ── Main ────────────────────────────────────────────────────────────────────
const env = await envBlock();
log(`env: Electron ${env.electron} / Chromium ${env.chrome} · ${env.gpuNames ?? env.gpu.join(",")} · ${env.cpus}`);
log(`legs: ${legs.map((l) => `${l.fixture}/${l.route}${l.barrier ? `+${l.barrier}` : ""}`).join(", ")} · window ${WINDOW_S}s warmup ${WARMUP_S}s`);
if (REPLAY_AFTER_WARMUP)
  log("replay-after-warmup: enabled (seek 2s, re-prove clock + four consecutive ring-coverage polls, then reset counters)");

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const report = {
  env,
  config: { windowS: WINDOW_S, warmupS: WARMUP_S, maxTracks: MAX_TRACKS, compFps: COMP_FPS,
    dropBudget: DROP_BUDGET, presentFloor: PRESENT_FLOOR, tracks: EXPLICIT_TRACKS,
    playbackResolution: PLAYBACK_RESOLUTION, barriers: BARRIERS,
    replayUsed: REPLAY_AFTER_WARMUP },
  legs: [],
};
// `--tag` keeps chunked runs (one invocation per codec, say) from overwriting
// each other's report — the file is rewritten after every cell, so two
// concurrent-or-sequential runs sharing a name would clobber.
const TAG = arg("tag", "") ? `-${arg("tag", "")}` : "";
const outFile = path.join(RESULTS_DIR, `playback-perf-${env.date.slice(0, 10)}-${env.gitSha}${TAG}.json`);

for (const leg of legs) {
  const spec = ROUTE_SPEC[leg.route];
  // The label is what every table row is keyed by, so the variant has to live
  // IN it: two legs differing only by barrier are otherwise indistinguishable
  // once the run is read back from JSON.
  const entry = { fixture: leg.fixture, codec: leg.codec, res: leg.res, route: leg.route,
    barrier: leg.barrier,
    label: `${leg.fixture} · ${spec.label}${leg.barrier ? ` · barrier=${leg.barrier}` : ""}`, cells: [] };
  report.legs.push(entry);
  let baseline = null;
  let failStreak = 0;
  const plan = EXPLICIT_TRACKS ?? Array.from({ length: MAX_TRACKS }, (_, i) => i + 1);
  for (const tracks of plan) {
    log(`${entry.label} · ${tracks} track(s) …`);
    let cell;
    try {
      cell = await runCell(leg, tracks);
    } catch (e) {
      cell = { kind: e instanceof InvalidRun ? "invalid" : "error", tracks, error: String(e?.message ?? e) };
    }
    if (cell.kind === "ok" && tracks === 1) baseline = cell;
    const v = verdict(cell, baseline);
    cell.verdict = v;
    entry.cells.push(cell);
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    if (cell.kind === "ok") {
      const fs_ = fateSum(cell.perClip ?? []);
      const waste = fs_ ? ` · waste ${wasteOf(fs_)}/${fs_.pushed + fs_.staleDropped} frames` : "";
      log(`  → ${v.pass ? "SMOOTH" : "STUTTER"} · drops ${(cell.dropRatio * 100).toFixed(2)}% · presented ${cell.presentedFps.toFixed(1)}fps${waste} · lanes ${JSON.stringify(cell.laneMix)}${cell.routeDrift.length ? ` · DRIFT ${cell.routeDrift.join("; ")}` : ""}`);
    } else {
      log(`  → ${cell.kind.toUpperCase()}: ${cell.error}`);
    }
    failStreak = v.pass ? 0 : failStreak + 1;
    if (!EXPLICIT_TRACKS && failStreak >= FAIL_STREAK_STOP) {
      log(`  stopping this leg: ${FAIL_STREAK_STOP} consecutive non-smooth cells`);
      break;
    }
    if (cell.kind === "invalid") {
      log("  stopping this leg: the run could not be measured");
      break;
    }
  }
  // The ceiling is the largest MONOTONE smooth prefix — a lone smooth cell above
  // a stuttering one is noise, not headroom.
  let ceiling = 0;
  for (const c of entry.cells) {
    if (c.kind === "ok" && c.verdict.pass && c.tracks === ceiling + 1) ceiling = c.tracks;
    else break;
  }
  entry.maxSmoothTracks = ceiling;
  log(`${entry.label} → max smooth tracks: ${ceiling}`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
}

log(`report → ${outFile}`);

printTables(report);
process.exit(0);

// ── Markdown ────────────────────────────────────────────────────────────────
/// Declared (not assigned) so `--report` can call it before this point.
function printTables(report) {
  const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "—");
  const pctOf = (part, whole) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—");

  console.log("\n### Track sweep\n");
  console.log("| leg | tracks | verdict | drop% | presented fps | decode fps/clip | tick p50 | tick p99 | composite p50 | present p50 | present p95 | anchor p50 | barrier p50 | fence forced waits | barrier draw p50 | barrier read p50 | fence wait p50 | fence queue peak | barrier n | barrier thread-s/s | spin thread-s/s | CPU main | CPU rend | CPU gpu | GPU vdec% | GPU 3d% | lanes |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const leg of report.legs) {
    for (const c of leg.cells) {
      if (c.kind !== "ok") {
        console.log(`| ${leg.label} | ${c.tracks} | ${c.kind} | | | | | | | | | | | | | | | | | | | | | | | | ${c.error ?? ""} |`);
        continue;
      }
      const s = c.stages?.byStage ?? {};
      const dec = median(c.perClip.map((p) => p.decodeFps));
      const bar = median(c.perClip.map((p) => p.barrierP50).filter((x) => x !== null));
      const barDraw = median(c.perClip.map((p) => p.barrierDrawP50).filter((x) => x !== null));
      const barRead = median(c.perClip.map((p) => p.barrierReadP50).filter((x) => x !== null));
      const fenceWait = median(c.perClip.map((p) => p.fenceWaitP50).filter((x) => x !== null));
      // Both aggregated as the WORST clip, not the median one, and for the same
      // reason the frame-fate table reports `conversionPeak` with `max`: these
      // are the columns that reject the variant, and one session spinning every
      // frame or sitting at the pool ceiling IS the rejection — a median across
      // sessions would dilute exactly the clip that carries the finding.
      const fenceQPeak = max(c.perClip.map((p) => p.fencePendingQueuePeak).filter((x) => x !== null));
      const fenceForced = max(c.perClip.map((p) => p.fenceForcedWaits).filter((x) => x !== null));
      const barN = median(c.perClip.map((p) => p.barrierN).filter((x) => x !== null));
      console.log(
        `| ${leg.label} | ${c.tracks} | ${c.verdict.pass ? "smooth" : "STUTTER"} | ${f(c.dropRatio * 100, 2)} | ${f(c.presentedFps)} | ${f(dec)} | ` +
        `${f(s.tickInterval?.p50Ms, 2)} | ${f(s.tickInterval?.p99Ms, 2)} | ${f(s.composite?.p50Ms, 2)} | ${f(s.present?.p50Ms, 2)} | ${f(s.present?.p95Ms, 2)} | ${f(s.anchor?.p50Ms, 2)} | ${f(bar, 2)} | ${f(fenceForced, 0)} | ${f(barDraw, 2)} | ${f(barRead, 2)} | ${f(fenceWait, 2)} | ${f(fenceQPeak, 0)} | ${f(barN, 0)} | ${f(c.barrierWallShare, 2)} | ${f(c.fenceSpinShare, 2)} | ` +
        `${f(c.metrics.cpu.Browser?.mean)} | ${f(c.metrics.cpu.Tab?.mean)} | ${f(c.metrics.cpu.GPU?.mean)} | ${f(c.gpu.videoDecodeMean)} | ${f(c.gpu.gpu3dMean)} | ${JSON.stringify(c.laneMix)} |`,
      );
    }
  }

  console.log("\n### Stage hotspots (ms per frame, and share of the tick)\n");
  const HOT = ["tickTotal", "tickInterval", "rafInterval", "rafLag", "clockTick", "anchor",
    "composite", "audio", "sceneRebuild",
    "layerSweep", "ringLookup", "bitmapUpload", "blitDrawImage", "nv12Ingest", "tenBitIngest",
    "effects", "transitions", "present"];
  /// Cadence measures, not per-frame costs — a share of `tickTotal` is
  /// meaningless for them and reads as a wildly dominant stage.
  const CADENCE = new Set(["tickInterval", "rafInterval", "rafLag"]);
  console.log("| leg | tracks | stage | p50 | p95 | p99 | max | mean | calls/frame | share of tickTotal | ms per wall-sec |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const leg of report.legs) {
    // The 1-track cell (the clean per-clip cost) and the last measured one
    // (where the wall was hit) — the two rows a reader actually compares.
    const ok = leg.cells.filter((c) => c.kind === "ok");
    const picks = [ok[0], ok[ok.length - 1]].filter((c, i, a) => c && a.indexOf(c) === i);
    for (const c of picks) {
      const s = c.stages?.byStage ?? {};
      const tickTotal = s.tickTotal?.totalMs ?? 0;
      for (const name of HOT) {
        const st = s[name];
        if (!st || st.frames === 0) continue;
        console.log(
          `| ${leg.label} | ${c.tracks} | ${name} | ${f(st.p50Ms, 2)} | ${f(st.p95Ms, 2)} | ${f(st.p99Ms, 2)} | ${f(st.maxMs, 2)} | ${f(st.meanMs, 2)} | ${f(st.callsPerFrame)} | ` +
          `${CADENCE.has(name) ? "—" : pctOf(st.totalMs, tickTotal)} | ${f(st.totalMs / c.wallS, 1)} |`,
        );
      }
    }
  }

  // Where the frames went. This table answers a question the sweep table
  // structurally cannot: `decode fps/clip` reads full-rate whether a frame was
  // painted or binned, because both engines count a frame as decoded on the line
  // before `ring.push`. Read it as a flow — `pushed` in, `stale`/`evict✗`/
  // `flush✗` out, `hit`/`clamp` painted — and the collapsing cells show
  // themselves: delivery high, waste high, ring empty.
  console.log("\n### Frame fate (deltas over the measured window, summed across clips)\n");
  console.log("| leg | tracks | pushed | stale | evicted | evict✗ | flushes | flush✗ | wasted% | hit | clamp | repeat | miss empty | miss gap | conv peak | waste per clip |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const leg of report.legs) {
    for (const c of leg.cells) {
      if (c.kind !== "ok") continue;
      const sum = fateSum(c.perClip ?? []);
      if (!sum) {
        console.log(`| ${leg.label} | ${c.tracks} | — | | | | | | | | | | | | | ring fate absent (pre-instrumentation report) |`);
        continue;
      }
      // Per-clip, because the measured signature of the collapse is UNEVEN: one
      // clip keeps its ring while the others read empty. A cell-level sum hides
      // exactly that.
      const perClipWaste = (c.perClip ?? [])
        .map((p) => (p.ringFate ? wasteOf(p.ringFate) : "—"))
        .join(" / ");
      const convPeak = max((c.perClip ?? []).map((p) => p.conversionPeak).filter((x) => x !== null));
      console.log(
        `| ${leg.label} | ${c.tracks} | ${sum.pushed} | ${sum.staleDropped} | ${sum.evicted} | ${sum.evictedUnserved} | ${sum.flushes} | ${sum.flushedUnserved} | ` +
        `${pctOf(wasteOf(sum), sum.pushed + sum.staleDropped)} | ${sum.serveHit} | ${sum.serveClamp} | ${sum.serveRepeat} | ${sum.serveMissEmpty} | ${sum.serveMissGap} | ` +
        `${f(convPeak, 0)} | ${perClipWaste} |`,
      );
    }
  }

  // Where a `tickInterval` gap the stage timers cannot explain actually went.
  // Read the columns as a decision tree:
  //   `frames >50ms` 0 with a large tick p99 → the gap never reached this thread
  //     at all; look at `rafInterval` and then outside the renderer.
  //   `script (top)` non-empty → it is our JS, outside the tick bracket.
  //   long frames with no script, and `timer max` ALSO blown out → the main
  //     thread was blocked in something that is not script (V8, a sync wait).
  //   long frames with no script and `timer max` near its period → the thread
  //     was alive and running tasks the whole time; what it did not get was a
  //     rendering opportunity, which is a compositor/GPU-side decision.
  // `pre-render share` is the fraction of the long frame spent BEFORE the
  // rendering steps began — i.e. before any rAF callback, which is where
  // `PlaybackEngine.tick` lives.
  const withLong = report.legs.flatMap((leg) =>
    leg.cells.filter((c) => c.kind === "ok" && c.longFrames).map((c) => ({ leg, c })),
  );
  if (withLong.length > 0) {
    console.log("\n### Where the tick gap went (measured window)\n");
    console.log("| leg | tracks | frames >50ms | tasks >50ms | frame dur p50 | frame dur max | pre-render share | blocking total ms | timer p50 | timer p99 | timer max | timer gaps >50ms | script (top) |");
    console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const { leg, c } of withLong) {
      const lf = c.longFrames;
      const tm = c.timerCadence;
      const durs = lf.frames.map((x) => x.duration);
      const blocking = lf.frames.reduce((s, x) => s + (x.blockingDuration ?? 0), 0);
      const preRender = lf.frames.length
        ? median(lf.frames.map((x) => ((x.renderStart || x.startTime) - x.startTime) / x.duration))
        : NaN;
      // Which script the browser blames, summed by function. An empty cell with
      // a non-zero frame count is itself informative: the long frame contained
      // no script over the API's reporting floor, so the time went to
      // style/layout, to V8, or to renderer-internal work.
      const byScript = new Map();
      for (const fr of lf.frames) {
        for (const s of fr.scripts ?? []) {
          const key = `${s.invoker ?? s.name ?? "?"} ${s.sourceFunctionName ?? ""}`.trim();
          byScript.set(key, (byScript.get(key) ?? 0) + (s.duration ?? 0));
        }
      }
      const top = [...byScript.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k} ${f(v, 0)}ms`)
        .join("<br>") || (lf.frames.length > 0 ? "*no script over the floor*" : "—");
      console.log(
        `| ${leg.label} | ${c.tracks} | ${lf.nFrames} | ${lf.nTasks} | ${f(median(durs), 1)} | ${f(max(durs), 1)} | ` +
        `${Number.isFinite(preRender) ? `${(preRender * 100).toFixed(0)}%` : "—"} | ${f(blocking, 0)} | ` +
        `${f(tm?.p50Ms, 1)} | ${f(tm?.p99Ms, 1)} | ${f(tm?.maxMs, 1)} | ${tm ? tm.nOver50 : "—"} | ${top} |`,
      );
    }
  }

  // Collected since the matrix was built, but never printed until now — which
  // made ticket 07's step 4 ("watch for a silent internal downgrade") unanswerable
  // from a report. `decoderFallback.ts` reconfigures with `prefer-software` on a
  // zero-output first-frame error and only `console.error`s; no state anywhere
  // else records it, so these lines are the ONLY trace that a cell labelled
  // hardware silently finished on software.
  const withLines = report.legs.flatMap((leg) =>
    leg.cells
      .filter((c) => c.kind === "ok" && (c.consoleErrors?.length ?? 0) > 0)
      .map((c) => ({ leg, c })),
  );
  if (withLines.length > 0) {
    console.log("\n### Renderer decoder/budget console lines\n");
    console.log("| leg | tracks | n | lines (deduped) |");
    console.log("|---|---|---|---|");
    for (const { leg, c } of withLines) {
      const counts = new Map();
      for (const line of c.consoleErrors) counts.set(line, (counts.get(line) ?? 0) + 1);
      const rendered = [...counts.entries()]
        .map(([line, n]) => `${n}× ${line.replace(/\|/g, "¦")}`)
        .join("<br>");
      console.log(`| ${leg.label} | ${c.tracks} | ${c.consoleErrors.length} | ${rendered} |`);
    }
  }

  console.log("\n### Max smooth tracks\n");
  console.log("| leg | max smooth tracks | limited by |");
  console.log("|---|---|---|");
  for (const leg of report.legs) {
    const firstFail = leg.cells.find((c) => c.kind === "ok" && !c.verdict.pass);
    console.log(`| ${leg.label} | ${leg.maxSmoothTracks} | ${firstFail ? firstFail.verdict.reasons.join("; ") : "not reached within the sweep"} |`);
  }
}
