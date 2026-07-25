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

  it("keeps only the last `capacity` samples", () => {
    const t = new HandoffTimings(4);
    for (const v of [100, 100, 100, 100, 1, 2, 3, 4]) t.record(0, 0, v);
    const s = t.summary()!;
    expect(s.n).toBe(4);
    expect(s.barrierMax).toBe(4);
  });
});
