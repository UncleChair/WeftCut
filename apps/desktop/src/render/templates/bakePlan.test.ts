import { describe, expect, it } from "vitest";
import { planBakeTargets, type BakeContent } from "./bakePlan";

const content = (cacheKey: string, contentFrame: number, n: number): BakeContent => ({
  cacheKey,
  contentFrame,
  contentDurationFrames: n,
});

describe("planBakeTargets", () => {
  it("plans the WHOLE content (not capped), playhead-first then backfill", () => {
    const out = planBakeTargets([content("a", 2, 5)], () => false);
    expect(out).toEqual([
      { cacheKey: "a", frame: 2 },
      { cacheKey: "a", frame: 3 },
      { cacheKey: "a", frame: 4 },
      { cacheKey: "a", frame: 0 },
      { cacheKey: "a", frame: 1 },
    ]);
  });

  it("skips frames already on disk", () => {
    const onDisk = new Set(["a#0", "a#1"]);
    const out = planBakeTargets([content("a", 0, 3)], (k, f) => onDisk.has(`${k}#${f}`));
    expect(out).toEqual([{ cacheKey: "a", frame: 2 }]);
  });

  it("dedups by cacheKey and round-robins across contents", () => {
    const out = planBakeTargets([content("a", 0, 2), content("a", 0, 2), content("b", 0, 2)], () => false);
    // 'a' appears once (deduped); round-robin interleaves a,b then a,b.
    expect(out).toEqual([
      { cacheKey: "a", frame: 0 },
      { cacheKey: "b", frame: 0 },
      { cacheKey: "a", frame: 1 },
      { cacheKey: "b", frame: 1 },
    ]);
  });

  it("returns empty for no contents", () => {
    expect(planBakeTargets([], () => false)).toEqual([]);
  });
});
