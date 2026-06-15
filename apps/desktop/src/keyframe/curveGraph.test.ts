import { describe, expect, it } from "vitest";
import {
  computeValueRange, valueToY, yToValue, timeToXPx, xPxToTimeUs,
  type CurveGeom,
} from "./curveGraph";

const G: CurveGeom = { pxPerSec: 100, layerTStartUs: 0, height: 80, vmin: 0, vmax: 1 };

describe("value/time mappings", () => {
  it("timeToXPx maps absolute time at pxPerSec, layer-local offset added", () => {
    expect(timeToXPx(0, G)).toBe(0);
    expect(timeToXPx(1_000_000, G)).toBe(100); // 1s @100px/s
    expect(timeToXPx(0, { ...G, layerTStartUs: 2_000_000 })).toBe(200);
  });
  it("xPxToTimeUs inverts timeToXPx", () => {
    expect(xPxToTimeUs(100, G)).toBeCloseTo(1_000_000, 3);
    expect(xPxToTimeUs(0, { ...G, layerTStartUs: 2_000_000 })).toBeCloseTo(-2_000_000, 3);
  });
  it("valueToY is y-down (vmax at top=0, vmin at bottom=height) and round-trips", () => {
    expect(valueToY(1, G)).toBeCloseTo(0, 6);
    expect(valueToY(0, G)).toBeCloseTo(80, 6);
    expect(yToValue(valueToY(0.3, G), G)).toBeCloseTo(0.3, 6);
  });
  it("degenerate zero span returns mid-lane / vmin without NaN", () => {
    const flat = { ...G, vmin: 5, vmax: 5 };
    expect(valueToY(5, flat)).toBe(40);
    expect(yToValue(40, flat)).toBe(5);
  });
});

describe("computeValueRange", () => {
  it("pads min/max of keyframe values", () => {
    const r = computeValueRange([
      { t_us: 0, value: 0, interp: { kind: "Linear" } },
      { t_us: 1_000_000, value: 10, interp: { kind: "Linear" } },
    ]);
    expect(r.vmin).toBeCloseTo(-1, 6); // 0 - 10*0.1
    expect(r.vmax).toBeCloseTo(11, 6); // 10 + 10*0.1
  });
  it("includes overshoot from a curved segment (y>1)", () => {
    // p2 y = 1.5 overshoots past the end value → range must exceed [0,1]
    const r = computeValueRange([
      { t_us: 0, value: 0, interp: { kind: "Bezier", p1: [0.3, 0], p2: [0.7, 1.5] } },
      { t_us: 1_000_000, value: 1, interp: { kind: "Linear" } },
    ], 0);
    expect(r.vmax).toBeGreaterThan(1);
  });
  it("all-equal values yield a nominal band, not a zero span", () => {
    const r = computeValueRange([
      { t_us: 0, value: 3, interp: { kind: "Linear" } },
      { t_us: 1_000_000, value: 3, interp: { kind: "Linear" } },
    ]);
    expect(r.vmax).toBeGreaterThan(r.vmin);
  });
});
