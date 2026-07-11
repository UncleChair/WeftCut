// E2E-only decode-strategy benchmark driver. Measures at the DecoderHandle
// seam against a PRIVATE SourceDecoderPool (never the Compositor's live one),
// so scenarios are deterministic and UI-independent. Installed on
// window.__weftcutTest by e2eHook.installDecodeBenchHooks; imported only from
// there, so prod bundles tree-shake it out with the rest of the hook surface.
// Spec: docs/superpowers/specs/2026-07-03-decode-bench-design.md
import { convertFileSrc } from "@/bridge/ipc";
import { SourceDecoderPool, type SourceHandle } from "./SourceDecoderPool";
import type { NativeGpuSourceHandle } from "./NativeGpuSourceHandle";
import type { SwSourceHandle } from "./SwSourceHandle";
import type { PreviewGpuTimingReport, PreviewGpuMainTiming } from "../../../shared/ipc";
import { percentile } from "../../../shared/msStats";
export { percentile } from "../../../shared/msStats";

/// Either decode strategy's handle. All three expose `ring: FrameRing` (so
/// `ring.pushCount`/`lastPtsUs()`/`containsPts()` resolve without narrowing),
/// `ensureReady`, and `requestFrameAt` — the runners below need no strategy-
/// specific branching. `SwSourceHandle` backs `strategy: "sw"`
/// (`forceStrategy: "software"`) — the native libavcodec SW decode path,
/// benched at this same `DecoderHandle` seam as the other two strategies.
type BenchHandle = SourceHandle | NativeGpuSourceHandle | SwSourceHandle;

/// Native handles carry a `streamId` + `drainBenchTiming`; the WebCodecs
/// `SourceHandle` has neither. `SwSourceHandle` also carries a `streamId`
/// (Task 7) but no `drainBenchTiming`, so the `typeof` check still excludes
/// it — the sw arm gets plain throughput fps, no Rust GPU timing. Structural,
/// so no value import of the class.
function asNative(h: BenchHandle): (NativeGpuSourceHandle & { streamId: string }) | null {
  return "streamId" in h && typeof (h as NativeGpuSourceHandle).drainBenchTiming === "function"
    ? (h as NativeGpuSourceHandle & { streamId: string })
    : null;
}

export type BenchStrategy = "webcodecs" | "native" | "sw";
export type BenchScenario = "throughput" | "seek" | "coldstart";
export interface BenchArgs {
  sourcePath: string; // absolute fixture path; served via weftcut-media:// (unconfined by design)
  durationUs: number;
  scenario: BenchScenario;
  strategy: BenchStrategy;
  /// Native-only: pool size (slot count) for the Stage-3 sweep. Default 3.
  poolSize?: number;
  /// Throughput driver's per-loop pacing delay (ms). Default 10 (current behavior).
  /// 0 = yield-only (unthrottled) — the max-throughput probe. Baseline stays 10 when absent.
  throttleMs?: number;
}

export type SeekCategory = "forward-near" | "forward-far" | "backward-near" | "backward-far";
interface CategoryStats { p50: number; p95: number; max: number; n: number }

export type BenchResult =
  | { kind: "throughput"; measuredMs: number; frames: number; fps: number; xRealtime: number; endedAtEof: boolean; timing?: ThroughputTiming }
  | { kind: "seek"; perCategory: Record<SeekCategory, CategoryStats> }
  | { kind: "coldstart"; firstMs: number; restP50: number; restMax: number; iterationsMs: number[] }
  | { kind: "error"; error: string };

/// Millisecond stats for one metric. Mirrors the Rust `TimingSummary` shape plus
/// the raw sample count, so preload-derived and Rust-derived metrics report alike.
export interface MsStats { p50: number; p95: number; max: number; mean: number; n: number }

/// The Stage-3 throughput timing breakdown attached to a native throughput result.
export interface ThroughputTiming {
  poolSize: number;
  decodeCopyMs: MsStats;
  coordRttMs: MsStats;
  preloadResidentMs: MsStats;
  createImageBitmapMs: MsStats;
  /// coordRtt.mean − preloadResident.mean: the main<->renderer IPC + event-loop
  /// scheduling cost, isolated by subtraction (see the Stage-3 spec §1). The
  /// preload's residentMs is measured up to just before `port.postMessage`, so
  /// this derived figure also folds in the ImageBitmap transfer + `consumeAck`
  /// dispatch cost that happens after that cutoff — i.e. it is main<->renderer
  /// coordination overhead, not pure wire transit.
  ipcTransitMsDerived: number;
  /// Main-measured renderer round-trip (main<->renderer transit + renderer work).
  rendererRoundTripMs: MsStats;
  /// Rust<->main boundary (tsfn + mpsc + main dispatch) = coordRtt.mean - rendererRoundTrip.mean.
  rustMainBoundaryMs: number;
  /// Pure main<->renderer IPC/queue = rendererRoundTrip.mean - preloadResident.mean.
  mainRendererTransitMs: number;
  /// Throughput-bottleneck probe (Rust clock): a slot's ConsumeAck -> its next
  /// FrameReady — the per-slot-cycle segment coordRtt (emit->ack) does NOT cover.
  /// By telescoping, coordRttMs.mean + ackToEmitMs.mean ~= the per-slot inter-emit
  /// period (poolSize * 1000/fps); whichever dominates localises the ceiling.
  ackToEmitMs: MsStats;
  /// Times the pump early-returned on the lookahead gate WITH a free slot present.
  /// Large => the ackToEmit idle is anchor/lookahead-bound (Rust-side); ~0 => the
  /// pump never idles on the gate, so the ceiling is the ack arrival rate (renderer).
  lookaheadGatedSkips: number;
  /// Round-2 thread time-budget probe (Rust clock). The per-slot probes found the
  /// ~22ms/frame is NOT per-slot; these characterise the session thread directly:
  /// interEmit/interAck = the true production/ack cadence (expect ~1000/fps ms);
  /// recvBlock = per-recv_timeout block distribution (sum ~= total thread idle);
  /// the three counts = wake reasons over the window (idle ticks / acks / anchor nudges).
  interEmitMs: MsStats;
  interAckMs: MsStats;
  recvBlockMs: MsStats;
  recvTimeoutTicks: number;
  recvAckMsgs: number;
  recvReqMsgs: number;
  /// Round-3 stall attribution: the dominant pump early-return names the halt
  /// (eof / pool-full / acquire-timeout / lookahead), and final* is the terminal
  /// state (free-slot count + eof) when the pump last gave up.
  eofReturns: number;
  poolFullReturns: number;
  acquireFailed: number;
  finalFreeSlots: number;
  finalEof: boolean;
}

function statsOf(xs: number[]): MsStats {
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length ? sorted[sorted.length - 1]! : NaN,
    mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN,
    n: xs.length,
  };
}

function summaryToStats(s: PreviewGpuTimingReport["coordRtt"]): MsStats {
  return { p50: s.p50Ms, p95: s.p95Ms, max: s.maxMs, mean: s.meanMs, n: s.count };
}

/// Assemble the throughput timing block from the Rust summaries (coord-RTT +
/// decode/copy) and the preload-piggybacked per-frame samples. Pure — unit-tested.
export function buildThroughputTiming(
  poolSize: number,
  rust: PreviewGpuTimingReport,
  pre: { gvfMs: number[]; cibMs: number[]; residentMs: number[] },
  main: PreviewGpuMainTiming,
): ThroughputTiming {
  const preloadResidentMs = statsOf(pre.residentMs);
  const rendererRoundTripMs = summaryToStats(main.rendererRoundTripMs);
  return {
    poolSize,
    decodeCopyMs: summaryToStats(rust.decodeCopy),
    coordRttMs: summaryToStats(rust.coordRtt),
    preloadResidentMs,
    createImageBitmapMs: statsOf(pre.cibMs),
    ipcTransitMsDerived: rust.coordRtt.meanMs - preloadResidentMs.mean,
    rendererRoundTripMs,
    rustMainBoundaryMs: rust.coordRtt.meanMs - main.rendererRoundTripMs.meanMs,
    mainRendererTransitMs: main.rendererRoundTripMs.meanMs - preloadResidentMs.mean,
    ackToEmitMs: summaryToStats(rust.ackToEmit),
    lookaheadGatedSkips: rust.lookaheadGatedSkips,
    interEmitMs: summaryToStats(rust.interEmit),
    interAckMs: summaryToStats(rust.interAck),
    recvBlockMs: summaryToStats(rust.recvBlock),
    recvTimeoutTicks: rust.recvTimeoutTicks,
    recvAckMsgs: rust.recvAckMsgs,
    recvReqMsgs: rust.recvReqMsgs,
    eofReturns: rust.eofReturns,
    poolFullReturns: rust.poolFullReturns,
    acquireFailed: rust.acquireFailed,
    finalFreeSlots: rust.finalFreeSlots,
    finalEof: rust.finalEof,
  };
}

const WARMUP_MS = 2_000;
const WINDOW_MS = 30_000;
const EOF_GUARD_US = 1_500_000;
const SCENARIO_TIMEBOX_MS = 90_000;
const SEEK_WAIT_TIMEOUT_MS = 30_000;
const COLD_ITERATIONS = 10;

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

// ── Frame-CONTENT-order check (native-hw reorder regression guard) ───────────
// The throughput/seek scenarios above measure fps + latency + frame COUNT, but
// never frame ORDER/CONTENT — which is exactly how the native-hw B-frame reorder
// bug shipped undetected. This driver closes that gap: it decodes an
// index-encoded clip (each presentation frame N carries a 12-stripe binary
// barcode of N; see e2e/fixtures/decode-bench/order-hevc-648.mp4) and asserts
// that the bitmap the ring hands back for pts(N) actually contains barcode N.
// A mispaired bitmap (frame M's pixels tagged with frame N's pts — the slot
// read/ack race) decodes to M ≠ N and is caught deterministically.

export interface OrderCheckArgs {
  sourcePath: string; // absolute fixture path; served via weftcut-media://
  strategy: BenchStrategy; // 'native' = native-hw (the suspect), 'sw' = control
  /// Native-only pool size (slot count). Default 3 (the product default).
  poolSize?: number;
  fpsNum: number;
  fpsDen: number;
  /// Total frames in the clip; the driver walks [0, frameCount-1).
  frameCount: number;
  width: number;
  height: number;
  /// Barcode stripe count (12 in the standard fixture).
  bits: number;
}

export interface OrderCheckMismatch {
  ptsUs: number;
  expectedIdx: number;
  decodedIdx: number;
}

export interface OrderCheckResult {
  strategy: BenchStrategy;
  poolSize: number | null;
  /// Frames whose content was successfully read + compared.
  checked: number;
  /// Frames that never appeared in the ring at their pts within the per-frame
  /// budget (a genuine dropped/undelivered frame — distinct from a mispairing).
  missing: number;
  mismatches: OrderCheckMismatch[];
  error?: string;
}

/// Decode the 12-stripe binary barcode from an RGBA frame buffer. Stripe b is
/// white (luma > 128) iff bit b of the frame index is set; sampled at each
/// stripe's horizontal center on the mid-height row. Robust to NV12 4:2:0 +
/// limited→full-range YUV→RGB (black/white are unambiguous either way).
export function decodeBarcodeIndex(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  bits: number,
): number {
  const stripeW = width / bits;
  const y = Math.floor(height / 2);
  let idx = 0;
  for (let b = 0; b < bits; b++) {
    const x = Math.floor((b + 0.5) * stripeW);
    const off = (y * width + x) * 4; // RGBA
    const luma = 0.299 * data[off]! + 0.587 * data[off + 1]! + 0.114 * data[off + 2]!;
    if (luma > 128) idx |= 1 << b;
  }
  return idx;
}

/// Drive continuous forward decode of an index-encoded clip and verify every
/// delivered frame's pixels match its pts (see the block comment above). Uses a
/// PRIVATE pool like the other bench runners. The drive keeps the pump bursting
/// (anchor nudged forward every step so its lookahead never idles) while a read
/// cursor chases the frontier — the exact condition under which the slot
/// read/ack race is live — and reads each frame's barcode before the lookbehind
/// evicts it.
export async function decodeBenchOrderCheck(args: OrderCheckArgs): Promise<OrderCheckResult> {
  const { sourcePath, strategy, fpsNum, fpsDen, frameCount, width, height, bits } = args;
  const poolSize = args.poolSize ?? null;
  const mismatches: OrderCheckMismatch[] = [];
  let checked = 0;
  let missing = 0;
  const pool = new SourceDecoderPool();
  const PER_FRAME_BUDGET_MS = 5_000;
  const OVERALL_BUDGET_MS = 90_000;
  try {
    const url = convertFileSrc(sourcePath);
    const h = pool.acquire({
      layerId: "order-0",
      mediaId: `order:${sourcePath}`,
      proxyAssetUrl: url,
      ...(strategy === "native"
        ? {
            forceStrategy: "native" as const,
            sourcePath,
            ...(args.poolSize !== undefined ? { poolSize: args.poolSize } : {}),
          }
        : strategy === "sw"
        ? { forceStrategy: "software" as const, sourcePath }
        : {}),
    });
    await h.ensureReady();
    const frameDurUs = (1_000_000 * fpsDen) / fpsNum;
    const ptsOf = (i: number) => Math.round(i * frameDurUs);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("decodeBenchOrderCheck: no 2d context");

    void h.requestFrameAt(0);
    const t0 = performance.now();
    for (let i = 0; i < frameCount - 1; i++) {
      if (performance.now() - t0 > OVERALL_BUDGET_MS) break;
      const pts = ptsOf(i);
      // Evict behind (keep the 0.5s lookbehind) AND nudge the anchor forward so
      // the pump keeps its 0.5s lookahead full — i.e. never idles between slot
      // fills, keeping the read/ack race live.
      h.ring.setAnchor(pts);
      const wStart = performance.now();
      while (!h.ring.containsPts(pts)) {
        void h.requestFrameAt(pts);
        if (performance.now() - wStart > PER_FRAME_BUDGET_MS) break;
        await sleep(1);
      }
      const bmp = h.ring.frameAt(pts) as ImageBitmap | null;
      if (!bmp || !h.ring.containsPts(pts)) {
        missing++;
        continue;
      }
      ctx.drawImage(bmp, 0, 0);
      const decodedIdx = decodeBarcodeIndex(
        ctx.getImageData(0, 0, width, height).data,
        width,
        height,
        bits,
      );
      checked++;
      if (decodedIdx !== i) mismatches.push({ ptsUs: pts, expectedIdx: i, decodedIdx });
    }
    return { strategy, poolSize, checked, missing, mismatches };
  } catch (e) {
    return { strategy, poolSize, checked, missing, mismatches, error: String(e) };
  } finally {
    pool.dispose();
  }
}

// ── HW session-budget probe (smoke item b) ───────────────────────────────────
// The main process caps concurrent native-hw sessions at MAX_HW_SESSIONS (3);
// the (MAX+1)th `previewGpuOpen` throws `hw-budget-exceeded`, which
// NativeGpuSourceHandle surfaces via `onFatalError` so the Compositor's resolver
// downgrades that source off tier 1 (the resolver side is unit-tested in
// decodeCapability.test.ts). This exercises the untested RUNTIME seam: that
// opening MAX+1 real sessions actually rejects at the cap and the rejection
// reaches the handle's fatal path with the budget reason.

export interface BudgetProbeOutcome {
  index: number;
  ready: boolean;
  error: string | null;
  fatalReason: string | null;
}
export interface BudgetProbeResult {
  outcomes: BudgetProbeOutcome[];
  error?: string;
}

export async function decodeBenchBudgetProbe(args: {
  sourcePath: string;
  count: number;
}): Promise<BudgetProbeResult> {
  const pool = new SourceDecoderPool();
  const url = convertFileSrc(args.sourcePath);
  const outcomes: BudgetProbeOutcome[] = [];
  try {
    // Open sequentially WITHOUT disposing, so live session count climbs to the
    // cap and the next open trips it. The pool is disposed in `finally`.
    for (let i = 0; i < args.count; i++) {
      const h = pool.acquire({
        layerId: `budget-${i}`,
        mediaId: `budget:${i}:${args.sourcePath}`,
        proxyAssetUrl: url,
        forceStrategy: "native",
        sourcePath: args.sourcePath,
      }) as NativeGpuSourceHandle;
      let fatalReason: string | null = null;
      // Register before the open attempt so a budget-rejected open is captured.
      h.onFatalError((r: string) => {
        fatalReason = r;
      });
      let ready = false;
      let error: string | null = null;
      try {
        await h.ensureReady();
        ready = true;
      } catch (e) {
        error = String(e);
      }
      outcomes.push({ index: i, ready, error, fatalReason });
    }
    return { outcomes };
  } catch (e) {
    return { outcomes, error: String(e) };
  } finally {
    pool.dispose();
  }
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

async function runThroughput(
  h: BenchHandle,
  durationUs: number,
  token: CancelToken,
  throttleMs = 10,
): Promise<BenchResult> {
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
    // Evict past the lookbehind window as the Compositor does (setAnchor is the
    // ONLY thing that evicts). Without this the ring accumulates every decoded
    // ImageBitmap unbounded (~8MB each at 1080p), exhausting GPU VRAM after ~1300
    // frames and making the native d3d11va decoder fail its next surface alloc
    // ("Operation not permitted") — which halts production and made native's
    // frames/30s read as a false ~44fps ceiling. pushCount is monotonic across
    // eviction, so the throughput signal is unaffected.
    h.ring.setAnchor(last);
    // Advance the anchor to the decode frontier so the pump never idles —
    // the unthrottled analogue of the Compositor's per-tick nudge.
    void h.requestFrameAt(last);
    await sleep(throttleMs);
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
  let timing: ThroughputTiming | undefined;
  const native = asNative(h);
  if (native) {
    const pre = native.drainBenchTiming();
    // takeTimings/takeMainTimings must run BEFORE the pool disposes the handle
    // (which closes the native session); decodeBenchRun's finally disposes only
    // after we return.
    const rust = await window.api.previewGpu.takeTimings(native.streamId);
    // takeMainTimings() drains a GLOBAL (un-keyed) main-side accumulator. This is
    // correct ONLY because the bench runs one native session per fresh process and
    // collects throughput FIRST — a native seek/coldstart draining before throughput
    // in the same process would contaminate this attribution. See the spec's §3.
    const main = await window.api.previewGpu.takeMainTimings();
    timing = buildThroughputTiming(native.poolSize, rust, pre, main);
  }
  return {
    kind: "throughput",
    measuredMs,
    frames,
    fps: frames / (measuredMs / 1000),
    xRealtime: contentUs / 1000 / measuredMs,
    endedAtEof,
    // Conditional spread, not `timing: undefined` — exactOptionalPropertyTypes
    // rejects assigning `undefined` to an optional field that's absent for
    // non-native strategies.
    ...(timing ? { timing } : {}),
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
    // Cast, not a `BenchHandle` widen: Task 6 widened `SourceDecoderPool.acquire`'s
    // return type to include `FfmpegSource` (the collapsed engine model), but
    // `mkInit` below never sets `engine`, so this bench can never actually get one.
    const h = pool.acquire(mkInit(layerId)) as BenchHandle;
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
        ? {
            forceStrategy: "native" as const,
            sourcePath: args.sourcePath,
            // Conditional spread, not `poolSize: args.poolSize` — exactOptionalPropertyTypes
            // rejects assigning `number | undefined` to the optional `poolSize: number` field.
            ...(args.poolSize !== undefined ? { poolSize: args.poolSize } : {}),
          }
        : args.strategy === "sw"
        ? { forceStrategy: "software" as const, sourcePath: args.sourcePath }
        : {}),
    });
    scenarioP = (async (): Promise<BenchResult> => {
      switch (args.scenario) {
        case "throughput":
          // Cast per the runColdstart comment above — `mkInit` never sets `engine`.
          return runThroughput(livePool.acquire(mkInit("bench-0")) as BenchHandle, args.durationUs, token, args.throttleMs);
        case "seek":
          return runSeek(livePool.acquire(mkInit("bench-0")) as BenchHandle, args.durationUs, token);
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
