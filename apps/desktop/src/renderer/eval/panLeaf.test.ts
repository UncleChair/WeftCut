import { describe, expect, it } from "vitest";
import { panCoeff, fadeMul } from "./index";

// testSetup.ts awaits initEval() before each file.
describe("pan + fade leaf wrappers", () => {
  it("pan_coeff stereo center is identity", () => {
    expect(panCoeff(0, 2, 0)).toBeCloseTo(1, 6); // a
    expect(panCoeff(0, 2, 3)).toBeCloseTo(1, 6); // d
    expect(panCoeff(0, 2, 1)).toBeCloseTo(0, 6); // b
  });
  it("pan_coeff mono center is equal power", () => {
    expect(panCoeff(0, 1, 0)).toBeCloseTo(0.70710677, 6);
    expect(panCoeff(0, 1, 2)).toBeCloseTo(0.70710677, 6);
  });
  it("fade_mul ramps linearly", () => {
    expect(fadeMul(500_000, 10_000_000, 1_000_000, 0)).toBeCloseTo(0.5, 9);
    expect(fadeMul(500_000, 1_000_000, 0, 0)).toBe(1);
  });
});
