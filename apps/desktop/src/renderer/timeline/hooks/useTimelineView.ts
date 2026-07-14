import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { viewStateGet, viewStateSet, type TrackSummary } from "../../ipc";
import {
  DEFAULT_PX_PER_SEC,
  HEADER_COL_PX,
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC_FLOOR,
  VIEW_SAVE_DEBOUNCE_MS,
  clamp,
} from "../geometry";

/// Timeline view state: zoom (px/sec) + per-track heights, persisted to
/// `view.json` via `view_state_get`/`view_state_set`, plus the
/// Ctrl+wheel cursor-anchored zoom machinery.
export function useTimelineView(opts: {
  rootRef: React.RefObject<HTMLDivElement | null>;
  tracks: TrackSummary[];
  durationUs: number;
}): {
  pxPerSec: number;
  trackHeights: Record<string, number>;
  setTrackHeights: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  trackHeightsRef: React.MutableRefObject<Record<string, number>>;
  expandedTracks: Set<string>;
  toggleExpanded: (id: string) => void;
} {
  const { rootRef, tracks, durationUs } = opts;
  const [pxPerSec, setPxPerSec] = useState<number>(DEFAULT_PX_PER_SEC);
  const [trackHeights, setTrackHeights] = useState<Record<string, number>>({});
  // Track ids whose keyframe sub-lanes are expanded. Persisted to view.json.
  const [expandedTracks, setExpandedTracks] = useState<Set<string>>(new Set());
  // Suppress the initial post-load save: we don't want the first
  // load-then-set-state pair to immediately echo the same values back to
  // disk. Flipped to true only after the in-flight load completes.
  const viewLoadedRef = useRef<boolean>(false);

  // -------- Initial load + debounced save --------

  // One-shot load on mount. The backend returns defaults pre-workspace
  // (blank-on-boot session), so this is safe to call unconditionally.
  useEffect(() => {
    let cancelled = false;
    viewStateGet()
      .then((state) => {
        if (cancelled) return;
        setPxPerSec(
          clamp(
            state.timeline_px_per_sec,
            MIN_PX_PER_SEC_FLOOR,
            MAX_PX_PER_SEC,
          ),
        );
        setTrackHeights(state.track_heights ?? {});
        setExpandedTracks(new Set(state.expanded_tracks ?? []));
      })
      .catch((e) => {
        console.warn("view_state load failed:", e);
      })
      .finally(() => {
        if (!cancelled) viewLoadedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced persist. Refs hold the latest values so the timer doesn't
  // need to restart with React's render cadence on every wheel tick.
  const pxPerSecRef = useRef(pxPerSec);
  const trackHeightsRef = useRef(trackHeights);
  const expandedTracksRef = useRef(expandedTracks);
  // Latest project duration — the wheel handler reads this to compute
  // the "fit-to-viewport" min zoom each tick, so a project getting
  // longer (new clips added) immediately widens the wheel-out range.
  const durationUsRef = useRef(durationUs);
  useEffect(() => {
    pxPerSecRef.current = pxPerSec;
  }, [pxPerSec]);
  useEffect(() => {
    trackHeightsRef.current = trackHeights;
  }, [trackHeights]);
  useEffect(() => {
    expandedTracksRef.current = expandedTracks;
  }, [expandedTracks]);
  useEffect(() => {
    durationUsRef.current = durationUs;
  }, [durationUs]);

  useEffect(() => {
    if (!viewLoadedRef.current) return;
    const handle = setTimeout(() => {
      // Prune dead track ids on save so view.json doesn't accumulate
      // entries for tracks the user has deleted (the state map keeps
      // stale keys until we filter on the way out).
      const live = new Set(tracks.map((t) => t.id));
      const pruned: Record<string, number> = {};
      for (const [id, h] of Object.entries(trackHeightsRef.current)) {
        if (live.has(id)) pruned[id] = h;
      }
      const liveExpanded = [...expandedTracksRef.current].filter((id) =>
        live.has(id),
      );
      viewStateSet({
        timeline_px_per_sec: pxPerSecRef.current,
        track_heights: pruned,
        expanded_tracks: liveExpanded,
      }).catch((e) => console.warn("view_state save failed:", e));
    }, VIEW_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // `tracks` participates so a track-deletion triggers a save that
    // prunes the stale id even if neither zoom nor height changed.
  }, [pxPerSec, trackHeights, expandedTracks, tracks]);

  // -------- Ctrl+wheel zoom (cursor-anchored) --------

  // We capture { scrollLeft, cursorXInViewport, oldPxPerSec } when the
  // wheel fires, kick off `setPxPerSec`, and apply the new scrollLeft
  // in a useLayoutEffect once React has re-rendered with the new
  // px/sec. Doing it inline in the handler reads stale state and
  // produces a one-frame jitter.
  const wheelPendingRef = useRef<{
    scrollLeft: number;
    cursorXInViewport: number;
    oldPxPerSec: number;
  } | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // React's JSX `onWheel` is registered passive in modern React, so
    // `preventDefault()` from there silently fails. Attach manually
    // with `{ passive: false }` so we can swallow the default
    // page-scroll behaviour when Ctrl is held.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = root.getBoundingClientRect();
      // The root's left edge starts under the sticky track-header
      // column, which doesn't scroll — measure the cursor from the
      // scrolling body's left edge instead so the re-anchor math
      // holds.
      const cursorXInViewport = e.clientX - rect.left - HEADER_COL_PX;
      // deltaMode varies by device — normalise lines/pages to pixels
      // before computing the zoom factor.
      const lineHeight = 16;
      const pageHeight = 100;
      const px =
        e.deltaY *
        (e.deltaMode === 1 ? lineHeight : e.deltaMode === 2 ? pageHeight : 1);
      // Exponential zoom: small wheel ticks scale by ~ε near 1.0, big
      // ones don't snap-jump. Negative px (scrolling up) zooms in.
      const factor = Math.exp(-px * 0.001);
      const oldPxPerSec = pxPerSecRef.current;
      // Lower bound = "fit-to-viewport" zoom — the level at which the
      // whole timeline exactly fills the visible width. Beyond this
      // there's only empty space to the right of the content, so this
      // is the natural Ctrl+wheel stop for max zoom-out. Recomputed
      // every tick so it tracks viewport resize + project growth.
      // The sticky header column occupies the first HEADER_COL_PX of
      // the viewport; only the remaining lane area should fit the
      // whole timeline at min zoom.
      const viewportWidth = root.clientWidth - HEADER_COL_PX;
      const totalSec = Math.max(durationUsRef.current / 1_000_000, 5);
      const fitMin = Math.max(
        MIN_PX_PER_SEC_FLOOR,
        viewportWidth / totalSec,
      );
      const newPxPerSec = clamp(oldPxPerSec * factor, fitMin, MAX_PX_PER_SEC);
      if (newPxPerSec === oldPxPerSec) return;
      wheelPendingRef.current = {
        scrollLeft: root.scrollLeft,
        cursorXInViewport,
        oldPxPerSec,
      };
      setPxPerSec(newPxPerSec);
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      root.removeEventListener("wheel", onWheel);
    };
  }, [rootRef]);

  // Re-anchor scroll position so the time under the cursor stays put.
  // Runs synchronously after the layout flip so there's no flash.
  useLayoutEffect(() => {
    const pending = wheelPendingRef.current;
    if (!pending) return;
    wheelPendingRef.current = null;
    const root = rootRef.current;
    if (!root) return;
    const ratio = pxPerSec / pending.oldPxPerSec;
    root.scrollLeft =
      (pending.scrollLeft + pending.cursorXInViewport) * ratio -
      pending.cursorXInViewport;
  }, [pxPerSec, rootRef]);

  const toggleExpanded = useCallback(
    (id: string) =>
      setExpandedTracks((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      }),
    [],
  );

  return {
    pxPerSec,
    trackHeights,
    setTrackHeights,
    trackHeightsRef,
    expandedTracks,
    toggleExpanded,
  };
}
