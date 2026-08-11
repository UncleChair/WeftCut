// Page-scroll geometry for "follow the playhead": given where the playhead is
// and where the view sits, decide whether the view should jump, and to what
// offset. Pure — the DOM side (when to ask, what to do with the answer) lives
// in `hooks/useFollowPlayhead.ts`.
//
// Paging, not tracking. The alternative — pinning the playhead to a fixed
// column and sliding the content under it — rewrites `scrollLeft` on every
// composition frame, and every write publishes to `timelineScrollStore` and
// re-renders the ruler. Paging touches the view once per screenful, which is
// also the convention the user already knows from Premiere/FCP.

/// Distance from a viewport edge at which the playhead counts as "at" it.
/// Wide enough to cover the playhead head's triangle (it overhangs the line by
/// ~7 px each way), so the jump fires before the marker is visibly clipped.
const EDGE_PAD_PX = 12;

/// Where the playhead lands after a jump, as a fraction of the viewport — a
/// margin, not a centring. Its job is to leave a sliver of already-played
/// context behind the marker; anything larger just throws away lookahead, which
/// is the whole point of paging forward.
const LEAD_RATIO = 0.08;

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(Math.max(v, lo), hi);

export interface FollowViewport {
  /// Playhead position in content px — `timeUs / 1e6 * pxPerSec`, the same
  /// coordinate space as `scrollLeftPx` (the sticky header column is outside
  /// the scrolling body, so it offsets neither).
  playheadPx: number;
  scrollLeftPx: number;
  /// Visible lane width — the scroll root's `clientWidth` MINUS the sticky
  /// header column, which overlays the left edge and hides content under it.
  viewportPx: number;
  /// `scrollWidth - clientWidth`. Clamping against it here (rather than letting
  /// the DOM clamp the assignment) is what lets the caller compare the returned
  /// offset with the current one and skip a no-op write.
  maxScrollLeftPx: number;
}

/// The offset to page to, or `null` when the view already holds the playhead
/// comfortably — the answer on all but one frame in a screenful, so callers can
/// treat `null` as "nothing to do" on the per-frame path.
///
/// Backward moves page by a full screen rather than by a lead, landing the
/// playhead near the RIGHT edge: the gesture that ran the playhead off the left
/// edge (frame-stepping back, seeking to a previous edit) is one the user
/// repeats, and a lead-sized jump would re-page on the very next press.
export function followPageScrollLeft(view: FollowViewport): number | null {
  const { playheadPx, scrollLeftPx, viewportPx, maxScrollLeftPx } = view;
  // Pre-measurement (a panel that has never laid out) and degenerate widths:
  // no window to be outside of.
  if (!(viewportPx > 0)) return null;
  const lead = clamp(viewportPx * LEAD_RATIO, EDGE_PAD_PX, viewportPx / 2);

  let target: number;
  if (playheadPx > scrollLeftPx + viewportPx - EDGE_PAD_PX) {
    target = playheadPx - lead;
  } else if (playheadPx < scrollLeftPx + EDGE_PAD_PX) {
    target = playheadPx - (viewportPx - lead);
  } else {
    return null;
  }

  const clamped = clamp(target, 0, Math.max(0, maxScrollLeftPx));
  // Already parked against an end stop — the playhead sits in the pad band and
  // no scroll can improve that. Returning the current offset would make every
  // subsequent frame a write.
  return clamped === scrollLeftPx ? null : clamped;
}
