// decode-bench orchestrator. LOCAL-ONLY (GPU-dependent; meaningless on
// headless CI). Launches the real E2E-built app per (fixture × run), drives
// window.__weftcutTest.decodeBenchRun, samples per-process CPU
// (app.getAppMetrics) and GPU engine utilization (typeperf) during the
// throughput measuring phase, and writes an informative JSON report — the
// exit code never encodes "slow", only harness/self-check failure.
//
//   node apps/desktop/e2e/scripts/decode-bench.mjs [--fixture <name>|all]
//     [--scenario throughput|seek|coldstart|all] [--runs 3] [--self-check]
//
// Prereqs: `VITE_WEFTCUT_E2E=1 npm run build` (apps/desktop) and generated
// fixtures (gen-decode-bench-fixtures.mjs). Run on a quiet machine — the GPU
// counters are machine-wide.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import { BENCH_MATRIX, benchFixturePath } from "./gen-decode-bench-fixtures.mjs";
import { parsePoolSize, SWEEP_POOL_SIZES } from "./bench-cli.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../..");
const MAIN = path.join(DESKTOP, "out/main/index.js");
const RESULTS_DIR = path.join(DESKTOP, "e2e/bench-results");
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const log = (m) => console.log(`[decode-bench] ${m}`);

// ── CLI ──────────────────────────────────────────────────────────────────────
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const selfCheck = process.argv.includes("--self-check");
const fixtureArg = arg("fixture", "all");
const scenarioArg = arg("scenario", "all");
const runs = Number(arg("runs", "3"));
const STRATEGY = arg("strategy", "webcodecs"); // 'webcodecs' | 'native'
if (STRATEGY !== "webcodecs" && STRATEGY !== "native") {
  console.error(`[decode-bench] invalid --strategy '${STRATEGY}' (expected webcodecs|native)`);
  process.exit(1);
}
const POOL_SWEEP = process.argv.includes("--pool-sweep");
const poolSizeParsed = parsePoolSize(arg("pool-size", undefined));
if (!poolSizeParsed.ok) {
  console.error(`[decode-bench] ${poolSizeParsed.error}`);
  process.exit(1);
}
const POOL_SIZE = poolSizeParsed.value; // undefined => native default (3)
if ((POOL_SWEEP || POOL_SIZE !== undefined) && STRATEGY !== "native") {
  console.error("[decode-bench] --pool-size / --pool-sweep only apply to --strategy native");
  process.exit(1);
}
const scenarios = scenarioArg === "all" ? ["throughput", "seek", "coldstart"] : [scenarioArg];
const fixtures = (fixtureArg === "all" ? BENCH_MATRIX : BENCH_MATRIX.filter((r) => r.name === fixtureArg))
  .filter((r) => fs.existsSync(benchFixturePath(r.name)));
if (fixtures.length === 0) {
  console.error(`[decode-bench] no fixtures matching '${fixtureArg}' on disk — run gen-decode-bench-fixtures.mjs first`);
  process.exit(1);
}
if (!fs.existsSync(MAIN)) {
  console.error("[decode-bench] out/main/index.js missing — run `VITE_WEFTCUT_E2E=1 npm run build` in apps/desktop first");
  process.exit(1);
}

// ── GPU engine sampler (Windows typeperf; machine-wide) ─────────────────────
function startGpuSampler() {
  if (process.platform !== "win32") return { stop: () => ({ videoDecode: [], gpu3d: [] }) };
  const counters = [
    "\\GPU Engine(*engtype_VideoDecode)\\Utilization Percentage",
    "\\GPU Engine(*engtype_3D)\\Utilization Percentage",
  ];
  const child = spawn("typeperf", [...counters, "-si", "1"], { windowsHide: true });
  // A failed spawn (typeperf off PATH) emits an 'error' event that Node rethrows
  // as an unhandled exception if unhandled; swallow it and let the sampler return
  // empty series — a missing GPU sampler must not crash the whole run.
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
      if (header === null) { header = cells; continue; } // first CSV line = column names
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
  return {
    stop: () => {
      child.kill();
      return { videoDecode, gpu3d };
    },
  };
}

// ── One app session: run the scenario list for one fixture ─────────────────
async function runSession(fixture, wantScenarios, poolSize) {
  const app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: "1" },
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () => typeof window.__weftcutTest?.decodeBenchRun === "function",
    undefined,
    { timeout: 30_000 },
  );
  const out = {};
  try {
    for (const scenario of wantScenarios) {
      const args = {
        sourcePath: benchFixturePath(fixture.name),
        durationUs: fixture.durationUs,
        scenario,
        strategy: STRATEGY,
        poolSize,
      };
      if (scenario !== "throughput") {
        out[scenario] = await page.evaluate((a) => window.__weftcutTest.decodeBenchRun(a), args);
        continue;
      }
      // Throughput: gate the samplers on the driver's 'measuring' phase.
      const resultP = page.evaluate((a) => window.__weftcutTest.decodeBenchRun(a), args);
      let ph = "setup";
      const tGate = Date.now();
      while (ph !== "measuring" && ph !== "idle" && Date.now() - tGate < 30_000) {
        ph = await page.evaluate(() => window.__weftcutTest.decodeBenchPhase());
        await new Promise((r) => setTimeout(r, 100));
      }
      const gpu = startGpuSampler();
      const metricSamples = [];
      const metricsTimer = setInterval(() => {
        void app.evaluate(({ app: a }) => a.getAppMetrics()).then((m) => metricSamples.push(m)).catch(() => {});
      }, 500);
      // A rejection of resultP (target crash / disconnect) must still tear down
      // the interval and the typeperf child — otherwise the interval keeps the
      // event loop alive forever and the sampler process is orphaned.
      let result;
      let gpuS;
      try {
        result = await resultP;
      } finally {
        clearInterval(metricsTimer);
        gpuS = gpu.stop();
      }
      const byType = {};
      for (const sample of metricSamples) {
        for (const p of sample) {
          (byType[p.type] ??= []).push(p.cpu.percentCPUUsage);
        }
      }
      out[scenario] = {
        ...result,
        resources: {
          cpuByProcess: Object.fromEntries(
            Object.entries(byType).map(([t, xs]) => [t, { mean: mean(xs), max: Math.max(...xs) }]),
          ),
          gpuVideoDecode: { mean: mean(gpuS.videoDecode), max: Math.max(0, ...gpuS.videoDecode) },
          gpu3d: { mean: mean(gpuS.gpu3d), max: Math.max(0, ...gpuS.gpu3d) },
          samples: { appMetrics: metricSamples.length, gpu: gpuS.videoDecode.length },
        },
      };
    }
  } finally {
    await app.close().catch(() => {});
  }
  return out;
}

// ── Environment block ────────────────────────────────────────────────────────
async function envBlock() {
  const app = await electron.launch({ args: [MAIN], env: { ...process.env, WEFTCUT_SUPPRESS_ELEVATION_NOTICE: "1" } });
  try {
    // Wait for the app to be ready before the first main-process evaluate.
    // Evaluating immediately after launch races the main context's startup and
    // fails with "Execution context was destroyed" — mirror runSession's
    // readiness gate (firstWindow + domcontentloaded).
    const w = await app.firstWindow({ timeout: 60_000 });
    await w.waitForLoadState("domcontentloaded").catch(() => {});
    const versions = await app.evaluate(() => process.versions);
    const gpu = await app.evaluate(({ app: a }) => a.getGPUInfo("basic"));
    let ffmpeg = "unknown";
    try { ffmpeg = execSync("ffmpeg -version", { encoding: "utf8" }).split("\n")[0]; } catch {}
    let sha = "unknown";
    try { sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch {}
    return {
      electron: versions.electron, chrome: versions.chrome,
      gpu: gpu?.gpuDevice?.map((d) => `${d.vendorId?.toString(16)}:${d.deviceId?.toString(16)}`) ?? [],
      ffmpeg, gitSha: sha, platform: `${process.platform} ${process.arch}`, date: new Date().toISOString(),
    };
  } finally {
    await app.close().catch(() => {});
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
if (selfCheck) {
  log("self-check: WebCodecs throughput twice on h264-1080 …");
  const fixture = BENCH_MATRIX.find((r) => r.name === "h264-1080");
  const a = (await runSession(fixture, ["throughput"])).throughput;
  const b = (await runSession(fixture, ["throughput"])).throughput;
  if (a.kind !== "throughput" || b.kind !== "throughput") {
    console.error(`[decode-bench] self-check runs errored: ${JSON.stringify([a, b])}`);
    process.exit(1);
  }
  const rel = Math.abs(a.fps - b.fps) / ((a.fps + b.fps) / 2);
  log(`fps ${a.fps.toFixed(1)} vs ${b.fps.toFixed(1)} → Δ ${(rel * 100).toFixed(2)}%`);
  if (rel >= 0.05) { console.error("[decode-bench] SELF-CHECK FAIL: variance >= 5%"); process.exit(1); }
  log("SELF-CHECK PASS");
  process.exit(0);
}

if (POOL_SWEEP) {
  // --pool-size scopes the sweep to that single point; absent → the full grid.
  const sweepSizes = POOL_SIZE !== undefined ? [POOL_SIZE] : SWEEP_POOL_SIZES;
  log(`pool-sweep (native throughput): N = ${sweepSizes.join(", ")}`);
  const env = await envBlock();
  const report = { env, strategy: STRATEGY, mode: "pool-sweep", runs, poolSweep: [] };
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = path.join(RESULTS_DIR, `${env.date.slice(0, 10)}-${env.gitSha}-poolsweep.json`);
  for (const fixture of fixtures) {
    for (const N of sweepSizes) {
      const perRun = [];
      for (let run = 0; run < runs; run++) {
        log(`${fixture.name} N=${N} run ${run + 1}/${runs} …`);
        try {
          const out = await runSession(fixture, ["throughput"], N);
          perRun.push(out.throughput);
        } catch (e) {
          perRun.push({ kind: "error", error: String(e) });
        }
      }
      const tp = perRun.filter((t) => t?.kind === "throughput");
      // Co-select the median-BY-FPS run so fps and its timing block come from the
      // SAME run: Stage 3 correlates fps-vs-N with coordRtt-vs-N, and a median fps
      // paired with a different run's timing would blur that correlation.
      const medianRun = tp.length
        ? [...tp].sort((a, b) => a.fps - b.fps)[Math.floor((tp.length - 1) / 2)]
        : undefined;
      report.poolSweep.push({
        fixture: fixture.name,
        poolSize: N,
        fps: medianRun?.fps ?? NaN,
        xRealtime: medianRun?.xRealtime ?? NaN,
        timing: medianRun?.timing,
        errors: perRun.filter((t) => t?.kind === "error").map((t) => t.error),
      });
      fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    }
  }
  log(`report → ${outFile}`);
  console.log(`\n| fixture | N | fps | ×realtime | coordRtt p50 | cib p50 | resident p50 | ipcTransit(mean) |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  const fmt = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—");
  for (const r of report.poolSweep) {
    const t = r.timing;
    console.log(
      `| ${r.fixture} | ${r.poolSize} | ${fmt(r.fps)} | ${fmt(r.xRealtime)} ` +
      `| ${fmt(t?.coordRttMs?.p50)} | ${fmt(t?.createImageBitmapMs?.p50)} ` +
      `| ${fmt(t?.preloadResidentMs?.p50)} | ${fmt(t?.ipcTransitMsDerived)} |`,
    );
  }
  process.exit(0);
}

const env = await envBlock();
const report = { env, strategy: STRATEGY, runs, cells: [] };
// Resolve the output path + ensure the dir up front so we can rewrite the
// report after every fixture — a crash late in a multi-fixture batch must not
// discard the fixtures already measured.
fs.mkdirSync(RESULTS_DIR, { recursive: true });
const outFile = path.join(RESULTS_DIR, `${env.date.slice(0, 10)}-${env.gitSha}.json`);
for (const fixture of fixtures) {
  const perRun = [];
  for (let run = 0; run < runs; run++) {
    log(`${fixture.name} run ${run + 1}/${runs} …`);
    // A session that throws (launch failure, page crash) is recorded as a
    // cell-level harnessError and the batch continues — one bad session must
    // not abort the whole matrix.
    try {
      perRun.push(await runSession(fixture, scenarios, POOL_SIZE));
    } catch (e) {
      perRun.push({ harnessError: String(e) });
    }
  }
  report.cells.push({ fixture: fixture.name, perRun });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
}
log(`report → ${outFile}`);

// Markdown summary: median across runs for the headline numbers.
console.log(`\n| fixture | fps (median) | ×realtime | seek ffar P95 ms | cold first ms | GPU dec mean % |`);
console.log(`|---|---|---|---|---|---|`);
for (const cell of report.cells) {
  const tp = cell.perRun.map((r) => r.throughput).filter((t) => t?.kind === "throughput");
  const sk = cell.perRun.map((r) => r.seek).filter((s) => s?.kind === "seek");
  const cs = cell.perRun.map((r) => r.coldstart).filter((c) => c?.kind === "coldstart");
  const fmt = (x) => (Number.isFinite(x) ? x.toFixed(1) : "—");
  console.log(
    `| ${cell.fixture} | ${fmt(median(tp.map((t) => t.fps)))} | ${fmt(median(tp.map((t) => t.xRealtime)))} ` +
    `| ${fmt(median(sk.map((s) => s.perCategory["forward-far"]?.p95)))} ` +
    `| ${fmt(median(cs.map((c) => c.firstMs)))} | ${fmt(median(tp.map((t) => t.resources?.gpuVideoDecode.mean)))} |`,
  );
  for (const [i, r] of cell.perRun.entries()) {
    if (r.harnessError) {
      console.log(`  ↳ run ${i + 1} harness: ${r.harnessError}`);
      continue;
    }
    for (const s of scenarios) {
      if (r[s]?.kind === "error") console.log(`  ↳ run ${i + 1} ${s}: ${r[s].error}`);
    }
  }
}
