// Per-frame stage accounting for the PREVIEW playback loop — the breakdown
// `compositeMsLast` structurally cannot give.
//
// Why it exists: the Compositor stamps one number around `compositeFrame`, so
// three real per-frame costs are invisible to it — `setAnchorTime` (ring
// eviction + `requestFrameAt` fan-out) and the Pixi `app.render()` present both
// happen OUTSIDE that bracket, and everything inside it is one opaque total.
// When preview judders, "composite was 9 ms" does not say whether the cost was
// the NV12 ingest pass, the snapshot blit, the audio sweep, or the present.
// This module is the accountant: each stage adds its own ms, and a snapshot
// reports per-stage percentiles that sum to the frame.
//
// Sub-stages that run once PER LAYER (ring lookup, upload, ingest, effects)
// accumulate into a per-frame scratch and land as ONE per-frame total. That is
// the number a time-share table needs — a per-call percentile would hide that
// eight tracks pay the cost eight times.
//
// LANDMINE: disabled by default. Production must not pay for this, so every
// entry point returns on a monomorphic boolean check and `stageNow()` hands
// back 0 rather than calling `performance.now()`. Enable it from the bench hook
// (`setStageProfiling`), never at module scope.
//
// Allocation-free while recording: fixed `Float64Array` rings, sorted only when
// a snapshot is asked for. Mirrors `decoder/transports/handoffTimings.ts`.

/// Stage ids. Numeric so a call site indexes an array instead of hashing a
/// string. Keep in sync with `STAGE_NAMES`.
export const STAGE = {
  /// Whole `PlaybackEngine.tick` body.
  TickTotal: 0,
  /// Wall gap between successive tick starts — the judder signal at the source.
  TickInterval: 1,
  /// `clock.tick()`.
  ClockTick: 2,
  /// `Compositor.setAnchorTime`: ring eviction + `requestFrameAt` fan-out +
  /// upcoming-clip prewarm. Outside `compositeMsLast`.
  Anchor: 3,
  /// Whole `Compositor.compositeFrame` body (the existing `compositeMsLast`).
  Composite: 4,
  /// The audio pass: full track×layer walk + `mixer.tick`.
  Audio: 5,
  /// `stage.removeChildren()` — the per-frame display-list teardown.
  SceneRebuild: 6,
  /// The per-layer visual sweep (brackets stages 8..13).
  LayerSweep: 7,
  /// `FrameRing.selectFrame` binary search, summed over layers.
  RingLookup: 8,
  /// `VideoClipSprite.updateFrame` — the ImageBitmap snapshot path, summed.
  BitmapUpload: 9,
  /// The `drawImage` blit inside `bindFromSnapshot`, summed. Subset of 9.
  BlitDrawImage: 10,
  /// `Nv12Ingest.textureFor` — plane uploads + the YUV→RGB RT pass, summed.
  Nv12Ingest: 11,
  /// `TenBitIngest.textureFor`, summed.
  TenBitIngest: 12,
  /// `effectsFor` → `EffectChain.sync`, summed.
  Effects: 13,
  /// `TransitionNodes.finishFrame` — composition-sized RT bakes.
  Transitions: 14,
  /// Pixi `app.render()` — the present. Outside `compositeMsLast`.
  Present: 15,
  /// Gap between the rAF frame timestamps Pixi was handed — the cadence the
  /// browser DELIVERED, as opposed to `TickInterval`, which is wall time on this
  /// thread. A gap that shows up here was never offered to us.
  RafInterval: 16,
  /// Wall ms from this frame's rAF timestamp to the tick body starting. The
  /// discriminator for a `TickInterval` gap no stage explains: large here means
  /// the callback was delivered and ran LATE (something else held the thread),
  /// large in `RafInterval` with this small means the frame never came at all.
  /// Those point at different subsystems.
  RafLag: 17,
} as const;

export type StageId = (typeof STAGE)[keyof typeof STAGE];

export const STAGE_NAMES: readonly string[] = [
  "tickTotal",
  "tickInterval",
  "clockTick",
  "anchor",
  "composite",
  "audio",
  "sceneRebuild",
  "layerSweep",
  "ringLookup",
  "bitmapUpload",
  "blitDrawImage",
  "nv12Ingest",
  "tenBitIngest",
  "effects",
  "transitions",
  "present",
  "rafInterval",
  "rafLag",
];

const N_STAGES = STAGE_NAMES.length;
/// 2048 frames ≈ 34 s at 60 Hz — one measurement window without wrapping.
const CAPACITY = 2048;

export interface StageStat {
  /// Frames in which this stage fired at all.
  frames: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  /// Total ms attributed to this stage across the window — what a time-SHARE
  /// column divides, so a rare-but-huge stage can't masquerade as dominant.
  totalMs: number;
  /// Mean calls per firing frame. >1 means the stage is per-layer.
  callsPerFrame: number;
}

export interface StageSnapshot {
  /// Frames observed (ticks that called `stageFrameEnd`).
  frames: number;
  /// Wall ms from the first to the last observed frame.
  spanMs: number;
  byStage: Record<string, StageStat>;
}

let enabled = false;

/// Ring per stage, flattened: stage `s` owns `[s*CAPACITY, (s+1)*CAPACITY)`.
const rings = new Float64Array(N_STAGES * CAPACITY);
/// Per-stage samples written (may exceed CAPACITY; the ring keeps the newest).
const written = new Int32Array(N_STAGES);
/// Accumulated ms for the frame in flight.
const scratch = new Float64Array(N_STAGES);
/// Calls into each stage for the frame in flight.
const scratchCalls = new Int32Array(N_STAGES);
/// Calls summed across all frames, for `callsPerFrame`.
const totalCalls = new Float64Array(N_STAGES);
/// Ms summed across all frames — kept separately so `totalMs` survives ring
/// wrap (percentiles reflect the last CAPACITY frames; totals reflect all).
const totalMs = new Float64Array(N_STAGES);

let frames = 0;
let firstFrameAt = 0;
let lastFrameAt = 0;
let lastTickStart = 0;
let lastRafFrameTime = 0;

/// Turn recording on/off and clear the window. Bench/HUD only.
export function setStageProfiling(on: boolean): void {
  enabled = on;
  resetStageTimers();
}

export function stageProfilingEnabled(): boolean {
  return enabled;
}

export function resetStageTimers(): void {
  rings.fill(0);
  written.fill(0);
  scratch.fill(0);
  scratchCalls.fill(0);
  totalCalls.fill(0);
  totalMs.fill(0);
  frames = 0;
  firstFrameAt = 0;
  lastFrameAt = 0;
  lastTickStart = 0;
  lastRafFrameTime = 0;
}

/// Timestamp for a stage bracket — 0 (and no clock read) while disabled.
export function stageNow(): number {
  return enabled ? performance.now() : 0;
}

/// Close a bracket opened with `stageNow()`. A `t0` of 0 means profiling was
/// off when the bracket opened, so the sample is dropped rather than recorded
/// as a full-uptime duration.
export function stageAdd(id: StageId, t0: number): void {
  if (!enabled || t0 === 0) return;
  scratch[id] = scratch[id]! + (performance.now() - t0);
  scratchCalls[id] = scratchCalls[id]! + 1;
}

/// Record a ms value directly (for deltas that aren't a bracket, e.g. the tick
/// interval).
export function stageRecord(id: StageId, ms: number): void {
  if (!enabled) return;
  scratch[id] = scratch[id]! + ms;
  scratchCalls[id] = scratchCalls[id]! + 1;
}

/// Open a frame. Stamps `TickInterval` from the previous frame's start, so the
/// cadence is measured tick-start to tick-start and can't be skewed by however
/// long the body took.
///
/// `rafFrameTimeMs` is the rAF timestamp the browser handed this frame (0 when
/// the caller has none — a manually driven ticker in a unit test). It splits
/// `TickInterval` into the part the browser chose (`RafInterval`) and the part
/// this thread added on top (`RafLag`): a stall is in exactly one of them, and
/// each names a different subsystem.
export function stageFrameBegin(rafFrameTimeMs = 0): number {
  if (!enabled) return 0;
  const now = performance.now();
  if (lastTickStart !== 0) stageRecord(STAGE.TickInterval, now - lastTickStart);
  if (rafFrameTimeMs > 0) {
    stageRecord(STAGE.RafLag, now - rafFrameTimeMs);
    if (lastRafFrameTime !== 0) {
      stageRecord(STAGE.RafInterval, rafFrameTimeMs - lastRafFrameTime);
    }
    lastRafFrameTime = rafFrameTimeMs;
  }
  lastTickStart = now;
  return now;
}

/// Close a frame: flush scratch into the rings. Stages that didn't fire this
/// frame record NOTHING — a stage that is inactive (no transitions on screen)
/// must not dilute its own percentiles with zeros.
export function stageFrameEnd(): void {
  if (!enabled) return;
  const now = performance.now();
  for (let s = 0; s < N_STAGES; s += 1) {
    if (scratchCalls[s] === 0) continue;
    const ms = scratch[s]!;
    rings[s * CAPACITY + (written[s]! % CAPACITY)] = ms;
    written[s] = written[s]! + 1;
    totalCalls[s] = totalCalls[s]! + scratchCalls[s]!;
    totalMs[s] = totalMs[s]! + ms;
    scratch[s] = 0;
    scratchCalls[s] = 0;
  }
  if (frames === 0) firstFrameAt = now;
  lastFrameAt = now;
  frames += 1;
}

/// Nearest-rank percentile over an ascending array. `q` in [0,1].
function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i] ?? 0;
}

/// Snapshot the window. Sorts once per stage; call at most a few times per
/// second.
export function stageSnapshot(): StageSnapshot {
  const byStage: Record<string, StageStat> = {};
  for (let s = 0; s < N_STAGES; s += 1) {
    const n = Math.min(written[s]!, CAPACITY);
    const name = STAGE_NAMES[s]!;
    if (n === 0) {
      byStage[name] = {
        frames: 0,
        meanMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        maxMs: 0,
        totalMs: 0,
        callsPerFrame: 0,
      };
      continue;
    }
    const base = s * CAPACITY;
    const vals: number[] = new Array(n);
    for (let i = 0; i < n; i += 1) vals[i] = rings[base + i]!;
    vals.sort((a, b) => a - b);
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += vals[i]!;
    byStage[name] = {
      frames: written[s]!,
      meanMs: sum / n,
      p50Ms: pct(vals, 0.5),
      p95Ms: pct(vals, 0.95),
      p99Ms: pct(vals, 0.99),
      maxMs: vals[n - 1]!,
      totalMs: totalMs[s]!,
      callsPerFrame: totalCalls[s]! / written[s]!,
    };
  }
  return {
    frames,
    spanMs: frames > 0 ? lastFrameAt - firstFrameAt : 0,
    byStage,
  };
}
