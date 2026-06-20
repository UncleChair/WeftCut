import { describe, it, expect } from "vitest";
import { clampFrameDurationUs, gifFrameIndexAt } from "./gifTiming";

describe("clampFrameDurationUs", () => {
  it("defaults missing/zero/sub-10ms delays to 100ms (classic GIF clamp)", () => {
    expect(clampFrameDurationUs(null)).toBe(100_000);
    expect(clampFrameDurationUs(undefined)).toBe(100_000);
    expect(clampFrameDurationUs(0)).toBe(100_000);
    expect(clampFrameDurationUs(5_000)).toBe(100_000); // 5ms ≤ 10ms threshold
    expect(clampFrameDurationUs(10_000)).toBe(100_000); // exactly 10ms boundary
  });
  it("honors normal delays", () => {
    expect(clampFrameDurationUs(20_000)).toBe(20_000);
    expect(clampFrameDurationUs(100_000)).toBe(100_000);
  });
});

describe("gifFrameIndexAt", () => {
  it("single frame is always index 0", () => {
    expect(gifFrameIndexAt(0, [100_000])).toBe(0);
    expect(gifFrameIndexAt(999_999, [100_000])).toBe(0);
  });

  it("selects by cumulative delay and loops at total duration", () => {
    const d = [100_000, 100_000]; // total 200ms
    expect(gifFrameIndexAt(0, d)).toBe(0);
    expect(gifFrameIndexAt(50_000, d)).toBe(0);
    expect(gifFrameIndexAt(100_000, d)).toBe(1);
    expect(gifFrameIndexAt(150_000, d)).toBe(1);
    expect(gifFrameIndexAt(200_000, d)).toBe(0); // loop
    expect(gifFrameIndexAt(250_000, d)).toBe(0);
    expect(gifFrameIndexAt(350_000, d)).toBe(1);
  });

  it("honors variable per-frame delays", () => {
    const d = [50_000, 150_000]; // total 200ms
    expect(gifFrameIndexAt(0, d)).toBe(0);
    expect(gifFrameIndexAt(49_999, d)).toBe(0);
    expect(gifFrameIndexAt(50_000, d)).toBe(1);
    expect(gifFrameIndexAt(199_999, d)).toBe(1);
    expect(gifFrameIndexAt(200_000, d)).toBe(0); // loop
    expect(gifFrameIndexAt(240_000, d)).toBe(0);
  });

  it("is defensive about negative elapsed", () => {
    expect(gifFrameIndexAt(-10_000, [100_000, 100_000])).toBe(1);
  });

  it("returns 0 for an empty or zero-total list", () => {
    expect(gifFrameIndexAt(123, [])).toBe(0);
    expect(gifFrameIndexAt(123, [0])).toBe(0);
  });
});
