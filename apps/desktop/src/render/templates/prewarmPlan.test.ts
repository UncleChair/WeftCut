import { describe, expect, it } from "vitest";
import { planPrewarmTargets } from "./prewarmPlan";

describe("planPrewarmTargets", () => {
  it("warms the whole content when it fits the budget, playhead-first then forward then backfill", () => {
    const plan = planPrewarmTargets([{ cacheKey: "a", contentFrame: 2, contentDurationFrames: 5 }], 240);
    expect(plan).toEqual([
      { cacheKey: "a", frame: 2 },
      { cacheKey: "a", frame: 3 },
      { cacheKey: "a", frame: 4 },
      { cacheKey: "a", frame: 0 },
      { cacheKey: "a", frame: 1 },
    ]);
  });
  it("windows to the per-content budget when content exceeds it (forward from current)", () => {
    const plan = planPrewarmTargets([{ cacheKey: "a", contentFrame: 10, contentDurationFrames: 100 }], 4);
    expect(plan).toEqual([
      { cacheKey: "a", frame: 10 },
      { cacheKey: "a", frame: 11 },
      { cacheKey: "a", frame: 12 },
      { cacheKey: "a", frame: 13 },
    ]);
  });
  it("splits the budget across contents and round-robins (union <= cap)", () => {
    const plan = planPrewarmTargets(
      [
        { cacheKey: "a", contentFrame: 0, contentDurationFrames: 100 },
        { cacheKey: "b", contentFrame: 0, contentDurationFrames: 100 },
      ],
      4,
    );
    expect(plan).toEqual([
      { cacheKey: "a", frame: 0 },
      { cacheKey: "b", frame: 0 },
      { cacheKey: "a", frame: 1 },
      { cacheKey: "b", frame: 1 },
    ]);
    expect(plan.length).toBeLessThanOrEqual(4);
  });
  it("dedups contents by cacheKey", () => {
    const plan = planPrewarmTargets(
      [
        { cacheKey: "a", contentFrame: 0, contentDurationFrames: 3 },
        { cacheKey: "a", contentFrame: 0, contentDurationFrames: 3 },
      ],
      240,
    );
    expect(plan).toEqual([
      { cacheKey: "a", frame: 0 },
      { cacheKey: "a", frame: 1 },
      { cacheKey: "a", frame: 2 },
    ]);
  });
  it("returns [] for no contents", () => {
    expect(planPrewarmTargets([], 240)).toEqual([]);
  });
});
