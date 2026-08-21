// What a text box did to a layer's font size, and the search that decides it.
// Imports no Pixi: the measurement is injected, so the search is testable
// without a canvas and the gizmo and the inspector can read its result without
// learning what Pixi is. `TextSprite` supplies the measurement and owns the
// style that renders; the UI consumes the result through `GizmoProbe`.
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

/// Slack allowed when comparing the measured block against the box, so a block
/// that lands exactly on the box edge counts as fitting. It absorbs the float
/// error of summed glyph advances and nothing else, so it stays far below the
/// one pixel that would let a visibly clipped line pass.
const FIT_EPS = 1e-6;

/// A candidate size's cost, in the box's units (composition px, pre-`scale`).
export interface MeasuredBlock {
  w: number;
  h: number;
}

export interface FitSearch {
  /// The size the user set. Returned unrounded when it already fits, so a box
  /// with room to spare renders bit-for-bit what it rendered before the box
  /// existed.
  authoredPx: number;
  boxW: number;
  boxH: number;
  /// The block's extent at one candidate size. Stroke and drop shadow are
  /// already inside it — `CanvasTextMetrics` adds the stroke width and the
  /// shadow's distance to the width it reports — so the caller must not pad for
  /// the outline a second time, and the outline it measures has to be the
  /// SCALED one or the fit test would answer for a frame nobody renders.
  measure: (px: number) => MeasuredBlock;
}

/// The largest font size whose measured block fits `(boxW, boxH)` — Fixed mode's
/// answer to text that does not fit. Derived per style change and never stored:
/// state keeps exactly one font size, the one the user set (ADR 0049).
///
/// Searched over WHOLE pixels. A fractional bisection would need a termination
/// epsilon to tune and could mint an unbounded set of sizes, each one a fresh
/// entry in `CanvasTextMetrics`'s measurement cache; integers terminate on the
/// range itself in ~log2(authored) probes, and every probe is a size the
/// inspector can name ("auto-reduced to 31 px").
///
/// Premise of the bisection: `measure` is monotone in `px`. Glyph advances scale
/// with the size, so a smaller size never yields a wider or taller block — with
/// wrapping it yields fewer, shorter lines, which is shrink and wrap composing
/// rather than fighting.
export function fitFontSize(s: FitSearch): TextFit {
  const { authoredPx, boxW, boxH } = s;
  const fits = (px: number): boolean => {
    const m = s.measure(px);
    return m.w <= boxW + FIT_EPS && m.h <= boxH + FIT_EPS;
  };
  // Not a size to bisect toward — a hand-edited project, which still has to
  // render something rather than take the sprite down.
  if (!Number.isFinite(authoredPx) || authoredPx <= 0) {
    return { authoredPx, effectivePx: authoredPx, overflowing: false };
  }
  if (fits(authoredPx)) return { authoredPx, effectivePx: authoredPx, overflowing: false };
  // The authored size is now known not to fit, so an integer one excludes itself
  // from the range below.
  let hi = Number.isInteger(authoredPx) ? authoredPx - 1 : Math.floor(authoredPx);
  // `TEXT_BOX_MIN_PX` is a floor on SHRINKING, never a size to grow toward: a
  // 6 px caption in a box too small for it overflows at 6 px rather than being
  // enlarged to 8, because no box drag may make text bigger than it was set.
  if (hi < TEXT_BOX_MIN_PX) return { authoredPx, effectivePx: authoredPx, overflowing: true };
  let lo = TEXT_BOX_MIN_PX;
  let best = -1;
  while (lo <= hi) {
    const mid = lo + ((hi - lo) >> 1);
    if (fits(mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Nothing down to the floor fits: render AT the floor and say so. Continuing
  // is the one thing this must not do — 4 px text is not a smaller version of
  // the feature, it is a frame nobody can read.
  return best < 0
    ? { authoredPx, effectivePx: TEXT_BOX_MIN_PX, overflowing: true }
    : { authoredPx, effectivePx: best, overflowing: false };
}
