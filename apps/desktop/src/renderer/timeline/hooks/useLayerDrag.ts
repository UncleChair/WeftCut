import { useCallback, useEffect, useMemo, useState } from "react";
import {
  moveLayer,
  trimLayer,
  type GroupSummary,
  type LayerSummary,
  type TrackSummary,
} from "../../ipc";
import { snapFrameRound } from "../../frames";
import { MIN_LAYER_DURATION_US, type VisualTrack } from "../geometry";
import { type DragState, type PendingLayerPlacement } from "../LayerBlock";
import { snapDragDeltaToTimelineBoundary } from "../snapping";

/// Tracks are kind-agnostic: any layer can land on any track. This
/// reject hook always accepts; routing is by LayerParams, not track
/// kind. See docs/data-model.md (kind-agnostic tracks) / ADR 0023.
function trackAcceptsForLayer(_target: TrackSummary, _drag: DragState): boolean {
  return true;
}

/// Layer drag state machine (move / trim-start / trim-end): ghost
/// tracking via window pointermove, frame + timeline-boundary snapping,
/// and the commit-on-pointerup switch that lowers to
/// `moveLayer`/`trimLayer`.
export function useLayerDrag(opts: {
  tracks: TrackSummary[];
  groups: GroupSummary[];
  groupByLayerId: Map<string, string>;
  orderedTracks: VisualTrack[];
  trackRows: { track: TrackSummary; y: number; height: number }[];
  canvasRef: React.RefObject<HTMLDivElement | null>;
  pxPerSec: number;
  currentTimeUs: number;
  fpsNum: number;
  fpsDen: number;
  tailSnapEnabled: boolean;
  tailSnapStrengthPx: number;
  onMutated: () => Promise<void>;
}): {
  drag: DragState | null;
  setDrag: (s: DragState | null) => void;
  pendingPlacement: PendingLayerPlacement | null;
  pendingLayer: LayerSummary | null;
  dragLayer: LayerSummary | null;
} {
  const {
    tracks,
    groups,
    groupByLayerId,
    orderedTracks,
    trackRows,
    canvasRef,
    pxPerSec,
    currentTimeUs,
    fpsNum,
    fpsDen,
    tailSnapEnabled,
    tailSnapStrengthPx,
    onMutated,
  } = opts;
  const [drag, setDrag] = useState<DragState | null>(null);
  const [pendingPlacement, setPendingPlacement] =
    useState<PendingLayerPlacement | null>(null);

  const pendingLayer = useMemo(() => {
    if (!pendingPlacement) return null;
    for (const track of tracks) {
      const layer = track.layers.find(
        (candidate) => candidate.id === pendingPlacement.layerId,
      );
      if (layer) return layer;
    }
    return null;
  }, [pendingPlacement, tracks]);

  const dragLayer = useMemo(() => {
    if (!drag || drag.kind !== "move") return null;
    for (const track of tracks) {
      const layer = track.layers.find(
        (candidate) => candidate.id === drag.layerId,
      );
      if (layer) return layer;
    }
    return null;
  }, [drag?.kind, drag?.layerId, tracks]);

  useEffect(() => {
    if (!pendingPlacement) return;
    const track = tracks.find((t) => t.id === pendingPlacement.trackId);
    const layer = track?.layers.find((l) => l.id === pendingPlacement.layerId);
    if (
      layer &&
      layer.t_start_us === pendingPlacement.tStartUs &&
      layer.t_end_us === pendingPlacement.tEndUs
    ) {
      setPendingPlacement(null);
    }
  }, [pendingPlacement, tracks]);

  const visibleSnapTracks = useMemo(
    () => orderedTracks.map(({ track }) => track),
    [orderedTracks],
  );

  // -------- Layer drag (move / trim) --------

  const trackUnderPointer = useCallback(
    (clientY: number): TrackSummary | null => {
      if (!canvasRef.current) return null;
      const rect = canvasRef.current.getBoundingClientRect();
      const y = clientY - rect.top;
      for (const row of trackRows) {
        if (y >= row.y && y < row.y + row.height) return row.track;
      }
      return null;
    },
    [trackRows],
  );

  /// Snap a raw drag delta so the dragged edge / clip-start lands on
  /// a composition-frame boundary. Snapping the DESTINATION (not the
  /// delta itself) handles the case where the source value was
  /// already off-grid: we always end up on grid regardless of the
  /// pre-state. Returns the adjusted deltaUs.
  const snapDragDelta = useCallback(
    (kind: DragState["kind"], originalTStart: number, originalTEnd: number, rawDeltaUs: number): number => {
      const anchor = kind === "trim-end" ? originalTEnd : originalTStart;
      const snappedDest = snapFrameRound(anchor + rawDeltaUs, fpsNum, fpsDen);
      return snappedDest - anchor;
    },
    [fpsNum, fpsDen],
  );

  const snapDeltaToTimelineBoundary = useCallback(
    (
      state: DragState,
      frameDeltaUs: number,
    ): number => {
      return snapDragDeltaToTimelineBoundary({
        state,
        frameDeltaUs,
        visibleTracks: visibleSnapTracks,
        groups,
        groupByLayerId,
        currentTimeUs,
        fpsNum,
        fpsDen,
        pxPerSec,
        enabled: tailSnapEnabled,
        strengthPx: tailSnapStrengthPx,
      });
    },
    [
      currentTimeUs,
      fpsNum,
      fpsDen,
      groupByLayerId,
      groups,
      pxPerSec,
      tailSnapEnabled,
      tailSnapStrengthPx,
      visibleSnapTracks,
    ],
  );

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (!drag) return;
      const deltaPx = e.clientX - drag.startX;
      const rawDeltaUs = (deltaPx / pxPerSec) * 1_000_000;
      const frameDeltaUs = snapDragDelta(
        drag.kind,
        drag.originalTStart,
        drag.originalTEnd,
        rawDeltaUs,
      );
      const overTrack =
        drag.kind === "move" ? trackUnderPointer(e.clientY) : null;
      const deltaUs = snapDeltaToTimelineBoundary(drag, frameDeltaUs);
      setDrag({
        ...drag,
        deltaUs,
        overTrackId: overTrack?.id ?? null,
      });
    },
    [drag, pxPerSec, snapDragDelta, snapDeltaToTimelineBoundary, trackUnderPointer],
  );

  const handlePointerUp = useCallback(
    async (e: PointerEvent) => {
      if (!drag) return;
      const deltaPx = e.clientX - drag.startX;
      const rawDeltaUs = Math.round((deltaPx / pxPerSec) * 1_000_000);
      const frameDeltaUs = snapDragDelta(
        drag.kind,
        drag.originalTStart,
        drag.originalTEnd,
        rawDeltaUs,
      );
      const overTrack =
        drag.kind === "move" ? trackUnderPointer(e.clientY) : null;
      const deltaUs = snapDeltaToTimelineBoundary(drag, frameDeltaUs);
      const committed = drag;
      setDrag(null);

      // Treat tiny deltas + same track as a no-op so a click doesn't accidentally
      // shove a layer one frame.
      const sameTrack =
        !overTrack || overTrack.id === committed.trackId;
      if (Math.abs(deltaUs) < 1_000 && sameTrack) return;

      try {
        // `docs/groups.md` — Alt-held at drag start opts the move /
        // trim out of group fanout for this single op.
        const escape = committed.escapeGroup;
        switch (committed.kind) {
          case "move": {
            const newStart = Math.max(0, committed.originalTStart + deltaUs);
            const newEnd =
              newStart + (committed.originalTEnd - committed.originalTStart);
            const destTrackId =
              overTrack && trackAcceptsForLayer(overTrack, committed)
                ? overTrack.id
                : committed.trackId;
            setPendingPlacement({
              layerId: committed.layerId,
              trackId: destTrackId,
              tStartUs: newStart,
              tEndUs: newEnd,
            });
            await moveLayer(committed.layerId, destTrackId, newStart, escape);
            break;
          }
          case "trim-start": {
            const newStart = Math.max(
              0,
              Math.min(
                committed.originalTStart + deltaUs,
                committed.originalTEnd - MIN_LAYER_DURATION_US,
              ),
            );
            await trimLayer(committed.layerId, "in", newStart, escape);
            break;
          }
          case "trim-end": {
            const newEnd = Math.max(
              committed.originalTStart + MIN_LAYER_DURATION_US,
              committed.originalTEnd + deltaUs,
            );
            await trimLayer(committed.layerId, "out", newEnd, escape);
            break;
          }
        }
        await onMutated();
      } catch (err) {
        setPendingPlacement(null);
        console.error("timeline commit failed:", err);
      }
    },
    [drag, onMutated, pxPerSec, snapDragDelta, snapDeltaToTimelineBoundary, trackUnderPointer],
  );

  useEffect(() => {
    if (!drag) return;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [drag, handlePointerMove, handlePointerUp]);

  return { drag, setDrag, pendingPlacement, pendingLayer, dragLayer };
}
