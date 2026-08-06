// Pure perf-math helpers for the dev `PerfHUD`. Kept out of the
// component (`PerfHUD.tsx`) so the logic is unit-testable under
// vitest's node environment, which has no DOM to render React into.

/// A reading of a monotonically-increasing decoded-frame counter at a
/// point in time. The HUD keeps the previous tick's sample per clip and
/// diffs against the current one to derive a live decode rate.
export interface ThroughputSample {
  count: number;
  atMs: number;
}

/// Frames-per-second derived from the change in a cumulative
/// decoded-frame counter between two samples. Mirrors how the HUD
/// already turns rAF timestamps into intervals — a delta over a window
/// rather than a value the producer has to maintain.
///
/// Returns 0 whenever a rate can't be derived — notably on a stall, so a
/// decoder wedged at 60 fps reads 0 rather than its last healthy rate.
export function throughputFps(
  prev: ThroughputSample | undefined,
  cur: ThroughputSample,
): number {
  if (!prev) return 0;
  const dtMs = cur.atMs - prev.atMs;
  if (dtMs <= 0) return 0;
  const dFrames = cur.count - prev.count;
  if (dFrames <= 0) return 0;
  return (dFrames * 1000) / dtMs;
}
