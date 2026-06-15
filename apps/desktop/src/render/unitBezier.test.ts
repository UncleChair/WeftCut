import { describe, expect, it } from "vitest";
import { unitBezier } from "./animated";

describe("unitBezier", () => {
  it("is identity when x/y coords are equal (linear)", () => {
    for (const x of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(unitBezier(0, 0, 1, 1, x)).toBeCloseTo(x, 6);
    }
  });
  it("hits endpoints", () => {
    expect(unitBezier(0.42, 0, 0.58, 1, 0)).toBeCloseTo(0, 9);
    expect(unitBezier(0.42, 0, 0.58, 1, 1)).toBeCloseTo(1, 9);
  });
  it("symmetric ease-in-out midpoint is 0.5", () => {
    expect(unitBezier(0.42, 0, 0.58, 1, 0.5)).toBeCloseTo(0.5, 6);
  });
  it("ease-in is slow at the start", () => {
    expect(unitBezier(0.42, 0, 1, 1, 0.25)).toBeLessThan(0.25);
    expect(unitBezier(0.42, 0, 1, 1, 0.5)).toBeLessThan(0.5);
    expect(unitBezier(0.42, 0, 1, 1, 0.75)).toBeLessThan(0.75); // matches the Rust twin's sample points
  });
});
