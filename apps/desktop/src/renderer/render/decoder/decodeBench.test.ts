import { describe, expect, it } from "vitest";
import { percentile, seekPlan } from "./decodeBench";

describe("percentile", () => {
  it("interpolates on sorted input", () => {
    expect(percentile([10], 50)).toBe(10);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 95)).toBeCloseTo(3.85, 5);
  });
});

describe("seekPlan", () => {
  const DUR = 60_000_000;
  it("emits exactly 40 targets cycling the four categories", () => {
    const plan = seekPlan(DUR);
    expect(plan).toHaveLength(40);
    expect(plan.map((p) => p.category).slice(0, 4)).toEqual([
      "forward-near", "forward-far", "backward-near", "backward-far",
    ]);
  });
  it("is deterministic and clamped to [0.5s, dur-2s]", () => {
    const a = seekPlan(DUR);
    const b = seekPlan(DUR);
    expect(a).toEqual(b);
    for (const p of a) {
      expect(p.targetUs).toBeGreaterThanOrEqual(500_000);
      expect(p.targetUs).toBeLessThanOrEqual(DUR - 2_000_000);
    }
  });
});
