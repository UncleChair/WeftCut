// Pure loop frame-selection for animated still images (GIF/WebP/APNG/AVIF).
// The renderer drives frame choice from composition time, NOT from any
// autonomous ticker, so preview and export pick the same frame at the same
// layer-local time. See docs/render.md (animated image looping).

/// Per-frame display duration in µs. Browsers clamp zero/sub-10ms GIF delays
/// up to 100ms (the classic rule) so degenerate files don't play hyper-fast;
/// we match that. A `null`/`undefined` (ImageDecoder reported none) gets the
/// same 100ms default.
export function clampFrameDurationUs(rawUs: number | null | undefined): number {
  if (rawUs == null || rawUs <= 10_000) return 100_000;
  return rawUs;
}

/// Frame index to display at layer-local elapsed time `elapsedUs`, looping over
/// the sum of `frameDurationsUs`. Each entry is one frame's display time (µs),
/// already clamped via `clampFrameDurationUs`. Returns 0 for an empty list or a
/// zero total; tolerates negative `elapsedUs` defensively.
export function gifFrameIndexAt(elapsedUs: number, frameDurationsUs: number[]): number {
  const n = frameDurationsUs.length;
  if (n <= 1) return 0;
  let total = 0;
  for (const d of frameDurationsUs) total += d;
  if (total <= 0) return 0;
  let t = elapsedUs % total;
  if (t < 0) t += total;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += frameDurationsUs[i]!;
    if (t < acc) return i;
  }
  return n - 1;
}
