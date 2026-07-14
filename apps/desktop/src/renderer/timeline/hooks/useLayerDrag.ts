import { useCallback, useEffect, useMemo, useState } from "react";
import {
  moveLayer,
  trimLayer,
  type GroupSummary,
  type LayerSummary,
  type TrackSummary,
} from "../../ipc";
import { snapFrameRound } from "../../frames";
import {
  MIN_LAYER_DURATION_US,
  layerOverlapClass,
  type VisualTrack,
} from "../geometry";
import {
  type DragSeed,
  type DragState,
  type DragSubject,
  type PendingLayerPlacement,
} from "../LayerBlock";
import { snapDragDeltaToTimelineBoundary } from "../snapping";
import { playheadTimeUs } from "../../state/playheadStore";
import {
  evaluateTimelinePlacements,
  type PlacementValidity,
  type TimelinePlacement,
} from "../placement";

/// Tracks are kind-agnostic: any layer can land on any track. This
/// reject hook always accepts; routing is by LayerParams, not track
/// kind. See docs/data-model.md (kind-agnostic tracks) / ADR 0023.
function trackAcceptsForLayer(_target: TrackSummary, _drag: DragState): boolean {
  return true;
}

interface LayerMoveProjection {
  placements: PendingLayerPlacement[];
  destinationTrackId: string;
  anchorStartUs: number;
  validity: PlacementValidity;
  conflictingLayerIds: string[];
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
  fpsNum: number;
  fpsDen: number;
  tailSnapEnabled: boolean;
  tailSnapStrengthPx: number;
  onMutated: () => Promise<void>;
}): {
  drag: DragState | null;
  setDrag: (s: DragSeed | null) => void;
  pendingPlacements: PendingLayerPlacement[] | null;
  pendingLayerById: ReadonlyMap<string, LayerSummary>;
  dragLayerById: ReadonlyMap<string, LayerSummary>;
} {
  const {
    tracks,
    groups,
    groupByLayerId,
    orderedTracks,
    trackRows,
    canvasRef,
    pxPerSec,
    fpsNum,
    fpsDen,
    tailSnapEnabled,
    tailSnapStrengthPx,
    onMutated,
  } = opts;
  const [drag, setDragState] = useState<DragState | null>(null);
  const [pendingPlacements, setPendingPlacements] =
    useState<PendingLayerPlacement[] | null>(null);

  const layerEntryById = useMemo(() => {
    const layerById = new Map<string, { layer: LayerSummary; trackId: string }>();
    for (const track of tracks) {
      for (const layer of track.layers) {
        layerById.set(layer.id, { layer, trackId: track.id });
      }
    }
    return layerById;
  }, [tracks]);

  const pendingLayerById = useMemo(() => {
    const layersById = new Map<string, LayerSummary>();
    for (const placement of pendingPlacements ?? []) {
      const entry = layerEntryById.get(placement.layerId);
      if (entry) layersById.set(placement.layerId, entry.layer);
    }
    return layersById;
  }, [layerEntryById, pendingPlacements]);

  const dragLayerById = useMemo(() => {
    const layersById = new Map<string, LayerSummary>();
    if (!drag || drag.kind !== "move") return layersById;
    for (const subject of drag.subjects) {
      const entry = layerEntryById.get(subject.layerId);
      if (entry) layersById.set(subject.layerId, entry.layer);
    }
    return layersById;
  }, [drag, layerEntryById]);

  useEffect(() => {
    if (!pendingPlacements) return;
    const allLanded = pendingPlacements.every((placement) => {
      const track = tracks.find((t) => t.id === placement.trackId);
      const layer = track?.layers.find((l) => l.id === placement.layerId);
      return (
        layer &&
        layer.t_start_us === placement.tStartUs &&
        layer.t_end_us === placement.tEndUs
      );
    });
    if (allLanded) {
      setPendingPlacements(null);
    }
  }, [pendingPlacements, tracks]);

  const visibleSnapTracks = useMemo(
    () => orderedTracks.map(({ track }) => track),
    [orderedTracks],
  );

  const buildDragSubjects = useCallback(
    (seed: DragSeed): DragSubject[] => {
      const groupId = seed.escapeGroup ? undefined : groupByLayerId.get(seed.layerId);
      const group = groupId ? groups.find((candidate) => candidate.id === groupId) : null;
      const candidateIds = group?.layer_ids ?? [seed.layerId];
      const targetEdgeUs =
        seed.kind === "trim-start"
          ? seed.originalTStart
          : seed.kind === "trim-end"
            ? seed.originalTEnd
            : null;

      const subjects: DragSubject[] = [];
      for (const layerId of candidateIds) {
        const entry = layerEntryById.get(layerId);
        if (!entry) continue;
        const layer = entry.layer;
        if (targetEdgeUs !== null) {
          const edgeUs =
            seed.kind === "trim-start" ? layer.t_start_us : layer.t_end_us;
          if (layerId !== seed.layerId && edgeUs !== targetEdgeUs) continue;
        }
        subjects.push({
          layerId,
          trackId: entry.trackId,
          originalTStart: layer.t_start_us,
          originalTEnd: layer.t_end_us,
        });
      }
      if (!subjects.some((subject) => subject.layerId === seed.layerId)) {
        subjects.unshift({
          layerId: seed.layerId,
          trackId: seed.trackId,
          originalTStart: seed.originalTStart,
          originalTEnd: seed.originalTEnd,
        });
      }
      return subjects;
    },
    [groupByLayerId, groups, layerEntryById],
  );

  const setDrag = useCallback(
    (seed: DragSeed | null) => {
      setDragState(
        seed
          ? {
              ...seed,
              subjects: buildDragSubjects(seed),
              validity: "valid",
              conflictingLayerIds: [],
            }
          : null,
      );
    },
    [buildDragSubjects],
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
    [canvasRef, trackRows],
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
        // Event-time read (drag pointermove): the playhead is a snap target;
        // its value at the event is what snapping should use.
        currentTimeUs: playheadTimeUs(),
        fpsNum,
        fpsDen,
        pxPerSec,
        enabled: tailSnapEnabled,
        strengthPx: tailSnapStrengthPx,
      });
    },
    [
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

  const buildMoveProjection = useCallback(
    (
      state: DragState,
      deltaUs: number,
      overTrack: TrackSummary | null,
    ): LayerMoveProjection => {
      const anchorStartUs = Math.max(0, state.originalTStart + deltaUs);
      const actualDeltaUs = anchorStartUs - state.originalTStart;
      const destinationTrackId =
        overTrack && trackAcceptsForLayer(overTrack, state)
          ? overTrack.id
          : state.trackId;
      const projected: TimelinePlacement[] = [];

      for (const subject of state.subjects) {
        const entry = layerEntryById.get(subject.layerId);
        if (!entry) continue;
        const durationUs = subject.originalTEnd - subject.originalTStart;
        const isAnchor = subject.layerId === state.layerId;
        const tStartUs = isAnchor
          ? anchorStartUs
          : Math.max(0, subject.originalTStart + actualDeltaUs);
        projected.push({
          layerId: subject.layerId,
          trackId: isAnchor ? destinationTrackId : subject.trackId,
          tStartUs,
          tEndUs: tStartUs + durationUs,
          overlapClass: layerOverlapClass(entry.layer),
          locked: entry.layer.locked,
        });
      }

      const evaluation = evaluateTimelinePlacements({
        tracks,
        placements: projected,
        replacedLayerIds: new Set(state.subjects.map((subject) => subject.layerId)),
      });

      return {
        placements: projected.map((placement) => ({
          layerId: placement.layerId,
          trackId: placement.trackId,
          tStartUs: placement.tStartUs,
          tEndUs: placement.tEndUs,
        })),
        destinationTrackId,
        anchorStartUs,
        validity: evaluation.validity,
        conflictingLayerIds: evaluation.conflictingLayerIds,
      };
    },
    [layerEntryById, tracks],
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
      const projection =
        drag.kind === "move"
          ? buildMoveProjection(drag, deltaUs, overTrack)
          : null;
      setDragState({
        ...drag,
        deltaUs,
        overTrackId: overTrack?.id ?? null,
        validity: projection?.validity ?? "valid",
        conflictingLayerIds: projection?.conflictingLayerIds ?? [],
      });
    },
    [
      buildMoveProjection,
      drag,
      pxPerSec,
      snapDragDelta,
      snapDeltaToTimelineBoundary,
      trackUnderPointer,
    ],
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
      const moveProjection =
        committed.kind === "move"
          ? buildMoveProjection(committed, deltaUs, overTrack)
          : null;
      setDragState(null);

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
            if (!moveProjection || moveProjection.validity !== "valid") {
              setPendingPlacements(null);
              return;
            }
            setPendingPlacements(moveProjection.placements);
            await moveLayer(
              committed.layerId,
              moveProjection.destinationTrackId,
              moveProjection.anchorStartUs,
              escape,
            );
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
        setPendingPlacements(null);
        console.error("timeline commit failed:", err);
      }
    },
    [
      buildMoveProjection,
      drag,
      onMutated,
      pxPerSec,
      snapDragDelta,
      snapDeltaToTimelineBoundary,
      trackUnderPointer,
    ],
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

  return { drag, setDrag, pendingPlacements, pendingLayerById, dragLayerById };
}
