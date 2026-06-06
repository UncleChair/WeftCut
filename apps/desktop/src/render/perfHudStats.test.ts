import { describe, expect, it } from "vitest";

import { throughputFps } from "./perfHudStats";

describe("throughputFps", () => {
  it("returns 0 for the first sample (no prior to diff against)", () => {
    expect(throughputFps(undefined, { count: 42, atMs: 1000 })).toBe(0);
  });

  it("derives fps from the frame-count delta over the time delta", () => {
    // 30 new frames across 500 ms => 60 fps.
    expect(throughputFps({ count: 10, atMs: 500 }, { count: 40, atMs: 1000 })).toBe(60);
  });

  it("reads as 0 on a stall (counter unchanged) rather than a stale rate", () => {
    expect(throughputFps({ count: 40, atMs: 1000 }, { count: 40, atMs: 1500 })).toBe(0);
  });

  it("returns 0 for a non-positive time delta (clock didn't advance)", () => {
    expect(throughputFps({ count: 10, atMs: 1000 }, { count: 40, atMs: 1000 })).toBe(0);
  });

  it("returns 0 when the counter went backwards (decoder rebuild reset it)", () => {
    expect(throughputFps({ count: 40, atMs: 1000 }, { count: 5, atMs: 1500 })).toBe(0);
  });
});
