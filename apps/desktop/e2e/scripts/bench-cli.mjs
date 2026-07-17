// Pure, side-effect-free CLI helpers for decode-bench.mjs — extracted so they can
// be unit-checked without importing the orchestrator (which launches Electron on
// import). See docs/decode-bench.md.

/// The native pool sizes swept in --pool-sweep mode (Stage 3). 12 x 1080p NV12 ~= 48MB.
export const SWEEP_POOL_SIZES = [3, 6, 9, 12];

/// Validate a --pool-size value. `undefined`/absent is allowed (product default 3
/// applies downstream). Rejects non-integers, zero, and negatives.
export function parsePoolSize(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, error: `invalid --pool-size '${raw}' (expected a positive integer)` };
  }
  return { ok: true, value: n };
}

/// Validate a --throttle-ms value: the throughput driver's per-loop pacing delay.
/// `undefined`/absent → default (10) applies downstream. Rejects non-integers and
/// negatives; ALLOWS 0 (the unthrottled/yield-only driver — the point of the probe).
export function parseThrottleMs(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, error: `invalid --throttle-ms '${raw}' (expected a non-negative integer)` };
  }
  return { ok: true, value: n };
}
