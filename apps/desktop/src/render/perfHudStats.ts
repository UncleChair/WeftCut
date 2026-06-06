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
/// Returns 0 for the first sample (no prior to diff against), for a
/// non-positive time delta (the clock didn't advance), on a stall (no
/// new frames — reads as 0 rather than a stale rate), and when the
/// counter went backwards (a decoder rebuild reset it). The stall case
/// is the whole point: a decoder wedged at 60 fps must read 0, not its
/// last healthy rate.
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
