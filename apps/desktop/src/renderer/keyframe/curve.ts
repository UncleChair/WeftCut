// Pure helpers for the easing editor: spline-only interp→coeff mapping and
// pixel-handle ↔ normalized-coefficient conversion for the curve canvas. The
// canvas is a `size`×`size` px box; x maps left→right [0,1]; y is inverted
// (top = 1, bottom = 0) and NOT clamped (overshoot allowed). Handle x IS
// clamped to [0,1] so the bezier X stays monotone (solver single-valued).
// The preset gallery reads the canonical table (src/shared/easing.ts)
// directly — this module owns no preset data.
import type { Interpolation } from "../../shared/easing";

/// The segment kinds whose curve IS a cubic spline — the only kinds with
/// draggable tangent handles. Procedural kinds (Elastic/Bounce) have no
/// coefficient representation and must never reach `interpToCoeffs`;
/// they render as a read-only sampled curve (curveGraph.ts).
export type SplineInterpolation = Extract<Interpolation, { kind: "Hold" | "Linear" | "Bezier" }>;

export function isSplineInterp(i: Interpolation): i is SplineInterpolation {
  return i.kind === "Hold" || i.kind === "Linear" || i.kind === "Bezier";
}

/// Glyph modifier class for a keyframe's outgoing interpolation — the NLE
/// convention (diamond = linear, square = hold, circle = eased) so interp
/// state reads at a glance without opening the easing menu. "" keeps the base
/// .kf-diamond shape; shared by the collapsed in-clip row and the sub-lane
/// curve editor so both surfaces speak the same glyph language.
export function interpGlyphClass(kind: Interpolation["kind"]): "" | "kf-interp-hold" | "kf-interp-eased" {
  if (kind === "Hold") return "kf-interp-hold";
  if (kind === "Linear") return "";
  return "kf-interp-eased";
}

/// Spline interp → cubic-bezier control coords for handle placement.
/// Exhaustive over `SplineInterpolation` — no default arm, so a new kind is a
/// compile error here rather than a silent identity diagonal.
export function interpToCoeffs(interp: SplineInterpolation): [number, number, number, number] {
  switch (interp.kind) {
    case "Bezier":
      return [interp.p1[0], interp.p1[1], interp.p2[0], interp.p2[1]];
    case "Hold":
    case "Linear":
      return [0, 0, 1, 1]; // identity diagonal (Hold canvas is disabled)
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/// px (origin top-left, y down) → normalized coeff (x∈[0,1] clamped, y free, up=+).
export function handleToCoeff(px: number, py: number, size: number): [number, number] {
  return [clamp01(px / size), 1 - py / size];
}

/// normalized coeff → px (origin top-left).
export function coeffToHandle(cx: number, cy: number, size: number): [number, number] {
  return [cx * size, (1 - cy) * size];
}
