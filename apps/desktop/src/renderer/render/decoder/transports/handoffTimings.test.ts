import { describe, expect, it } from "vitest";

import { HandoffTimings } from "./handoffTimings";

describe("HandoffTimings", () => {
  it("is null until a sample lands, so 'no frames yet' never reads as 0 ms", () => {
    expect(new HandoffTimings().summary()).toBeNull();
  });

  it("derives the barrier as resident minus the two stamped stages", () => {
    const t = new HandoffTimings();
    t.record(0.5, 1.5, 12); // barrier = 10
    const s = t.summary()!;
    expect(s.n).toBe(1);
    expect(s.barrierP50).toBeCloseTo(10);
    expect(s.cibP50).toBeCloseTo(1.5);
    expect(s.residentP50).toBeCloseTo(12);
  });

  // The subtraction also absorbs `vf.close()` and the scheduling gap around the
  // `createImageBitmap` await, so where a direct stamp exists it must win — the
  // derived figure overstates the drain by several times.
  it("prefers a directly-stamped barrier over the subtraction", () => {
    const t = new HandoffTimings();
    t.record(0.5, 1.5, 12, 0.4);
    expect(t.summary()!.barrierP50).toBeCloseTo(0.4);
  });

  // The two halves of the readback are not separable from the total, and they
  // point at opposite fixes — a costly `drawImage` says the GPU→CPU transfer
  // already happened there; a costly `getImageData` says it happens on the read.
  it("keeps the barrier's two phases apart from its total", () => {
    const t = new HandoffTimings();
    t.record(0.5, 1.5, 22, 20, 19.4, 0.6);
    const s = t.summary()!;
    expect(s.barrierP50).toBeCloseTo(20);
    expect(s.barrierDrawP50).toBeCloseTo(19.4);
    expect(s.barrierReadP50).toBeCloseTo(0.6);
  });

  // Nothing can derive the split, so an un-split sender reads 0/0 — "unsplit",
  // told apart from "no barrier ran" by the total, which stays truthful.
  it("reports the phases as zero when the sender omits them", () => {
    const t = new HandoffTimings();
    t.record(0.5, 1.5, 22, 20);
    const s = t.summary()!;
    expect(s.barrierP50).toBeCloseTo(20);
    expect(s.barrierDrawP50).toBe(0);
    expect(s.barrierReadP50).toBe(0);
  });

  // The applied mode is what makes a bench leg's label falsifiable. Every one of
  // these asserts the OUTCOME the preload reported, never the intent it was
  // configured with.
  it("reports no observed mode until a frame carries one", () => {
    const t = new HandoffTimings();
    t.record(0.5, 1.5, 22, 20, 19.4, 0.6);
    expect(t.summary()!.barrierModeObserved).toBeNull();
  });

  it("reports the barrier the preload applied", () => {
    const t = new HandoffTimings();
    t.record(0.5, 1.5, 22, 20, 19.4, 0.6, "readback");
    expect(t.summary()!.barrierModeObserved).toBe("readback");
  });

  // The sharp case: `gpuflush` was configured, WebGL2 was unavailable, and the
  // preload's fallback ran the readback barrier. Crediting the cheap barrier
  // with the expensive one's cost is exactly the false PASS this field exists to
  // stop, so the observed mode must agree with the cost profile beside it — a
  // CPU-read phase, which a real gpuflush leg can never have.
  it("reports readback, not gpuflush, when a gpuflush leg fell back to it", () => {
    const t = new HandoffTimings();
    for (let i = 0; i < 5; i++) t.record(0.5, 1.5, 22, 20, 19.4, 0.6, "readback");
    const s = t.summary()!;
    expect(s.barrierModeObserved).toBe("readback");
    expect(s.barrierReadP50).toBeGreaterThan(0);
  });

  it("reports 'none' for the known-incorrect control", () => {
    const t = new HandoffTimings();
    t.record(0.5, 1.5, 2, 0, 0, 0, "none");
    const s = t.summary()!;
    expect(s.barrierModeObserved).toBe("none");
    expect(s.barrierP50).toBe(0);
  });

  // A session's barrier is fixed at open, so two of them in one window is a
  // defect. 'mixed' refuses to average it away or let the last frame win.
  it("latches 'mixed' when two modes appear in one window", () => {
    const t = new HandoffTimings();
    t.record(0.5, 1.5, 22, 20, 19.4, 0.6, "readback");
    t.record(0.5, 1.5, 3, 1, 1, 0, "gpuflush");
    expect(t.summary()!.barrierModeObserved).toBe("mixed");
  });

  it("cannot latch back out of 'mixed'", () => {
    const t = new HandoffTimings();
    t.record(0.5, 1.5, 22, 20, 19.4, 0.6, "readback");
    t.record(0.5, 1.5, 3, 1, 1, 0, "gpuflush");
    for (let i = 0; i < 10; i++) t.record(0.5, 1.5, 22, 20, 19.4, 0.6, "readback");
    expect(t.summary()!.barrierModeObserved).toBe("mixed");
  });

  // The latch outlives the ring on purpose: a disagreement that scrolls out of
  // the window is a disagreement nobody ever sees.
  it("keeps 'mixed' after the disagreeing sample leaves the window", () => {
    const t = new HandoffTimings(4);
    t.record(0, 0, 1, 1, 0, 0, "gpuflush");
    for (let i = 0; i < 8; i++) t.record(0, 0, 1, 1, 0, 0, "readback");
    const s = t.summary()!;
    expect(s.n).toBe(4);
    expect(s.barrierModeObserved).toBe("mixed");
  });

  // The fence barrier defers the wait instead of paying it inline, so the four
  // fields below are the only way to tell "moved the cost" from "removed it".
  it("reports no fence wait until a fence completes", () => {
    const t = new HandoffTimings();
    // First fence frame: submitted, nothing drained yet, so no `waitMs`.
    t.record(0.5, 1.5, 2, 0.1, 0.1, 0, "fence", { pendingPeak: 1, forcedWaits: 0, forcedWaitMsTotal: 0 });
    const s = t.summary()!;
    expect(s.barrierModeObserved).toBe("fence");
    expect(s.fenceWaitP50).toBeNull();
    expect(s.fencePendingQueuePeak).toBe(1);
    expect(s.fenceForcedWaits).toBe(0);
  });

  it("keeps the deferred wait out of the blocking barrier cost", () => {
    const t = new HandoffTimings();
    for (let i = 0; i < 4; i++) {
      t.record(0.5, 1.5, 2, 0.1, 0.1, 0, "fence", { waitMs: 16, pendingPeak: 2, forcedWaits: 0, forcedWaitMsTotal: 0 });
    }
    const s = t.summary()!;
    expect(s.barrierP50).toBeCloseTo(0.1);
    expect(s.fenceWaitP50).toBeCloseTo(16);
  });

  it("percentiles fence waits over their own window, not the frame window", () => {
    const t = new HandoffTimings();
    // Two frames submitted before any fence drained, then 100 carrying a wait —
    // counting the first two as zero would halve the reported p50.
    t.record(0, 0, 1, 0.1, 0.1, 0, "fence", { pendingPeak: 1, forcedWaits: 0, forcedWaitMsTotal: 0 });
    t.record(0, 0, 1, 0.1, 0.1, 0, "fence", { pendingPeak: 2, forcedWaits: 0, forcedWaitMsTotal: 0 });
    for (let i = 1; i <= 100; i++) {
      t.record(0, 0, 1, 0.1, 0.1, 0, "fence", { waitMs: i, pendingPeak: 2, forcedWaits: 0, forcedWaitMsTotal: 0 });
    }
    expect(t.summary()!.fenceWaitP50).toBe(50);
  });

  // Cumulative counters from the preload: last-known must survive the ring, or a
  // force-wait storm early in a long session would scroll out of sight.
  it("keeps the peak queue depth, forced-wait count and spin total as maxima", () => {
    const t = new HandoffTimings(4);
    t.record(0, 0, 1, 0.1, 0.1, 0, "fence", { waitMs: 5, pendingPeak: 3, forcedWaits: 2, forcedWaitMsTotal: 41 });
    for (let i = 0; i < 8; i++) {
      t.record(0, 0, 1, 0.1, 0.1, 0, "fence", { waitMs: 5, pendingPeak: 3, forcedWaits: 2, forcedWaitMsTotal: 41 });
    }
    const s = t.summary()!;
    expect(s.n).toBe(4);
    expect(s.fencePendingQueuePeak).toBe(3);
    expect(s.fenceForcedWaits).toBe(2);
    expect(s.fenceForcedWaitMsTotal).toBeCloseTo(41);
  });

  // The spin total is the fence path's ONLY blocking cost, and `barrierP50`
  // cannot show it: a session spinning hundreds of times still submits in
  // ~0.1ms. Reporting barrier cost off the p50 alone is how a cell burning the
  // main thread came back at 0.01 thread-s/s and passed.
  it("accumulates forced-spin time that the submit-only barrier cost cannot show", () => {
    const t = new HandoffTimings();
    t.record(0, 0, 1, 0.1, 0.1, 0, "fence", { waitMs: 35, pendingPeak: 3, forcedWaits: 100, forcedWaitMsTotal: 1900 });
    t.record(0, 0, 1, 0.1, 0.1, 0, "fence", { waitMs: 35, pendingPeak: 3, forcedWaits: 223, forcedWaitMsTotal: 4300 });
    const s = t.summary()!;
    expect(s.barrierP50).toBeCloseTo(0.1);
    expect(s.fenceForcedWaitMsTotal).toBeCloseTo(4300);
  });

  // A sum, not a percentile: spins are a minority of frames, so a p50 (or even a
  // p95) over these samples reads zero while seconds of thread time are gone.
  it("does not let a minority of spins vanish the way a percentile would", () => {
    const t = new HandoffTimings();
    for (let i = 0; i < 99; i++) {
      t.record(0, 0, 1, 0.1, 0.1, 0, "fence", { waitMs: 6, pendingPeak: 2, forcedWaits: 0, forcedWaitMsTotal: 0 });
    }
    t.record(0, 0, 1, 0.1, 0.1, 0, "fence", { waitMs: 6, pendingPeak: 2, forcedWaits: 1, forcedWaitMsTotal: 20 });
    const s = t.summary()!;
    expect(s.fenceWaitP50).toBeCloseTo(6);
    expect(s.fenceForcedWaitMsTotal).toBeCloseTo(20);
  });

  // A fence path force-waiting every frame is the synchronous barrier in
  // disguise; the count is what makes that legible rather than just "slow".
  it("surfaces a rising forced-wait count", () => {
    const t = new HandoffTimings();
    t.record(0, 0, 1, 0.1, 0.1, 0, "fence", { waitMs: 20, pendingPeak: 1, forcedWaits: 1, forcedWaitMsTotal: 19 });
    t.record(0, 0, 1, 0.1, 0.1, 0, "fence", { waitMs: 20, pendingPeak: 1, forcedWaits: 7, forcedWaitMsTotal: 133 });
    expect(t.summary()!.fenceForcedWaits).toBe(7);
  });

  it("reports zeroed fence health on a run with no fences", () => {
    const t = new HandoffTimings();
    t.record(0.5, 1.5, 22, 20, 19.4, 0.6, "readback");
    const s = t.summary()!;
    expect(s.fenceWaitP50).toBeNull();
    expect(s.fencePendingQueuePeak).toBe(0);
    expect(s.fenceForcedWaits).toBe(0);
    expect(s.fenceForcedWaitMsTotal).toBe(0);
  });

  it("does not clamp a directly-stamped zero barrier away", () => {
    const t = new HandoffTimings();
    t.record(1, 1, 20, 0);
    expect(t.summary()!.barrierP50).toBe(0);
  });

  // A non-instrumented build omits the fields; recording them as zero would
  // report the barrier as free, which is the exact wrong conclusion.
  it("ignores a frame missing any stamp rather than counting it as zero", () => {
    const t = new HandoffTimings();
    t.record(undefined, 1, 5);
    t.record(1, undefined, 5);
    t.record(1, 1, undefined);
    expect(t.summary()).toBeNull();
  });

  it("clamps a negative barrier to zero (performance.now granularity)", () => {
    const t = new HandoffTimings();
    t.record(1, 1, 1.5); // 1.5 - 2 < 0
    expect(t.summary()!.barrierP50).toBe(0);
  });

  it("reports nearest-rank percentiles and the window max", () => {
    const t = new HandoffTimings();
    for (let i = 1; i <= 100; i++) t.record(0, 0, i); // barrier = 1..100
    const s = t.summary()!;
    expect(s.n).toBe(100);
    expect(s.barrierP50).toBe(50);
    expect(s.barrierP95).toBe(95);
    expect(s.barrierMax).toBe(100);
  });

  it("percentiles each phase over its own window", () => {
    const t = new HandoffTimings();
    for (let i = 1; i <= 100; i++) t.record(0, 0, i, i, i * 0.9, i * 0.1);
    const s = t.summary()!;
    expect(s.barrierDrawP50).toBeCloseTo(45);
    expect(s.barrierReadP50).toBeCloseTo(5);
  });

  it("keeps only the last `capacity` samples", () => {
    const t = new HandoffTimings(4);
    for (const v of [100, 100, 100, 100, 1, 2, 3, 4]) t.record(0, 0, v);
    const s = t.summary()!;
    expect(s.n).toBe(4);
    expect(s.barrierMax).toBe(4);
  });
});
