// Timeline horizontal-scroll fan-out. `scrollLeftPx` moves at wheel/drag rate,
// so it follows the same rule as the playhead time (see playheadStore.ts):
// NOTHING at event rate may live in React state above a leaf. A
// `useState(scrollLeft)` on the timeline root would re-render every track lane,
// keyframe sub-lane and layer chip on every wheel tick — the regression class
// e2e/scripts/memory-ratchet.mjs exists to catch.
//
// Timeline's scroll container publishes here (rAF-coalesced); TimelineRuler is
// the only subscriber and re-renders alone, which is what lets its tick set
// follow the viewport instead of spanning the whole project.

import { create } from "zustand";

interface State {
  /// Row-local px offset of the visible lane area's left edge — the timeline
  /// scroll root's `scrollLeft`. 0 while no timeline is mounted.
  scrollLeftPx: number;
}

export const useTimelineScrollStore = create<State>(() => ({
  scrollLeftPx: 0,
}));

/// Publish the scroll offset. Guarded so a repeated value (a scroll event that
/// only moved vertically, a remount seeding the same offset) is not a store
/// write, and so a subscriber never has to defend against NaN.
export function setTimelineScrollLeftPx(px: number): void {
  const next = Number.isFinite(px) ? Math.max(0, px) : 0;
  if (useTimelineScrollStore.getState().scrollLeftPx !== next) {
    useTimelineScrollStore.setState({ scrollLeftPx: next });
  }
}

/// Imperative read, for mount-time seeding and event-time consumers.
export function timelineScrollLeftPx(): number {
  return useTimelineScrollStore.getState().scrollLeftPx;
}
