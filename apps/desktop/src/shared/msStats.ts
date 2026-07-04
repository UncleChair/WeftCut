// Pure ms-summary helpers shared across processes (main + renderer) so the
// percentile formula isn't copied per caller. Linear-interp percentiles over
// ascending samples; empty -> all-zero (matching the Rust `summarize` empty case,
// so a session with no samples reports 0/0 across the bridge rather than NaN).
import type { PreviewGpuTimingSummary } from "./ipc";

/// Linear-interpolated percentile over an ASCENDING-sorted array.
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/// Summarize ms samples into the napi-uniform PreviewGpuTimingSummary shape.
export function msSummary(samples: number[]): PreviewGpuTimingSummary {
  if (samples.length === 0) {
    return { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    meanMs: sum / sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1]!,
  };
}
