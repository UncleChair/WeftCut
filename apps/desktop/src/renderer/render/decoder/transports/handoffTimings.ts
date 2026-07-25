// Rolling window over the preload's per-frame handoff timings for the hardware
// lane. The preload already stamps every frame message with `gvfMs` / `cibMs` /
// `residentMs`; nothing consumed them, so the one cost we most want to see was
// invisible.
//
// The number this exists for is `barrier`: `residentMs - gvfMs - cibMs`, the
// SYNCHRONOUS GPU drain `forceSharedTextureReadComplete` performs before the
// slot is acked (preload/index.ts). It is load-bearing for cross-device read
// ordering — without it the lane presents frames pool_size out of order — but it
// blocks the renderer thread once per frame PER SESSION, so with several
// hardware clips it is the prime suspect for presentation judder that
// `lag`/dropped-frame counters cannot see.
//
// Pure and allocation-light: a fixed ring, sorted only when a summary is asked
// for (the HUD polls at 2 Hz).

export interface HandoffTimingSummary {
  /// Samples in the window.
  n: number;
  /// The synchronous read-completion barrier, ms.
  barrierP50: number;
  barrierP95: number;
  barrierMax: number;
  /// `createImageBitmap` — an enqueue, so cheap; it is the barrier that waits
  /// for the copy this call schedules.
  cibP50: number;
  /// Whole preload residency: getVideoFrame → barrier complete.
  residentP50: number;
}

/// Nearest-rank percentile over an already-sorted array. `q` in [0,1].
function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i] ?? 0;
}

export class HandoffTimings {
  private readonly barrier: number[] = [];
  private readonly cib: number[] = [];
  private readonly resident: number[] = [];
  private next = 0;
  private count = 0;

  constructor(private readonly capacity = 120) {}

  /// Record one frame's preload timings. A message without the (optional)
  /// timing fields is ignored rather than recorded as zero — a
  /// non-instrumented build must not read as "the barrier is free".
  record(
    gvfMs: number | undefined,
    cibMs: number | undefined,
    residentMs: number | undefined,
    barrierMs?: number,
  ): void {
    if (gvfMs === undefined || cibMs === undefined || residentMs === undefined) return;
    const i = this.next % this.capacity;
    // Prefer the directly-stamped barrier. The subtraction below is the legacy
    // fallback and OVERSTATES the drain — it also absorbs `vf.close()` and any
    // scheduling gap around the `createImageBitmap` await, so it reads several
    // times the real cost and inverts with load. Clamped because
    // `performance.now()` granularity can make the three stamps sum marginally
    // past `residentMs`, and a negative barrier reads as nonsense.
    this.barrier[i] = barrierMs ?? Math.max(0, residentMs - gvfMs - cibMs);
    this.cib[i] = cibMs;
    this.resident[i] = residentMs;
    this.next += 1;
    if (this.count < this.capacity) this.count += 1;
  }

  /// Null until at least one sample lands, so a caller can tell "no hardware
  /// frames yet" from "0 ms".
  summary(): HandoffTimingSummary | null {
    if (this.count === 0) return null;
    const b = this.barrier.slice(0, this.count).sort((x, y) => x - y);
    const c = this.cib.slice(0, this.count).sort((x, y) => x - y);
    const r = this.resident.slice(0, this.count).sort((x, y) => x - y);
    return {
      n: this.count,
      barrierP50: pct(b, 0.5),
      barrierP95: pct(b, 0.95),
      barrierMax: b[b.length - 1] ?? 0,
      cibP50: pct(c, 0.5),
      residentP50: pct(r, 0.5),
    };
  }
}
