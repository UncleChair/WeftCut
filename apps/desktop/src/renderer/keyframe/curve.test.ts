import { describe, expect, it } from "vitest";
import { interpToCoeffs, handleToCoeff, coeffToHandle } from "./curve";

describe("interpToCoeffs (spline-only)", () => {
  it("maps Linear and Hold to the identity diagonal", () => {
    expect(interpToCoeffs({ kind: "Linear" })).toEqual([0, 0, 1, 1]);
    expect(interpToCoeffs({ kind: "Hold" })).toEqual([0, 0, 1, 1]);
  });
  it("passes Bezier through", () => {
    expect(interpToCoeffs({ kind: "Bezier", p1: [0.2, 0.3], p2: [0.7, 0.9] }))
      .toEqual([0.2, 0.3, 0.7, 0.9]);
  });
});

describe("handle↔coeff (unit square, y inverted, px box of size 100)", () => {
  it("clamps handle x into [0,1] but leaves y free", () => {
    // a handle dragged past the right edge clamps x=1; above the top → y>1
    expect(handleToCoeff(150, -20, 100)).toEqual([1, 1.2]);
    expect(handleToCoeff(-30, 50, 100)).toEqual([0, 0.5]);
  });
  it("round-trips through coeffToHandle", () => {
    const [hx, hy] = coeffToHandle(0.42, 0, 100);
    expect(handleToCoeff(hx, hy, 100)).toEqual([0.42, 0]);
  });
});
