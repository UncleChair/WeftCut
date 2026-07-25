// The export worker's entry point to the composition frame grid. Both functions
// delegate to the `weftcut-eval` leaf (`renderer/frames.ts`), so the export grid
// is LITERALLY the same code the actor, the ruler, and preview resolve — not a
// worker-local reimplementation. Kept as a module because the worker imports it
// under its own name and the export-side naming (`exportFrameCount`) reads
// differently from the grid-side one.
//
// THE TRAP this module exists to prevent: computing an output frame's time as
// `i * round(1e6 / fps)` (or a count as `ceil(span / round(1e6/fps))`) compounds
// the rounding floor. At 30 fps `round(1e6/30) = 33333`, but the true frame
// duration is 33333.33…, so `i * 33333` falls a fractional µs behind the grid and
// the deficit grows with i. Once it crosses a frame boundary the export's
// `frameAt(requestTime)` returns the PREVIOUS source frame, duplicating an output
// frame and misaligning the rest (observed: 301 frames for a 300-frame clip,
// output[N] = source[N-1]).

import { frameCount, timeUsAtFrame } from "../../frames";

/// Presentation time (µs) of output frame `i`, offset from the range start.
export function frameTimeUs(
  startUs: number,
  i: number,
  fpsNum: number,
  fpsDen: number,
): number {
  return startUs + timeUsAtFrame(i, fpsNum, fpsDen);
}

/// Number of output frames in `[startUs, endUs)` — the count of `i` with
/// `frameTimeUs(i) < endUs`. Derived from the SAME predicate as `frameTimeUs`,
/// so the count and the grid can never disagree at the tail.
export function exportFrameCount(
  startUs: number,
  endUs: number,
  fpsNum: number,
  fpsDen: number,
): number {
  return frameCount(startUs, endUs, fpsNum, fpsDen);
}
