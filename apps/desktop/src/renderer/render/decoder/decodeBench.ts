// E2E-only decode-strategy benchmark driver. Measures at the DecoderHandle
// seam against a PRIVATE SourceDecoderPool (never the Compositor's live one),
// so scenarios are deterministic and UI-independent. Installed on
// window.__weftcutTest by e2eHook.installDecodeBenchHooks; imported only from
// there, so prod bundles tree-shake it out with the rest of the hook surface.
// Spec: docs/superpowers/specs/2026-07-03-decode-bench-design.md
import { convertFileSrc } from "@/bridge/ipc";
import { SourceDecoderPool, type SourceHandle } from "./SourceDecoderPool";
import type { NativeGpuSourceHandle } from "./NativeGpuSourceHandle";

/// Either decode strategy's handle. Both expose `ring: FrameRing` (so
/// `ring.pushCount`/`lastPtsUs()`/`containsPts()` resolve without narrowing),
/// `ensureReady`, and `requestFrameAt` — the runners below need no strategy-
/// specific branching.
type BenchHandle = SourceHandle | NativeGpuSourceHandle;

export type BenchStrategy = "webcodecs" | "native";
export type BenchScenario = "throughput" | "seek" | "coldstart";
export interface BenchArgs {
  sourcePath: string; // absolute fixture path; served via weftcut-media:// (unconfined by design)
  durationUs: number;
  scenario: BenchScenario;
  strategy: BenchStrategy;
}

export type SeekCategory = "forward-near" | "forward-far" | "backward-near" | "backward-far";
interface CategoryStats { p50: number; p95: number; max: number; n: number }

export type BenchResult =
  | { kind: "throughput"; measuredMs: number; frames: number; fps: number; xRealtime: number; endedAtEof: boolean }
  | { kind: "seek"; perCategory: Record<SeekCategory, CategoryStats> }
  | { kind: "coldstart"; firstMs: number; restP50: number; restMax: number; iterationsMs: number[] }
  | { kind: "error"; error: string };

const WARMUP_MS = 2_000;
const WINDOW_MS = 30_000;
const EOF_GUARD_US = 1_500_000;
const SCENARIO_TIMEBOX_MS = 90_000;
const SEEK_WAIT_TIMEOUT_MS = 30_000;
const COLD_ITERATIONS = 10;

/// Linear-interpolated percentile over an ASCENDING-sorted array.
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/// The committed, deterministic 40-step seek plan (spec §3.2): starting from
/// 10 s, cycle the four category deltas ten times, clamping each target into
/// [0.5 s, durationUs − 2 s]; the clamped target becomes the next "current".
const SEEK_DELTAS: Array<[SeekCategory, number]> = [
  ["forward-near", 200_000],
  ["forward-far", 15_000_000],
  ["backward-near", -500_000],
  ["backward-far", -20_000_000],
];
export function seekPlan(durationUs: number): Array<{ category: SeekCategory; targetUs: number }> {
  const lo = 500_000;
  const hi = durationUs - 2_000_000;
  let cur = 10_000_000;
  const plan: Array<{ category: SeekCategory; targetUs: number }> = [];
  for (let round = 0; round < 10; round++) {
    for (const [category, delta] of SEEK_DELTAS) {
      const targetUs = Math.min(hi, Math.max(lo, cur + delta));
      plan.push({ category, targetUs });
      cur = targetUs;
    }
  }
  return plan;
}

let phase = "idle";
export function decodeBenchPhase(): string {
  return phase;
}

/// Cooperative cancellation for a scenario that lost the timebox race. Every
/// runner polls it at each loop head and THROWS (never breaks) — partial data
/// after cancellation must not surface as a result; the orphan's rejection is
/// swallowed by the caller, which has already returned the timeout error.
interface CancelToken { cancelled: boolean }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Exported only for the regression test that pins the re-kick contract.
export async function waitContains(h: BenchHandle, tUs: number, token: CancelToken): Promise<void> {
  const t0 = performance.now();
  while (!h.ring.containsPts(tUs)) {
    if (token.cancelled) throw new Error("bench run cancelled");
    if (performance.now() - t0 > SEEK_WAIT_TIMEOUT_MS) {
      throw new Error(`frame at ${tUs}us not available after ${SEEK_WAIT_TIMEOUT_MS}ms`);
    }
    // Mirrors the Compositor's per-tick nudge: the pump exits a pass on
    // MAX_QUEUE backpressure and otherwise waits for the next
    // requestFrameAt to resume — without this the poll loop just watches a
    // parked pump and times out.
    void h.requestFrameAt(tUs);
    await sleep(1);
  }
}

async function runThroughput(h: BenchHandle, durationUs: number, token: CancelToken): Promise<BenchResult> {
  phase = "warmup";
  await h.ensureReady();
  void h.requestFrameAt(0);
  await sleep(WARMUP_MS);
  phase = "measuring";
  const startFrames = h.ring.pushCount;
  const startPts = h.ring.lastPtsUs() ?? 0;
  const t0 = performance.now();
  let endedAtEof = false;
  for (;;) {
    if (token.cancelled) throw new Error("bench run cancelled");
    if (performance.now() - t0 >= WINDOW_MS) break;
    const last = h.ring.lastPtsUs() ?? 0;
    if (last >= durationUs - EOF_GUARD_US) { endedAtEof = true; break; }
    // Advance the anchor to the decode frontier so the pump never idles —
    // the unthrottled analogue of the Compositor's per-tick nudge.
    void h.requestFrameAt(last);
    await sleep(10);
  }
  const measuredMs = performance.now() - t0;
  const frames = h.ring.pushCount - startFrames;
  const contentUs = (h.ring.lastPtsUs() ?? startPts) - startPts;
  // A short window that ended at EOF is VALID data (fast decoders drain the
  // 60s fixture early — the fps over that span is still the throughput).
  // Only a near-empty window is unusable: it means decode outran the fixture
  // during the 2s warm-up, so nothing was left to measure.
  if (frames < 60 || measuredMs < 1_000) {
    return {
      kind: "error",
      error: `window too small (frames=${frames}, ${measuredMs.toFixed(0)}ms) — decode outran the 60s fixture during warm-up`,
    };
  }
  return {
    kind: "throughput",
    measuredMs,
    frames,
    fps: frames / (measuredMs / 1000),
    xRealtime: contentUs / 1000 / measuredMs,
    endedAtEof,
  };
}

async function runSeek(h: BenchHandle, durationUs: number, token: CancelToken): Promise<BenchResult> {
  phase = "warmup";
  await h.ensureReady();
  void h.requestFrameAt(10_000_000);
  await waitContains(h, 10_000_000, token);
  phase = "measuring";
  const samples = new Map<SeekCategory, number[]>();
  for (const step of seekPlan(durationUs)) {
    if (token.cancelled) throw new Error("bench run cancelled");
    const t0 = performance.now();
    void h.requestFrameAt(step.targetUs);
    await waitContains(h, step.targetUs, token);
    const ms = performance.now() - t0;
    (samples.get(step.category) ?? samples.set(step.category, []).get(step.category)!).push(ms);
  }
  const perCategory = {} as Record<SeekCategory, CategoryStats>;
  for (const [cat, arr] of samples) {
    const sorted = [...arr].sort((a, b) => a - b);
    perCategory[cat] = {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted[sorted.length - 1]!,
      n: sorted.length,
    };
  }
  return { kind: "seek", perCategory };
}

async function runColdstart(
  pool: SourceDecoderPool,
  mkInit: (layerId: string) => Parameters<SourceDecoderPool["acquire"]>[0],
  token: CancelToken,
): Promise<BenchResult> {
  phase = "measuring";
  const iterationsMs: number[] = [];
  for (let i = 0; i < COLD_ITERATIONS; i++) {
    // Checked BEFORE acquire so a cancelled run never re-acquires on a pool
    // the caller is about to dispose.
    if (token.cancelled) throw new Error("bench run cancelled");
    const layerId = `bench-cold-${i}`;
    const h = pool.acquire(mkInit(layerId));
    const t0 = performance.now();
    await h.ensureReady();
    void h.requestFrameAt(5_000_000);
    await waitContains(h, 5_000_000, token);
    iterationsMs.push(performance.now() - t0);
    // Releasing the only handle drops the SourceMedia refcount to 0 → the
    // demuxer is disposed, so the next acquire re-opens genuinely cold.
    pool.release(layerId);
  }
  const rest = [...iterationsMs.slice(1)].sort((a, b) => a - b);
  return {
    kind: "coldstart",
    firstMs: iterationsMs[0]!,
    restP50: percentile(rest, 50),
    restMax: rest[rest.length - 1]!,
    iterationsMs,
  };
}

export async function decodeBenchRun(args: BenchArgs): Promise<BenchResult> {
  phase = "setup";
  const token: CancelToken = { cancelled: false };
  let pool: SourceDecoderPool | null = null;
  let orphaned = false;
  let scenarioP: Promise<BenchResult> | null = null;
  try {
    pool = new SourceDecoderPool();
    const livePool = pool;
    const url = convertFileSrc(args.sourcePath);
    const mkInit = (layerId: string) => ({
      layerId,
      mediaId: `bench:${args.sourcePath}`,
      // Unused by the native strategy (it decodes `sourcePath` directly) but
      // still passed — `proxyAssetUrl` is required by `SourceHandleInit`.
      proxyAssetUrl: url,
      ...(args.strategy === "native"
        ? { forceStrategy: "native" as const, sourcePath: args.sourcePath }
        : {}),
    });
    scenarioP = (async (): Promise<BenchResult> => {
      switch (args.scenario) {
        case "throughput":
          return runThroughput(livePool.acquire(mkInit("bench-0")), args.durationUs, token);
        case "seek":
          return runSeek(livePool.acquire(mkInit("bench-0")), args.durationUs, token);
        case "coldstart":
          return runColdstart(livePool, mkInit, token);
      }
    })();
    // Always-handled: if the timeout wins the race, the orphan's eventual
    // rejection (cancellation throw) must not surface as unhandled.
    scenarioP.catch(() => {});
    const timeoutP = sleep(SCENARIO_TIMEBOX_MS).then((): BenchResult => {
      token.cancelled = true;
      orphaned = true;
      return { kind: "error", error: `timeout after ${SCENARIO_TIMEBOX_MS}ms in phase ${phase}` };
    });
    return await Promise.race([scenarioP, timeoutP]);
  } catch (e) {
    return { kind: "error", error: String(e) };
  } finally {
    phase = "idle";
    const p = pool;
    if (p) {
      if (orphaned && scenarioP) {
        // The losing scenario may still hold handles for a few ticks (or be
        // parked in a hung ensureReady). The token makes its loops exit on
        // the next poll; dispose only after it settles so nothing races a
        // disposed pool — and a hung ensureReady's deferred dispose still
        // closes the decoder when it eventually settles.
        void scenarioP.catch(() => {}).finally(() => p.dispose());
      } else {
        p.dispose();
      }
    }
  }
}
