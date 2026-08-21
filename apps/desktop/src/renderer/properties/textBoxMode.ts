// The inspector's half of "the resize mode IS the box nullability" (ADR 0049):
// there is no stored mode to read, so the segmented control derives its
// selection from `box_w`/`box_h` and every selection writes the pair that
// defines it. Pure — the row that renders it lives in `PropertyPanel`'s
// `TextFields`.

import { TEXT_BOX_MIN_PX } from "../render/textBox";

/// Least constrained first, so moving right down the control adds a constraint:
/// Auto height wraps, Fixed wraps and shrinks.
export const TEXT_BOX_MODES = ["auto_width", "auto_height", "fixed"] as const;

export type TextBoxMode = (typeof TEXT_BOX_MODES)[number];

/// One box extent as the RENDERER reads it: a non-positive or non-finite number
/// is not a narrow box, it is no box — `TextSprite` lays out Auto width from it —
/// so the panel must agree or it would label an auto-width picture "Fixed".
function axis(v: number | null): number | null {
  return v !== null && Number.isFinite(v) && v > 0 ? v : null;
}

/// Which mode a box pair reads as. `(null, set)` is not a fourth mode: it answers
/// Auto width, the same coalescing `TextSprite` applies, so a hand-edited project
/// shows the mode it actually renders in rather than a state the UI cannot leave.
export function textBoxModeOf(boxW: number | null, boxH: number | null): TextBoxMode {
  if (axis(boxW) === null) return "auto_width";
  return axis(boxH) === null ? "auto_height" : "fixed";
}

/// A measured extent turned into a box number: rounded, because a box the
/// inspector authors reads as whole pixels, and floored at the drag floor so
/// measuring a near-empty line cannot propose a box nobody can see.
function fromMeasured(v: number | undefined): number | null {
  return v !== undefined && Number.isFinite(v) && v > 0
    ? Math.max(TEXT_BOX_MIN_PX, Math.round(v))
    : null;
}

/// The box pair that puts a layer in `mode`, or null when `mode` needs an extent
/// that neither the layer nor `measured` (`GizmoProbe.naturalSizeOf`) carries.
///
/// Both axes are always present in the result, and on the way out of Fixed that
/// is the whole point: the mutation layer refuses a patch that would leave
/// `(null, set)`, so `{ box_w: null }` alone is a refusal — Auto width has to
/// null both in ONE commit.
///
/// Null rather than a fallback number is deliberate. The panel cannot measure
/// glyphs, and 0 / NaN are precisely what the mutation layer refuses, so an
/// unreachable mode is offered as unreachable instead of guessed at.
export function textBoxPatchFor(
  mode: TextBoxMode,
  current: { boxW: number | null; boxH: number | null },
  measured: { w: number; h: number } | null,
): { box_w: number | null; box_h: number | null } | null {
  if (mode === "auto_width") return { box_w: null, box_h: null };
  // The layer's own extent wins over the measurement: changing mode must not
  // silently re-round a width a drag put there.
  const w = axis(current.boxW) ?? fromMeasured(measured?.w);
  if (w === null) return null;
  if (mode === "auto_height") return { box_w: w, box_h: null };
  const h = axis(current.boxH) ?? fromMeasured(measured?.h);
  return h === null ? null : { box_w: w, box_h: h };
}
