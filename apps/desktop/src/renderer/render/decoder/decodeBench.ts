// E2E-only decode-strategy benchmark driver. Measures at the DecodeSession
// seam against a PRIVATE SourceDecoderPool (never the Compositor's live one),
// so scenarios are deterministic and UI-independent. Installed on
// window.__weftcutTest by e2eHook.installDecodeBenchHooks; imported only from
// there, so prod bundles tree-shake it out with the rest of the hook surface.
// Spec: docs/decode-bench.md
import { convertFileSrc } from "@/bridge/ipc";
import { getPreviewGpuBudget } from "@/bridge/previewGpu";
import { SourceDecoderPool, type SourceHandle } from "./SourceDecoderPool";
import type { FfmpegSource } from "./FfmpegSource";
import type { FfmpegLane } from "./decodeEngine";
import { isNativeNv12Frame } from "./nv12Frame";
import { percentile } from "../../../shared/msStats";
export { percentile } from "../../../shared/msStats";

/// Either decode strategy's handle. Both expose `ring: FrameRing` (so
/// `ring.pushCount`/`lastPtsUs()`/`containsPts()` resolve without narrowing),
/// `ensureReady`, and `requestFrameAt` — the runners below need no strategy-
/// specific branching. `FfmpegSource` backs both `strategy: "native"`
/// (`forceLane: "hardware"`) and `strategy: "sw"` (`forceLane: "software"`) —
/// the collapsed ffmpeg engine's two lanes, benched at this same
/// `DecodeSession` seam as the WebCodecs strategy.
type BenchHandle = SourceHandle | FfmpegSource;

/// `native-copyback` is the Linux hardware copy-back HW lane (ADR 0034): decode
/// on the GPU (NVDEC/VAAPI), `av_hwframe_transfer_data` back to a CPU NV12 frame,
/// then feed the SAME `DecodeSession` seam as `sw` (the ship-bytes `SwTransport`).
/// UNLIKE `native` it does NOT force the lane — it hands `pickInitialLane` the
/// codec/pixFmt/dimensions so the real HW probe resolves the advertised lane; the
/// orchestrator's `WEFTCUT_FORCE_HW_LANE` env pins WHICH one (nvdec/vaapi).
export type BenchStrategy = "webcodecs" | "native" | "sw" | "native-copyback";
export type BenchScenario = "throughput" | "seek" | "coldstart";
export interface BenchArgs {
  sourcePath: string; // absolute fixture path; served via weftcut-media:// (unconfined by design)
  durationUs: number;
  scenario: BenchScenario;
  strategy: BenchStrategy;
  /// Native-only: pool size (slot count) for the pool-depth sweep. Default 3.
  poolSize?: number;
  /// Throughput driver's per-loop pacing delay (ms). Default 10 (current behavior).
  /// 0 = yield-only (unthrottled) — the max-throughput probe. Baseline stays 10 when absent.
  throttleMs?: number;
  /// `native-copyback`-only: the fixture's codec/pixFmt/dimensions, threaded to
  /// `pickInitialLane` so its probe resolves the advertised HW lane (the env pins
  /// which one). Unused by the other strategies (which force or need no lane hint).
  codec?: string | null;
  pixFmt?: string | null;
  width?: number;
  height?: number;
}

export type SeekCategory = "forward-near" | "forward-far" | "backward-near" | "backward-far";
interface CategoryStats { p50: number; p95: number; max: number; n: number }

export type BenchResult =
  // `hwLane` records the HW lane the source RESOLVED to (`nvdec`|`vaapi`|
  // `d3d11va`, or null on software) — informational for every strategy, and the
  // `native-copyback` HW-vs-SW-fallback confirmation (a SW fallback there is
  // rejected as an error before it can be mislabeled a HW number).
  | { kind: "throughput"; measuredMs: number; frames: number; fps: number; xRealtime: number; endedAtEof: boolean; hwLane?: string | null }
  | { kind: "seek"; perCategory: Record<SeekCategory, CategoryStats>; hwLane?: string | null }
  | { kind: "coldstart"; firstMs: number; restP50: number; restMax: number; iterationsMs: number[]; hwLane?: string | null }
  | { kind: "error"; error: string };

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
  /// The read-completion barrier this session actually RAN (`HwBarrierMode`, or
  /// `'mixed'`), null off the hardware lane. Reported because a barcode check
  /// passes under EVERY correct barrier: a run whose configured variant silently
  /// fell back to another one is green and proves nothing about the variant it
  /// was launched for. The caller compares this against what it pinned.
  barrierApplied?: string | null;
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
            engine: "ffmpeg" as const,
            forceLane: "hardware" as const,
            sourcePath,
            componentAvailable: true,
            width,
            height,
            ...(args.poolSize !== undefined ? { poolSize: args.poolSize } : {}),
          }
        : strategy === "sw"
        ? { engine: "ffmpeg" as const, forceLane: "software" as const, sourcePath, componentAvailable: true }
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
      const ringFrame = h.ring.frameAt(pts);
      if (!ringFrame || !h.ring.containsPts(pts)) {
        missing++;
        continue;
      }
      if (isNativeNv12Frame(ringFrame)) {
        // SW-lane rings carry CPU planes. drawImage needs a CanvasImageSource,
        // so wrap them in a scratch VideoFrame — bench-only and safe here:
        // Chromium's buffer-frame conversion mis-picks BT.601 (nv12Frame.ts),
        // but the barcode is black/white, unambiguous under either matrix.
        const vf = new VideoFrame(ringFrame.data as BufferSource, {
          format: "NV12",
          codedWidth: ringFrame.width,
          codedHeight: ringFrame.height,
          timestamp: ringFrame.timestamp,
        });
        try {
          ctx.drawImage(vf, 0, 0);
        } finally {
          vf.close();
        }
      } else {
        ctx.drawImage(ringFrame, 0, 0);
      }
      const decodedIdx = decodeBarcodeIndex(
        ctx.getImageData(0, 0, width, height).data,
        width,
        height,
        bits,
      );
      checked++;
      if (decodedIdx !== i) mismatches.push({ ptsUs: pts, expectedIdx: i, decodedIdx });
    }
    return {
      strategy,
      poolSize,
      checked,
      missing,
      mismatches,
      // `in`, because the pool's return union includes the WebCodecs handle,
      // which has no preload stage and therefore no barrier to report.
      barrierApplied:
        "handoffTimings" in h ? (h.handoffTimings()?.barrierModeObserved ?? null) : null,
    };
  } catch (e) {
    return { strategy, poolSize, checked, missing, mismatches, error: String(e) };
  } finally {
    pool.dispose();
  }
}

// ── Concurrent frame-CONTENT-order check (N hardware sessions at once) ───────
// `decodeBenchOrderCheck` above drives ONE session, and a single session is not
// the case we ship: production runs up to MAX_HW_SESSIONS hardware clips at
// once, and the barrier's safety margin is not a constant across that. The
// synchronous readback barrier measures ~19ms of drain at one session but ~5ms at
// three — the sessions share one flush, so per-session slack COLLAPSES as
// sessions are added, and any barrier whose correctness depends on how deep the
// GPU command queue is when it submits (the deferred-ack fence path especially)
// can pass alone and reorder in company. A reorder that only appears at three
// sessions would clear every other gate in this repo.
//
// Every session is checked independently and reported separately: one merged
// count would let three sessions' worth of passes bury a single session's
// defect, and "which session reordered" is the first question a failure raises.

export interface ConcurrentOrderCheckArgs {
  sourcePath: string; // absolute fixture path; served via weftcut-media://
  /// Concurrent hardware sessions to open. Must be <= the live HW-session cap
  /// (MAX_HW_SESSIONS) or the surplus sessions are budget-rejected — which this
  /// driver reports as an error rather than letting them run on software.
  sessions: number;
  /// Native pool size (slot count) per session. Default 3 (the product default).
  poolSize?: number;
  fpsNum: number;
  fpsDen: number;
  /// Total frames in the clip; each session walks [0, frameCount-1).
  frameCount: number;
  width: number;
  height: number;
  /// Barcode stripe count (12 in the standard fixture).
  bits: number;
}

export interface ConcurrentOrderSessionResult {
  index: number;
  /// The lane this session actually resolved to. Anything but "hardware" means
  /// the run did not test the thing (see `error`).
  lane: string;
  checked: number;
  missing: number;
  mismatches: OrderCheckMismatch[];
  /// True when this session ran out of overall budget before walking the clip.
  /// A capacity finding, NOT a pass: `checked` will be short and the caller must
  /// treat that as a result to report, never as a bar to lower.
  timedOut: boolean;
  /// The barrier this session actually RAN — see `OrderCheckResult`. Per session,
  /// because the fallback is per stream: one session missing its latch while the
  /// others got theirs is exactly the drift this reports.
  barrierApplied?: string | null;
  error?: string;
}

export interface ConcurrentOrderCheckResult {
  poolSize: number | null;
  sessions: ConcurrentOrderSessionResult[];
  /// Set for a whole-run failure (bad session count, pool teardown). A
  /// per-session failure lives on that session instead.
  error?: string;
}

/// Open `sessions` hardware-lane sources on the SAME fixture and verify the
/// barcode↔PTS pairing on every one of them (see the block comment above).
///
/// Opens are sequential, drives are CONCURRENT. Sequential opens are not a
/// concession: main chains every `previewGpu:open` through one promise
/// (`openPreviewGpu`'s `openChain`) precisely so the preload's positional
/// slot-announce FIFO can pair imports safely, so concurrent opens would be
/// serialised there anyway — doing it here just keeps "which session failed to
/// open" unambiguous. The concurrency that matters is the drive: N read loops
/// interleaved on one thread, contending one GPU command queue, which is what
/// builds the queue depth a single-session run never reaches.
export async function decodeBenchConcurrentOrderCheck(
  args: ConcurrentOrderCheckArgs,
): Promise<ConcurrentOrderCheckResult> {
  const { sourcePath, fpsNum, fpsDen, frameCount, width, height, bits } = args;
  const poolSize = args.poolSize ?? null;
  const pool = new SourceDecoderPool();
  const results: ConcurrentOrderSessionResult[] = [];
  const PER_FRAME_BUDGET_MS = 5_000;
  // Deliberately the single-session budget, NOT a scaled-up one. If N sessions
  // cannot walk the clip in the time one session needs, that is the capacity
  // answer the run exists to produce; stretching the budget would hide it.
  const OVERALL_BUDGET_MS = 90_000;
  try {
    if (args.sessions < 1) throw new Error(`sessions must be >= 1, got ${args.sessions}`);
    // Refuse a run that cannot put every session on hardware. Over the cap the
    // surplus opens trip `hw-budget-exceeded`, and with the lane forced that is
    // a hard fatal — but saying so up front names the cause instead of leaving
    // it to be inferred from N identical open failures.
    const budget = await getPreviewGpuBudget();
    const availableSessions = budget.sessions.max - budget.sessions.used;
    const fixtureArea = width * height;
    const availableByArea = Number.isSafeInteger(fixtureArea) && fixtureArea > 0
      ? Math.floor(
        (budget.codedPixelArea.max - budget.codedPixelArea.used) / fixtureArea,
      )
      : 0;
    const available = Math.min(availableSessions, availableByArea);
    if (args.sessions > available) {
      throw new Error(
        `sessions=${args.sessions} exceeds the live preview-GPU budget for ${width}x${height} (available=${available}, session slots=${availableSessions}, coded-area fits=${availableByArea}); the surplus cannot be on hardware`,
      );
    }

    const url = convertFileSrc(sourcePath);
    const handles: FfmpegSource[] = [];
    for (let i = 0; i < args.sessions; i++) {
      const h = pool.acquire({
        layerId: `concurrent-order-${i}`,
        mediaId: `concurrent-order:${i}:${sourcePath}`,
        proxyAssetUrl: url,
        engine: "ffmpeg" as const,
        forceLane: "hardware" as const,
        sourcePath,
        componentAvailable: true,
        width,
        height,
        ...(args.poolSize !== undefined ? { poolSize: args.poolSize } : {}),
      }) as FfmpegSource;
      handles.push(h);
      results.push({ index: i, lane: "unopened", checked: 0, missing: 0, mismatches: [], timedOut: false });
      try {
        // eslint-disable-next-line no-await-in-loop
        await h.ensureReady();
        results[i]!.lane = h.currentLane();
      } catch (e) {
        results[i]!.error = String(e);
        results[i]!.lane = h.currentLane();
      }
    }

    const frameDurUs = (1_000_000 * fpsDen) / fpsNum;
    const ptsOf = (n: number) => Math.round(n * frameDurUs);
    const t0 = performance.now();

    /// One session's read loop — the single-session discipline verbatim: nudge
    /// the anchor forward so the pump never idles between slot fills (keeping
    /// the read/ack race live), then read each frame's barcode before the
    /// lookbehind evicts it. The `await sleep(1)` is what lets the N loops
    /// interleave; with several running, each session's real nudge cadence is
    /// set by the contention itself.
    const driveOne = async (i: number): Promise<void> => {
      const out = results[i]!;
      const h = handles[i]!;
      // A session that never opened on hardware has nothing to verify, and
      // driving it would report a SOFTWARE lane's ordering under a hardware
      // label — the same refusal `copybackFallbackError` makes for benchmarks.
      if (out.error) return;
      if (out.lane !== "hardware") {
        out.error = `session ${i} resolved to lane "${out.lane}", not hardware — this run did not test the hardware path`;
        return;
      }
      // Per-session canvas: `drawImage` + `getImageData` are synchronous so a
      // shared one would not corrupt, but a private one keeps each session's
      // read independent of the others' interleaving by construction.
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        out.error = `session ${i}: no 2d context`;
        return;
      }
      void h.requestFrameAt(0);
      for (let n = 0; n < frameCount - 1; n++) {
        if (performance.now() - t0 > OVERALL_BUDGET_MS) {
          out.timedOut = true;
          break;
        }
        const pts = ptsOf(n);
        h.ring.setAnchor(pts);
        const wStart = performance.now();
        while (!h.ring.containsPts(pts)) {
          void h.requestFrameAt(pts);
          if (performance.now() - wStart > PER_FRAME_BUDGET_MS) break;
          // eslint-disable-next-line no-await-in-loop
          await sleep(1);
        }
        const ringFrame = h.ring.frameAt(pts);
        if (!ringFrame || !h.ring.containsPts(pts)) {
          out.missing++;
          continue;
        }
        if (isNativeNv12Frame(ringFrame)) {
          // Only reachable if a session silently landed on the CPU-plane lane;
          // the guard above should have stopped that. Handled the same way the
          // single-session check does rather than throwing.
          const vf = new VideoFrame(ringFrame.data as BufferSource, {
            format: "NV12",
            codedWidth: ringFrame.width,
            codedHeight: ringFrame.height,
            timestamp: ringFrame.timestamp,
          });
          try {
            ctx.drawImage(vf, 0, 0);
          } finally {
            vf.close();
          }
        } else {
          ctx.drawImage(ringFrame, 0, 0);
        }
        const decodedIdx = decodeBarcodeIndex(
          ctx.getImageData(0, 0, width, height).data,
          width,
          height,
          bits,
        );
        out.checked++;
        if (decodedIdx !== n) out.mismatches.push({ ptsUs: pts, expectedIdx: n, decodedIdx });
      }
      out.barrierApplied = h.handoffTimings?.()?.barrierModeObserved ?? null;
    };

    // The whole point: all N read loops in flight at once. `allSettled` so one
    // session throwing still yields the others' verdicts — a partial answer
    // localises the defect, a rejected Promise.all loses it.
    const settled = await Promise.allSettled(results.map((_, i) => driveOne(i)));
    settled.forEach((s, i) => {
      if (s.status === "rejected" && !results[i]!.error) results[i]!.error = String(s.reason);
    });
    return { poolSize, sessions: results };
  } catch (e) {
    return { poolSize, sessions: results, error: String(e) };
  } finally {
    pool.dispose();
  }
}

// ── HW session-budget probe (smoke item b) ───────────────────────────────────
// The main process caps concurrent native-hw sessions at MAX_HW_SESSIONS (3);
// the (MAX+1)th `previewGpuOpen` throws `hw-budget-exceeded`. This exercises
// the untested RUNTIME seam: that opening MAX+1 real sessions actually
// rejects at the cap and the rejection reaches this probe with the budget
// reason. Because the lane is forced to "hardware", `FfmpegSource._doEnsureReady`'s
// catch calls `fireFatal` on any open failure, so `onFatalError` fires and
// `fatalReason` is populated (e.g. `"hw-budget-exceeded"`). The e2e assertion
// confirms both `fatalReason` and `error` carry the budget signal.

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
  width: number;
  height: number;
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
        engine: "ffmpeg",
        forceLane: "hardware",
        sourcePath: args.sourcePath,
        componentAvailable: true,
        width: args.width,
        height: args.height,
      }) as FfmpegSource;
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

// ── HW→SW in-place fallback probe (REAL budget-rejection trigger) ──
// `decodeBenchBudgetProbe` above force-pins every session's lane
// (`forceLane: 'hardware'`) so it can assert the FORCED-lane hard-fatal path
// the bench harness itself relies on for deterministic hardware-only
// measurement — but `FfmpegSource._doEnsureReady`'s catch only engages its
// in-place HW→SW recovery when `!forceLane` (see FfmpegSource.ts). This
// driver leaves the lane UNFORCED: `pickInitialLane`'s real GPU capability
// probe decides "hardware" for an HW-eligible clip exactly as production
// does. Opening MAX_HW_SESSIONS+1 such sources means the LAST one's HW
// `previewGpuOpen` genuinely trips `hw-budget-exceeded` — and because nothing
// forced its lane, the SAME in-place recovery a runtime GPU error uses
// engages: the ring survives, `ensureReady()` resolves normally (not a
// fatal), and `currentLane()` reads "software" afterward. A real trigger, not
// an injected error seam.

export interface HwFallbackProbeArgs {
  sourcePath: string; // absolute fixture path; served via weftcut-media://
  /// HW-eligible codec (h264/hevc/vp9, 8-bit) so `pickInitialLane`'s probe
  /// actually picks "hardware" for the first MAX_HW_SESSIONS sources.
  codec: string;
  pixFmt: string;
  width: number;
  height: number;
  count: number; // MAX_HW_SESSIONS + 1
}

export interface HwFallbackSessionOutcome {
  index: number;
  ready: boolean;
  lane: FfmpegLane;
  error: string | null;
}

export interface HwFallbackProbeResult {
  sessions: HwFallbackSessionOutcome[];
  /// The last (budget-rejected) session's ring.pushCount before/after a
  /// further nudge — proves the in-place SW recovery keeps delivering real
  /// frames, not just that `ensureReady()` resolved.
  lastRingPushCountBefore: number;
  lastRingPushCountAfter: number;
  error?: string;
}

export async function decodeBenchHwFallbackProbe(args: HwFallbackProbeArgs): Promise<HwFallbackProbeResult> {
  const pool = new SourceDecoderPool();
  const url = convertFileSrc(args.sourcePath);
  const sessions: HwFallbackSessionOutcome[] = [];
  const handles: FfmpegSource[] = [];
  try {
    // Open sequentially WITHOUT disposing, so live session count climbs to
    // the cap and the last open trips it — mirrors decodeBenchBudgetProbe,
    // but with the lane left for pickInitialLane's real probe to decide.
    for (let i = 0; i < args.count; i++) {
      const h = pool.acquire({
        layerId: `hwfallback-${i}`,
        mediaId: `hwfallback:${i}:${args.sourcePath}`,
        proxyAssetUrl: url,
        engine: "ffmpeg",
        sourcePath: args.sourcePath,
        componentAvailable: true,
        codec: args.codec,
        pixFmt: args.pixFmt,
        width: args.width,
        height: args.height,
        // No forceLane — pickInitialLane's real HW probe decides the lane.
      }) as FfmpegSource;
      handles.push(h);
      let ready = false;
      let error: string | null = null;
      try {
        await h.ensureReady();
        ready = true;
      } catch (e) {
        error = String(e);
      }
      sessions.push({ index: i, ready, lane: h.currentLane(), error });
    }
    // Prove the last (recovered) session still delivers real frames on its
    // new software transport: nudge it and poll the ring for growth.
    const last = handles[handles.length - 1]!;
    const before = last.ring.pushCount;
    const t0 = performance.now();
    while (last.ring.pushCount === before && performance.now() - t0 < 15_000) {
      void last.requestFrameAt(0);
      // eslint-disable-next-line no-await-in-loop
      await sleep(50);
    }
    return { sessions, lastRingPushCountBefore: before, lastRingPushCountAfter: last.ring.pushCount };
  } catch (e) {
    return { sessions, lastRingPushCountBefore: 0, lastRingPushCountAfter: 0, error: String(e) };
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

/// Read the resolved HW lane name off a bench handle (null for WebCodecs handles
/// / the software lane / a forced-lane run). Duck-typed: only `FfmpegSource`
/// exposes `currentHwLane`.
function readHwLane(h: BenchHandle): string | null {
  return (h as { currentHwLane?: () => string | null }).currentHwLane?.() ?? null;
}

/// `native-copyback` must be on a genuine hardware lane; a software fallback
/// (HW lane unavailable / the env pin found no candidate) is an INVALID HW
/// measurement, not a slower one — return an error so it can never be reported
/// as a HW number. Null for every other strategy (no guard).
function copybackFallbackError(h: BenchHandle, strategy: BenchStrategy): BenchResult | null {
  if (strategy !== "native-copyback") return null;
  const lane = (h as { currentLane?: () => string }).currentLane?.();
  if (lane !== "hardware") {
    return {
      kind: "error",
      error: "native-copyback: resolved to software (HW lane unavailable/unforced) — invalid HW measurement",
    };
  }
  return null;
}

async function runThroughput(
  h: BenchHandle,
  durationUs: number,
  token: CancelToken,
  throttleMs = 10,
  strategy: BenchStrategy = "webcodecs",
): Promise<BenchResult> {
  phase = "warmup";
  await h.ensureReady();
  const fallback = copybackFallbackError(h, strategy);
  if (fallback) return fallback;
  const hwLane = readHwLane(h);
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
  return {
    kind: "throughput",
    measuredMs,
    frames,
    fps: frames / (measuredMs / 1000),
    xRealtime: contentUs / 1000 / measuredMs,
    endedAtEof,
    hwLane,
  };
}

async function runSeek(
  h: BenchHandle,
  durationUs: number,
  token: CancelToken,
  strategy: BenchStrategy = "webcodecs",
): Promise<BenchResult> {
  phase = "warmup";
  await h.ensureReady();
  const fallback = copybackFallbackError(h, strategy);
  if (fallback) return fallback;
  const hwLane = readHwLane(h);
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
  return { kind: "seek", perCategory, hwLane };
}

async function runColdstart(
  pool: SourceDecoderPool,
  mkInit: (layerId: string) => Parameters<SourceDecoderPool["acquire"]>[0],
  token: CancelToken,
  strategy: BenchStrategy = "webcodecs",
): Promise<BenchResult> {
  phase = "measuring";
  const iterationsMs: number[] = [];
  let hwLane: string | null = null;
  for (let i = 0; i < COLD_ITERATIONS; i++) {
    // Checked BEFORE acquire so a cancelled run never re-acquires on a pool
    // the caller is about to dispose.
    if (token.cancelled) throw new Error("bench run cancelled");
    const layerId = `bench-cold-${i}`;
    const h = pool.acquire(mkInit(layerId));
    const t0 = performance.now();
    await h.ensureReady();
    // Guard + lane-record on the FIRST iteration (each iteration reopens the same
    // source, so the resolved lane is identical): reject a copy-back SW fallback
    // before spending 10 cold opens on an invalid HW measurement.
    if (i === 0) {
      const fallback = copybackFallbackError(h, strategy);
      if (fallback) { pool.release(layerId); return fallback; }
      hwLane = readHwLane(h);
    }
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
    hwLane,
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
      // Unused by the ffmpeg engine (it decodes `sourcePath` directly) but
      // still passed — `proxyAssetUrl` is required by `SourceHandleInit`.
      proxyAssetUrl: url,
      ...(args.strategy === "native"
        ? {
            engine: "ffmpeg" as const,
            forceLane: "hardware" as const,
            sourcePath: args.sourcePath,
            componentAvailable: true,
            ...(args.width != null ? { width: args.width } : {}),
            ...(args.height != null ? { height: args.height } : {}),
            // Conditional spread, not `poolSize: args.poolSize` — exactOptionalPropertyTypes
            // rejects assigning `number | undefined` to the optional `poolSize: number` field.
            ...(args.poolSize !== undefined ? { poolSize: args.poolSize } : {}),
          }
        : args.strategy === "native-copyback"
        ? {
            // NO forceLane — `pickInitialLane`'s real HW probe resolves the lane
            // (WEFTCUT_FORCE_HW_LANE, set by the orchestrator, pins WHICH one).
            // Feed it the codec/pixFmt/dimensions so the probe's classKey matches
            // main's; the resolved HW lane then rides the SwTransport (copy-back).
            engine: "ffmpeg" as const,
            sourcePath: args.sourcePath,
            componentAvailable: true,
            // Conditional spreads keep exactOptionalPropertyTypes happy (no
            // explicit `undefined`/`null` assigned to the optional fields).
            ...(args.codec != null ? { codec: args.codec } : {}),
            ...(args.pixFmt != null ? { pixFmt: args.pixFmt } : {}),
            ...(args.width != null ? { width: args.width } : {}),
            ...(args.height != null ? { height: args.height } : {}),
          }
        : args.strategy === "sw"
        ? {
            engine: "ffmpeg" as const,
            forceLane: "software" as const,
            sourcePath: args.sourcePath,
            componentAvailable: true,
          }
        : {}),
    });
    scenarioP = (async (): Promise<BenchResult> => {
      switch (args.scenario) {
        case "throughput":
          return runThroughput(livePool.acquire(mkInit("bench-0")), args.durationUs, token, args.throttleMs, args.strategy);
        case "seek":
          return runSeek(livePool.acquire(mkInit("bench-0")), args.durationUs, token, args.strategy);
        case "coldstart":
          return runColdstart(livePool, mkInit, token, args.strategy);
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
