// Pure output-frame-grid math for the export worker. Extracted so the
// rational-fps grid is unit-testable in isolation — a floored per-frame
// duration silently drifts off it (the bug this module exists to prevent).
//
// THE TRAP: computing an output frame's time as `i * round(1e6 / fps)` (or a
// count as `ceil(span / round(1e6/fps))`) compounds the rounding floor. At
// 30 fps `round(1e6/30) = 33333`, but the true frame duration is 33333.33…, so
// `i * 33333` falls a fractional µs behind the source's PTS grid
// (`round(i * 1e6 / fps)`) and the deficit grows with i. Once it crosses a
// frame boundary the export's `frameAt(requestTime)` returns the PREVIOUS
// source frame, duplicating an output frame and misaligning the rest (observed:
// 301 frames for a 300-frame clip, output[N] = source[N-1]). Always derive both
// the per-frame time AND the frame count from the exact rational below.

/// Presentation time (µs) of output frame `i`, rounded from the EXACT rational
/// fps so the grid matches the source's PTS grid (`round(i * 1e6 / fps)`).
export function frameTimeUs(
  startUs: number,
  i: number,
  fpsNum: number,
  fpsDen: number,
): number {
  return startUs + Math.round((i * 1_000_000 * fpsDen) / fpsNum);
}

/// Number of output frames in `[startUs, endUs)` — the count of `i` with
/// `frameTimeUs(i) < endUs`. Derived from the SAME predicate as `frameTimeUs`,
/// so the count and the grid can never disagree at the tail. A `round`- or
/// `ceil`-based count instead has boundary off-by-ones for non-frame-aligned
/// trim/partial ranges (`ceil(span / 33333)` over-counts the full composition;
/// `round` can drop or add one trailing frame on an arbitrary `endUs`). A floor
/// estimate seeds the search; it is then corrected to the exact predicate
/// boundary (at most a step or two either way).
export function exportFrameCount(
  startUs: number,
  endUs: number,
  fpsNum: number,
  fpsDen: number,
): number {
  const span = Math.max(0, endUs - startUs);
  let n = Math.floor((span * fpsNum) / (1_000_000 * fpsDen));
  while (n > 0 && frameTimeUs(startUs, n - 1, fpsNum, fpsDen) >= endUs) n -= 1;
  while (frameTimeUs(startUs, n, fpsNum, fpsDen) < endUs) n += 1;
  return n;
}
