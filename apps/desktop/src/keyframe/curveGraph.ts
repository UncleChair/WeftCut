// Pure value-graph geometry for the inline keyframe curve editor. Maps the
// stored per-segment cubic-bezier easing (Model B Bezier{p1,p2}) into the
// (time, value) pixel space of a timeline sub-lane, and back, for rendering
// and in-place tangent-handle editing. DOM-free — all geometry is explicit
// args so it unit-tests headless. UI-only (no Rust mirror).
import type { Interpolation, Keyframe } from "../ipc";
import { unitBezier } from "../render/animated";
import { interpToCoeffs } from "./curve";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface CurveGeom {
  /// zoom: timeline pixels per second.
  pxPerSec: number;
  /// layer start on the ruler (µs); keyframe t_us is layer-local.
  layerTStartUs: number;
  /// drawable lane height (px); curve fills [0, height], y-down.
  height: number;
  /// value-axis range mapped onto [0, height].
  vmin: number;
  vmax: number;
}

export interface Pt { x: number; y: number; }

/// Absolute ruler x (px) of a layer-local time. Same formula as
/// geometry.ts::keyframeAbsoluteX (inlined to keep this module DOM-free).
export function timeToXPx(tUsLocal: number, g: CurveGeom): number {
  return ((g.layerTStartUs + tUsLocal) / 1_000_000) * g.pxPerSec;
}

/// Inverse of timeToXPx → layer-local µs.
export function xPxToTimeUs(px: number, g: CurveGeom): number {
  return (px / g.pxPerSec) * 1_000_000 - g.layerTStartUs;
}

/// value → y px (higher value → smaller y).
export function valueToY(v: number, g: CurveGeom): number {
  const span = g.vmax - g.vmin;
  if (span <= 0) return g.height / 2;
  return ((g.vmax - v) / span) * g.height;
}

/// y px → value.
export function yToValue(py: number, g: CurveGeom): number {
  const span = g.vmax - g.vmin;
  if (span <= 0) return g.vmin;
  return g.vmax - (py / g.height) * span;
}

/// Min/max of the *rendered* value curve across all segments (samples eased
/// values so overshoot y∉[0,1] is included), padded so extremes aren't flush
/// to the lane edge. Degenerate all-equal → a nominal ± band.
export function computeValueRange(
  keys: Pick<Keyframe<number>, "t_us" | "value" | "interp">[],
  padFrac = 0.1,
  samplesPerSeg = 32,
): { vmin: number; vmax: number } {
  if (keys.length === 0) return { vmin: 0, vmax: 1 };
  let lo = Infinity;
  let hi = -Infinity;
  const note = (v: number) => {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  };
  for (let i = 0; i < keys.length; i++) {
    note(keys[i]!.value);
    if (i < keys.length - 1) {
      const a = keys[i]!;
      const b = keys[i + 1]!;
      const dv = b.value - a.value;
      const curved = a.interp.kind !== "Hold" && a.interp.kind !== "Linear";
      if (curved && dv !== 0) {
        const [x1, y1, x2, y2] = interpToCoeffs(a.interp);
        for (let s = 1; s < samplesPerSeg; s++) {
          note(a.value + unitBezier(x1, y1, x2, y2, s / samplesPerSeg) * dv);
        }
      }
    }
  }
  if (!isFinite(lo) || !isFinite(hi)) return { vmin: 0, vmax: 1 };
  if (hi === lo) {
    const half = Math.max(1, Math.abs(hi) * 0.1);
    return { vmin: lo - half, vmax: hi + half };
  }
  const pad = (hi - lo) * padFrac;
  return { vmin: lo - pad, vmax: hi + pad };
}

export interface Seg {
  aTUs: number;
  aVal: number;
  bTUs: number;
  bVal: number;
}

/// Pixel polyline for one segment's value curve. Hold → flat then vertical
/// step; Linear → straight; curved → sampled through unitBezier.
export function segmentPolyline(
  seg: Seg,
  interp: Interpolation,
  g: CurveGeom,
  samples = 24,
): Pt[] {
  const xa = timeToXPx(seg.aTUs, g);
  const xb = timeToXPx(seg.bTUs, g);
  const ya = valueToY(seg.aVal, g);
  const yb = valueToY(seg.bVal, g);
  if (interp.kind === "Hold") return [{ x: xa, y: ya }, { x: xb, y: ya }, { x: xb, y: yb }];
  if (interp.kind === "Linear") return [{ x: xa, y: ya }, { x: xb, y: yb }];
  const [x1, y1, x2, y2] = interpToCoeffs(interp);
  const dv = seg.bVal - seg.aVal;
  const out: Pt[] = [];
  for (let s = 0; s <= samples; s++) {
    const u = s / samples;
    const v = seg.aVal + unitBezier(x1, y1, x2, y2, u) * dv;
    out.push({ x: xa + (xb - xa) * u, y: valueToY(v, g) });
  }
  return out;
}

/// Tangent-handle control points (px) for a segment, or null for Hold/Linear
/// (no editable handles — pick a curved preset to start easing).
export function segmentHandles(
  seg: Seg,
  interp: Interpolation,
  g: CurveGeom,
): { p1: Pt; p2: Pt } | null {
  if (interp.kind === "Hold" || interp.kind === "Linear") return null;
  const [x1, y1, x2, y2] = interpToCoeffs(interp);
  const xa = timeToXPx(seg.aTUs, g);
  const xb = timeToXPx(seg.bTUs, g);
  const dv = seg.bVal - seg.aVal;
  return {
    p1: { x: xa + (xb - xa) * x1, y: valueToY(seg.aVal + y1 * dv, g) },
    p2: { x: xa + (xb - xa) * x2, y: valueToY(seg.aVal + y2 * dv, g) },
  };
}

/// New full coeffs after dragging one control point to (pointerXPx, pointerYPx).
/// `x` clamps to [0,1] (time stays monotone → bezier solver single-valued);
/// `y` is free (overshoot allowed). On a flat segment (Δv==0) the y cannot be
/// inferred from value, so keep the dragged point's current y.
export function handleDragToCoeff(
  which: "p1" | "p2",
  pointerXPx: number,
  pointerYPx: number,
  seg: Seg,
  g: CurveGeom,
  current: [number, number, number, number],
): [number, number, number, number] {
  const dt = seg.bTUs - seg.aTUs;
  const dv = seg.bVal - seg.aVal;
  const tLocal = xPxToTimeUs(pointerXPx, g);
  const cx = dt === 0
    ? (which === "p1" ? current[0] : current[2])
    : clamp01((tLocal - seg.aTUs) / dt);
  const curY = which === "p1" ? current[1] : current[3];
  const cy = dv === 0 ? curY : (yToValue(pointerYPx, g) - seg.aVal) / dv;
  return which === "p1"
    ? [cx, cy, current[2], current[3]]
    : [current[0], current[1], cx, cy];
}
