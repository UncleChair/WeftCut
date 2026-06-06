import { describe, expect, it } from "vitest";

import { previewLoopTimeSec } from "./previewLoop";

describe("previewLoopTimeSec", () => {
  it("is 0 at the start", () => {
    expect(previewLoopTimeSec(0, 5000)).toBe(0);
  });
  it("maps elapsed ms to seconds within the first cycle", () => {
    expect(previewLoopTimeSec(2500, 5000)).toBeCloseTo(2.5, 6);
    expect(previewLoopTimeSec(4999, 5000)).toBeCloseTo(4.999, 6);
  });
  it("wraps at the duration boundary (loops)", () => {
    expect(previewLoopTimeSec(5000, 5000)).toBe(0); // exactly one cycle → back to 0
    expect(previewLoopTimeSec(6000, 5000)).toBeCloseTo(1.0, 6); // into 2nd cycle
    expect(previewLoopTimeSec(12500, 5000)).toBeCloseTo(2.5, 6); // 3rd cycle
  });
  it("guards against a non-positive duration", () => {
    expect(previewLoopTimeSec(1234, 0)).toBe(0);
    expect(previewLoopTimeSec(1234, -10)).toBe(0);
  });
  it("clamps negative elapsed to 0", () => {
    expect(previewLoopTimeSec(-100, 5000)).toBe(0);
  });
});
