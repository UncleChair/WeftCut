// Zoom geometry for the timeline view: the keyboard step, the zoom-out stop,
// and the scroll offset that holds one point of the view still while the scale
// changes underneath it. Pure — the state, the key handler and the `scrollLeft`
// write live in `hooks/useTimelineView.ts`.
//
// Two gestures share this module and differ in exactly one input, the anchor:
// Ctrl+wheel holds the time under the CURSOR, the keyboard holds the PLAYHEAD
// (a key press has no pointer to hold). Everything else — the bounds, the
// re-anchor arithmetic — is the same on both paths, which is why it lives here
// once instead of twice.

import {
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC_FLOOR,
  MIN_TIMELINE_SECONDS,
  clamp,
} from "./geometry";

/// One keyboard press is one doubling. Coarse on purpose: the wheel already
/// owns fine, continuous scaling, so the keys exist to cross the range in a
/// few presses — fit-to-project to frame level is ~4 either way — and a
/// power-of-two ladder makes where the next press lands predictable.
export const KEYBOARD_ZOOM_FACTOR = 2;

/// The zoom-out stop: the scale at which the project extent (before the
/// deliberate post-roll padding) exactly fills the lane. Recomputed per
/// gesture rather than cached, so it tracks a resized panel and a project that
/// grew a clip since the last press.
///
/// `MIN_PX_PER_SEC_FLOOR` is the absolute backstop for the degenerate inputs —
/// a lane that has never laid out measures 0 and, minus the sticky header
/// column, goes negative.
export function fitPxPerSec(viewportWidthPx: number, durationUs: number): number {
  const totalSec = Math.max(durationUs / 1_000_000, MIN_TIMELINE_SECONDS);
  return Math.max(MIN_PX_PER_SEC_FLOOR, viewportWidthPx / totalSec);
}

/// `steps` doublings from `current` (negative zooms out), bounded by the
/// fit-to-project stop below and the hard ceiling above. Returns `current`
/// unchanged when already parked against the bound the press asks for, so the
/// caller can skip the re-render and the re-anchor entirely.
export function steppedPxPerSec(
  current: number,
  steps: number,
  fitMinPxPerSec: number,
): number {
  return clamp(
    current * KEYBOARD_ZOOM_FACTOR ** steps,
    fitMinPxPerSec,
    MAX_PX_PER_SEC,
  );
}

/// Which x inside the lane a keyboard zoom holds still, measured from the
/// lane's left edge — the sticky header column sits outside the scrolling body,
/// so x 0 is the first visible content pixel.
///
/// The playhead, when it is on screen. When it is NOT, the lane's centre: a
/// zoom is a magnification, not a seek. A user who scrolled away to inspect a
/// distant region and pressed `-` to widen it wants that region to widen, not
/// the view to teleport back to a playhead they deliberately left behind.
/// Bringing the playhead back is `followPlayhead.ts`'s job, and it reacts to
/// the playhead MOVING — a zoom moves no playhead.
///
/// The complement holds too, and is the property the feature is named for: an
/// anchor that starts on screen stays on screen, because `zoomedScrollLeft`
/// keeps its offset from the lane's left edge and both end-stop clamps can only
/// pull it further inside the lane.
export function zoomAnchorX(view: {
  /// The time to hold, in content px at the CURRENT scale.
  anchorPx: number;
  scrollLeftPx: number;
  viewportPx: number;
}): number {
  const { anchorPx, scrollLeftPx, viewportPx } = view;
  // Pre-measurement: no lane to be inside of, and no centre to fall back on.
  if (!(viewportPx > 0)) return 0;
  const x = anchorPx - scrollLeftPx;
  return x >= 0 && x <= viewportPx ? x : viewportPx / 2;
}

/// The scroll offset that leaves `anchorX` showing the same time it showed
/// before the scale changed. `ratio` is the new px/sec over the old.
///
/// Deliberately unclamped: the caller assigns this to `scrollLeft`, and the DOM
/// clamps it to the (post-zoom) scrollable range — which is the only place the
/// new content width is known for certain, since the canvas has just been
/// re-laid-out around it.
export function zoomedScrollLeft(view: {
  scrollLeftPx: number;
  anchorX: number;
  ratio: number;
}): number {
  const { scrollLeftPx, anchorX, ratio } = view;
  return (scrollLeftPx + anchorX) * ratio - anchorX;
}
