import { describe, expect, it } from "vitest";
import type { Envelope } from "./envelope";
import { panCoeffsAt, constantPanGains } from "./panGraph";

const constEnv = (v: number): Envelope => ({ stepUs: 10_000, spanUs: 1_000_000, values: [v] });

describe("panGraph coefficients", () => {
  it("static center stereo is identity", () => {
    const c = panCoeffsAt(constEnv(0), 2, 12_345);
    expect(c[0]).toBeCloseTo(1, 5);
    expect(c[3]).toBeCloseTo(1, 5);
    expect(c[1]).toBeCloseTo(0, 5);
  });
  it("constantPanGains mono center splits equally", () => {
    const g = constantPanGains(constEnv(0), 1);
    expect(g[0]).toBeCloseTo(0.70710677, 5); // a -> L
    expect(g[1]).toBeCloseTo(0.70710677, 5); // c -> R
  });
});
