// Pure helpers for the easing editor: the named-preset table, interp→coeff
// mapping, and pixel-handle ↔ normalized-coefficient conversion for the curve
// canvas. The canvas is a `size`×`size` px box; x maps left→right [0,1]; y is
// inverted (top = 1, bottom = 0) and NOT clamped (overshoot allowed). Handle x
// IS clamped to [0,1] so the bezier X stays monotone (solver single-valued).
import type { Interpolation } from "../ipc";

export interface Preset {
  id: "linear" | "ease" | "ease_in" | "ease_out" | "ease_in_out" | "hold";
  labelKey: string;
  interp: Interpolation;
}

export const PRESETS: Preset[] = [
  { id: "linear", labelKey: "keyframe.interp_linear", interp: { kind: "Linear" } },
  { id: "ease", labelKey: "keyframe.interp_ease", interp: { kind: "Bezier", p1: [0.25, 0.1], p2: [0.25, 1] } },
  { id: "ease_in", labelKey: "keyframe.interp_ease_in", interp: { kind: "EaseIn" } },
  { id: "ease_out", labelKey: "keyframe.interp_ease_out", interp: { kind: "EaseOut" } },
  { id: "ease_in_out", labelKey: "keyframe.interp_ease_in_out", interp: { kind: "Bezier", p1: [0.42, 0], p2: [0.58, 1] } },
  { id: "hold", labelKey: "keyframe.interp_hold", interp: { kind: "Hold" } },
];

export function interpToCoeffs(interp: Interpolation): [number, number, number, number] {
  switch (interp.kind) {
    case "Bezier":
      return [interp.p1[0], interp.p1[1], interp.p2[0], interp.p2[1]];
    case "EaseIn":
      return [0.42, 0, 1, 1];
    case "EaseOut":
      return [0, 0, 0.58, 1];
    default:
      return [0, 0, 1, 1]; // Linear / Hold → diagonal (Hold canvas is disabled)
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
