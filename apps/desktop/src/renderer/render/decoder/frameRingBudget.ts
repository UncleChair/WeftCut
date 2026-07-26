// A GPU-byte budget shared across every live preview `FrameRing`.
//
// Why it exists: the ring's retention policy is a TIME window (1 s lookahead +
// 0.5 s lookbehind), which spends wildly different amounts of GPU memory
// depending on frame size — the `ImageBitmap`s it holds are ~8 MB at 1080p and
// ~33 MB at 4K. Measured (docs/playback-perf.md), one 4K clip pins ~1.9 GB and
// two ask for ~4 GB, at which point the decoders stop producing usable frames
// entirely: three of four rings read EMPTY at 1080p×4 while all four decoders
// reported full-rate delivery. The tick stayed clean through all of it, so the
// wall is retained bytes, not compositing.
//
// The budget is shared rather than per-ring so one clip may use the whole thing
// and N clips divide it — a fixed per-ring cap would needlessly shrink the
// single-clip case, which is the one that measures well today.
//
// LANDMINE: this is a TARGET, not a hard cap. `FrameRing`'s frame floors
// deliberately override it (see MIN_LOOKAHEAD_FRAMES there) — a ring starved
// below a few frames would thrash and would break the warm-up gate, which is
// worse than overshooting the byte target. Two 4K clips therefore settle above
// this total, just bounded instead of unbounded.
//
// Preview only: export retains frames in `ExportFrameStore`, not here.

/// Total retained decoded-frame bytes across all live rings.
///
/// This is a **safety ceiling for the pathological case, not a tuning knob** —
/// and that framing is a measured correction, not caution. A first attempt set
/// it to 512 MiB, which clamps hard at 1080p too. Memory did fall as designed
/// (4K one clip 1.84 → 0.76 GB, two clips 3.96 → 1.71 GB), but every outcome got
/// WORSE: 1080p three clips went from 7.2 % drops to 55.5 % and its tick p99
/// from 18.9 to 53.3 ms, while **decode throughput ROSE 40 %** (32 → 45 fps per
/// clip). A shallower ring means frames are evicted and immediately
/// re-requested, and on the bench's 240-frame (8 s) GOP a single re-seek
/// re-decodes the whole GOP prefix. Clamping bytes without flow control buys
/// memory and pays for it in churn. (The software lane has that flow control now
/// — its native pump continues forward instead of re-seeking, and `FfmpegSource`
/// honours `isLookaheadFull` — so this ceiling could be re-tuned against a
/// re-measured churn cost. The WebCodecs lane's re-seek cost is unchanged.)
///
/// So: sized to leave the cases that measure well ALONE and only bound the
/// multi-gigabyte ones, at 30 fps (1080p frame = 8.29 MB, 4K = 33.2 MB):
///
/// | live rings | 1080p frames each | 4K frames each |
/// |---|---|---|
/// | 1 | 129 (uncapped — window is 45) | 32 |
/// | 2 | 64 (uncapped — measured 62) | 16 |
/// | 3 | 43 (measured 50 — mild) | 10 (floored) |
///
/// 1080p at one and two clips is therefore untouched, and the 4K blow-up that
/// asked for ~4 GB is bounded to ~1 GB.
///
/// Deliberately not derived from real VRAM: `app.getGPUInfo()` lives in main and
/// reports the adapter, not the budget Chromium will actually grant a tab, so
/// plumbing it would add a cross-process dependency for a number that still
/// needs the bench to validate. Re-tune from `npm run bench:playback` — and
/// re-read the churn note above before tightening it.
const TOTAL_RETAINED_BYTES = 1024 * 1024 * 1024;

let liveRings = 0;

/// Called from the `FrameRing` constructor.
export function registerFrameRing(): void {
  liveRings += 1;
}

/// Called from `FrameRing.dispose()`, which is idempotent — a double dispose
/// must not inflate the divisor, because every OTHER ring would silently get a
/// smaller share. Clamped at zero so an unbalanced call can't go negative and
/// hand out an absurd budget.
export function unregisterFrameRing(): void {
  liveRings = Math.max(0, liveRings - 1);
}

/// This ring's share of the total, in bytes.
export function frameRingByteBudget(): number {
  return TOTAL_RETAINED_BYTES / Math.max(1, liveRings);
}

/// Diagnostics + tests: how many rings are dividing the budget.
export function liveFrameRingCount(): number {
  return liveRings;
}

/// Unit tests only — module state outlives a test otherwise.
export function resetFrameRingBudgetForTest(): void {
  liveRings = 0;
}
