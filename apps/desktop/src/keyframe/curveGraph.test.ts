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
    const G3 = { ...G, layerTStartUs: 2_000_000 };
    expect(xPxToTimeUs(timeToXPx(500_000, G3), G3)).toBeCloseTo(500_000, 3);
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

import { segmentPolyline, segmentHandles, type Seg } from "./curveGraph";

const SEG: Seg = { aTUs: 0, aVal: 0, bTUs: 1_000_000, bVal: 1 }; // 0→1 over 1s
const G2: CurveGeom = { pxPerSec: 100, layerTStartUs: 0, height: 100, vmin: 0, vmax: 1 };

describe("segmentPolyline", () => {
  it("Linear → two points corner to corner", () => {
    expect(segmentPolyline(SEG, { kind: "Linear" }, G2)).toEqual([
      { x: 0, y: 100 }, // t0 v0 → bottom-left
      { x: 100, y: 0 }, // t1 v1 → top-right
    ]);
  });
  it("Hold → flat then vertical step", () => {
    expect(segmentPolyline(SEG, { kind: "Hold" }, G2)).toEqual([
      { x: 0, y: 100 },   // start
      { x: 100, y: 100 }, // flat at start value
      { x: 100, y: 0 },   // step up at next key
    ]);
  });
  it("Bezier → sampled, endpoints anchored at the keyframes", () => {
    const pts = segmentPolyline(SEG, { kind: "Bezier", p1: [0.42, 0], p2: [0.58, 1] }, G2, 10);
    expect(pts.length).toBe(11);
    expect(pts[0]).toEqual({ x: 0, y: 100 });
    expect(pts[10]).toEqual({ x: 100, y: 0 });
    // midpoint x is the time midpoint; y is between the endpoints
    expect(pts[5]!.x).toBeCloseTo(50, 6);
    expect(pts[5]!.y).toBeGreaterThan(0);
    expect(pts[5]!.y).toBeLessThan(100);
  });
  it("flat-value Bezier (Δv==0) renders a horizontal line, no NaN", () => {
    const flat: Seg = { aTUs: 0, aVal: 5, bTUs: 1_000_000, bVal: 5 };
    const gFlat: CurveGeom = { pxPerSec: 100, layerTStartUs: 0, height: 100, vmin: 4, vmax: 6 };
    const pts = segmentPolyline(flat, { kind: "Bezier", p1: [0.3, 0], p2: [0.7, 1] }, gFlat, 8);
    expect(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    const y0 = pts[0]!.y;
    expect(pts.every((p) => Math.abs(p.y - y0) < 1e-9)).toBe(true);
  });
});

describe("segmentHandles", () => {
  it("returns null for Hold and Linear (no editable handles)", () => {
    expect(segmentHandles(SEG, { kind: "Hold" }, G2)).toBeNull();
    expect(segmentHandles(SEG, { kind: "Linear" }, G2)).toBeNull();
  });
  it("places p1/p2 control points in time/value px space", () => {
    const h = segmentHandles(SEG, { kind: "Bezier", p1: [0.25, 0.1], p2: [0.75, 0.9] }, G2)!;
    expect(h.p1.x).toBeCloseTo(25, 6);  // 0.25 of 100px width
    expect(h.p1.y).toBeCloseTo(90, 6);  // value 0.1 → y = (1-0.1)*100
    expect(h.p2.x).toBeCloseTo(75, 6);
    expect(h.p2.y).toBeCloseTo(10, 6);  // value 0.9 → y = (1-0.9)*100
  });
});

import { handleDragToCoeff } from "./curveGraph";

describe("handleDragToCoeff", () => {
  const seg: Seg = { aTUs: 0, aVal: 0, bTUs: 1_000_000, bVal: 1 };
  const g: CurveGeom = { pxPerSec: 100, layerTStartUs: 0, height: 100, vmin: 0, vmax: 1 };
  const cur: [number, number, number, number] = [0.42, 0, 0.58, 1];

  it("maps pointer px to p1 coeff (x in segment-progress, y in value)", () => {
    // pointer at x=25px (=0.25 of the 100px wide segment), y=80px (=value 0.2)
    const next = handleDragToCoeff("p1", 25, 80, seg, g, cur);
    expect(next[0]).toBeCloseTo(0.25, 6);
    expect(next[1]).toBeCloseTo(0.2, 6);
    expect([next[2], next[3]]).toEqual([0.58, 1]); // p2 untouched
  });
  it("clamps x into [0,1] (keeps time monotone) but leaves y free (overshoot)", () => {
    const next = handleDragToCoeff("p2", 150, -20, seg, g, cur); // x past end, y above top
    expect(next[2]).toBe(1);             // clamped
    expect(next[3]).toBeCloseTo(1.2, 6); // value 1.2 → overshoot allowed
  });
  it("flat segment (Δv==0) locks y to the current coeff, x still moves", () => {
    const flatSeg: Seg = { aTUs: 0, aVal: 5, bTUs: 1_000_000, bVal: 5 };
    const next = handleDragToCoeff("p1", 50, 10, flatSeg, { ...g, vmin: 4, vmax: 6 }, cur);
    expect(next[0]).toBeCloseTo(0.5, 6); // x moved
    expect(next[1]).toBe(cur[1]);        // y unchanged (0)
  });
});
