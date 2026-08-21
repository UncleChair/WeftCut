// The two facts about a text box that both the renderer and the UI need, kept
// in a module neither has to import Pixi to read. `TextSprite` derives the fit;
// the gizmo and the inspector consume it through `GizmoProbe`.
// See ADR 0049.

/// Smallest font size shrink-to-fit will produce, and the smallest `box_w` a
/// drag will leave behind — one number, because a box the user cannot see is the
/// same failure as text they cannot read.
///
/// ABSOLUTE, not a fraction of the authored size, and that is the whole point: a
/// proportional floor would crush 12 px text to 3 px while leaving 96 px text
/// legible, so one setting would behave differently at different sizes. At the
/// floor the text overflows and says so rather than shrinking further.
///
/// Deliberately NOT enforced at the MCP boundary (`mutations/params.ts` refuses
/// only a non-positive box): this is a drag ergonomic, and a 4 px box an agent
/// asks for on purpose is legal, just silly.
export const TEXT_BOX_MIN_PX = 8;

/// What the renderer actually did with a Text layer's font size, read back for
/// display. One struct rather than two probe calls, because the inspector's
/// "auto-reduced to N px" and the gizmo's stroke colour must never disagree
/// about the same frame.
export interface TextFit {
  /// The size stored on the layer — echoed back from the view the sprite
  /// rendered, not re-read from the mirror, so a comparison against
  /// `effectivePx` cannot straddle two generations of state.
  authoredPx: number;
  /// The size that reached the frame. Equal to `authoredPx` outside Fixed mode
  /// and whenever Fixed already fits.
  effectivePx: number;
  /// Fixed mode hit `TEXT_BOX_MIN_PX` and the text still does not fit, so it is
  /// spilling out of its box. Distinct from "shrunk": shrinking is the feature
  /// working, overflow is it having run out of room.
  overflowing: boolean;
}

/// Whether the rendered size differs from the authored one — the condition the
/// inspector's reduced-size notice and the gizmo's stroke both key off. A
/// function so the tolerance lives in one place: the fit is the result of a
/// search over integers today, but a fractional result must not make the notice
/// flicker on a layer that fits.
export function isShrunk(fit: TextFit): boolean {
  return fit.effectivePx < fit.authoredPx - 1e-6;
}
