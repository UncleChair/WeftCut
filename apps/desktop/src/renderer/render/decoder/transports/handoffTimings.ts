// Rolling window over the per-frame handoff timings for the hardware lane: the
// preload stamps every frame message with `gvfMs` / `cibMs` / `residentMs`, and
// this window summarizes them.
//
// "Handoff" spans both sides of the port: under the shipped barrier the preload
// runs none and the renderer takes the completion signal itself, so
// `GpuTransport` records ITS OWN barrier stamps and fence health for those
// frames. The fields mean the same thing either way — what ran, what it cost,
// what it deferred — which is what lets one window compare the two.
//
// The number this exists for is `barrier`: the read-completion cost stamped
// directly around whichever barrier ran before the slot is acked (the
// subtraction in `record` is only a legacy fallback). A barrier is load-bearing
// for cross-device read ordering — without one the lane presents frames
// pool_size out of order — but it blocks a thread once per frame PER SESSION, so
// with several hardware clips it is the prime suspect for presentation judder
// that `lag`/dropped-frame counters cannot see.
//
// Pure and allocation-light: a fixed ring, sorted only when a summary is asked
// for (the HUD polls at 2 Hz).

import type { HwBarrierMode } from "../../../../shared/ipc";

/// Health of a deferred-ack fence queue, as the preload or renderer reports it
/// per frame. `pendingPeak`/`forcedWaits`/`forcedWaitMsTotal` are cumulative
/// counters (the window keeps the max, so they survive the ring); `waitMs` is
/// one completed submit→ack and is absent until the first fence drains.
/// Production `rendererFence` is signal-only, so its forced counters stay zero;
/// non-zero renderer values identify explicit unsafe/legacy diagnostic data.
export interface FenceHandoffStats {
  waitMs?: number;
  pendingPeak: number;
  forcedWaits: number;
  forcedWaitMsTotal: number;
}

export interface HandoffTimingSummary {
  /// Samples in the window.
  n: number;
  /// The synchronous read-completion barrier, ms.
  barrierP50: number;
  barrierP95: number;
  barrierMax: number;
  /// The barrier split into its two phases — the rasterize and the CPU read.
  /// They are reported apart because the readback's 2D context is created with
  /// `willReadFrequently: true`, hinting a CPU-backed canvas: `drawImage` of a
  /// GPU-backed bitmap may ALREADY be the GPU→CPU readback, leaving
  /// `getImageData` nearly free. The total cannot tell that apart from the
  /// reverse, and the two suggest opposite fixes. Under the GPU-flush barrier
  /// the whole cost lands in draw; with no barrier both are 0.
  barrierDrawP50: number;
  barrierReadP50: number;
  /// Which barrier the preload actually RAN, as opposed to the one the run was
  /// configured for. It exists because the configured label can lie — the
  /// preload falls back from a GPU path to `readback` when WebGL2 is missing,
  /// and main resolves an unset or unrecognised mode to `rendererFence` — so a bench leg
  /// that trusts its own `WEFTCUT_HW_BARRIER` label can report a barrier-less
  /// result that in fact ran the full barrier. A measurement whose route drifted
  /// is invalid, not slow; this is what makes the drift visible.
  ///
  /// Note the two fallbacks differ ON PURPOSE: main's unrecognised-mode default
  /// is `rendererFence`, while the preload's fallback for a stream whose barrier
  /// latch never arrived is `readback`. Because that differs from the default, an
  /// unlatched frame reports a second applied mode and the session reads
  /// `'mixed'` — a fallback that matched the default would blend in silently.
  ///
  /// Null when no frame carried the stamp (a non-instrumented preload) — the
  /// same "don't answer what you didn't measure" rule the null summary follows.
  /// `'mixed'` is the disagreement sentinel; see the latch in `record`.
  barrierModeObserved: HwBarrierMode | "mixed" | null;
  /// The three health indicators for deferred fence barriers, which trade a
  /// blocking wait for a deferred one and therefore has failure modes the
  /// barrier timings above cannot show.
  ///
  /// `fenceWaitP50` is the deferred wait itself (submit → ack), null until a
  /// fence completes — it is NOT loop cost, and reading it as such is the
  /// mistake this split exists to prevent. `fencePendingQueuePeak` is how deep
  /// the un-acked queue ever got: approaching `poolSize` means the deferral is
  /// starving the producer rather than freeing it. `fenceForcedWaits` counts
  /// preload WebGL forced waits, plus explicit unsafe/legacy renderer deadline
  /// releases. It stays zero for production's signal-only `rendererFence`.
  fenceWaitP50: number | null;
  fencePendingQueuePeak: number;
  fenceForcedWaits: number;
  /// Wall-clock ms burned inside forced spins, SUMMED over the session — the
  /// preload fence's only blocking cost, and the one `barrierP50` cannot show,
  /// since that stays submit-only there. A sum and not a percentile on purpose:
  /// spins are a minority of frames, so every percentile reports them as zero.
  /// That is how a cell doing 223 spins came back at 0.01 barrier thread-s/s and
  /// passed an acceptance criterion while burning the main thread. Divide by the
  /// measurement window to fold it back into a real thread-seconds figure.
  ///
  /// Structurally 0 under `rendererFence`: a promise-based completion signal has
  /// nothing to poll, and production has no deadline release. A zero here means
  /// no spin exists; `fencePendingQueuePeak`/`fenceWaitP50` carry its health.
  fenceForcedWaitMsTotal: number;
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
  private readonly barrierDraw: number[] = [];
  private readonly barrierRead: number[] = [];
  private readonly cib: number[] = [];
  private readonly resident: number[] = [];
  private next = 0;
  private count = 0;
  /// Latched applied barrier — NOT a ring entry. Deliberately outside the
  /// window: a session's barrier is fixed at open, so a change is a defect, and
  /// a defect that scrolls out of a 120-frame window is a defect nobody sees.
  private observedMode: HwBarrierMode | "mixed" | null = null;
  /// Deferred-fence waits get their OWN ring: they ride in on a frame message
  /// but only some frames carry one (none until the first fence drains), so
  /// indexing them alongside the per-frame stamps would pad the window with
  /// zeros and halve the reported wait.
  private readonly fenceWait: number[] = [];
  private fenceNext = 0;
  private fenceCount = 0;
  /// Cumulative counters from the preload, kept as maxima — the sender only ever
  /// grows them, so max is last-known and survives the ring's eviction.
  private fencePendingPeak = 0;
  private fenceForced = 0;
  private fenceForcedMsTotal = 0;

  constructor(private readonly capacity = 120) {}

  /// Record one frame's preload timings. A message without the (optional)
  /// timing fields is ignored rather than recorded as zero — a
  /// non-instrumented build must not read as "the barrier is free".
  record(
    gvfMs: number | undefined,
    cibMs: number | undefined,
    residentMs: number | undefined,
    barrierMs?: number,
    barrierDrawMs?: number,
    barrierReadMs?: number,
    barrierApplied?: HwBarrierMode,
    fence?: FenceHandoffStats,
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
    // The phase split is optional ON TOP of the optional total, and has no
    // fallback: there is nothing to derive it from. A sender that omits it
    // records 0, which reads as "unsplit", not as "the barrier is free" — the
    // total above stays truthful either way. 0/0 with a non-zero total means an
    // un-split sender; 0/0 with a zero total means no barrier ran at all.
    this.barrierDraw[i] = barrierDrawMs ?? 0;
    this.barrierRead[i] = barrierReadMs ?? 0;
    this.cib[i] = cibMs;
    this.resident[i] = residentMs;
    // Latch the FIRST applied mode; any later disagreement sticks at 'mixed'
    // and can never be latched back down. Last-wins would hide a mid-session
    // change behind whichever frame happened to land last, and one number can't
    // summarize two barriers anyway — the samples either describe one variant or
    // they describe nothing usable. 'mixed' says which of those it is.
    if (barrierApplied !== undefined) {
      this.observedMode =
        this.observedMode === null || this.observedMode === barrierApplied ? barrierApplied : "mixed";
    }
    if (fence) {
      this.fencePendingPeak = Math.max(this.fencePendingPeak, fence.pendingPeak);
      this.fenceForced = Math.max(this.fenceForced, fence.forcedWaits);
      this.fenceForcedMsTotal = Math.max(this.fenceForcedMsTotal, fence.forcedWaitMsTotal);
      if (fence.waitMs !== undefined) {
        this.fenceWait[this.fenceNext % this.capacity] = fence.waitMs;
        this.fenceNext += 1;
        if (this.fenceCount < this.capacity) this.fenceCount += 1;
      }
    }
    this.next += 1;
    if (this.count < this.capacity) this.count += 1;
  }

  /// Null until at least one sample lands, so a caller can tell "no hardware
  /// frames yet" from "0 ms".
  summary(): HandoffTimingSummary | null {
    if (this.count === 0) return null;
    const b = this.barrier.slice(0, this.count).sort((x, y) => x - y);
    const bd = this.barrierDraw.slice(0, this.count).sort((x, y) => x - y);
    const br = this.barrierRead.slice(0, this.count).sort((x, y) => x - y);
    const c = this.cib.slice(0, this.count).sort((x, y) => x - y);
    const r = this.resident.slice(0, this.count).sort((x, y) => x - y);
    return {
      n: this.count,
      barrierP50: pct(b, 0.5),
      barrierP95: pct(b, 0.95),
      barrierMax: b[b.length - 1] ?? 0,
      barrierDrawP50: pct(bd, 0.5),
      barrierReadP50: pct(br, 0.5),
      barrierModeObserved: this.observedMode,
      fenceWaitP50: this.fenceCount === 0
        ? null
        : pct(this.fenceWait.slice(0, this.fenceCount).sort((x, y) => x - y), 0.5),
      fencePendingQueuePeak: this.fencePendingPeak,
      fenceForcedWaits: this.fenceForced,
      fenceForcedWaitMsTotal: this.fenceForcedMsTotal,
      cibP50: pct(c, 0.5),
      residentP50: pct(r, 0.5),
    };
  }
}
