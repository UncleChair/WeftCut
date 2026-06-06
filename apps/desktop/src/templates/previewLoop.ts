/// Map wall-clock elapsed milliseconds to a looping template time in SECONDS.
/// The preview plays the template's content in real time and repeats: at
/// `elapsedMs == durationMs` the loop wraps back to 0. Pure + unit-tested; the
/// picker's animation loop calls this each frame. Guards a non-positive
/// `durationMs` (→ 0) and negative `elapsedMs` (→ 0).
export function previewLoopTimeSec(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  const e = Math.max(0, elapsedMs);
  return (e % durationMs) / 1000;
}
