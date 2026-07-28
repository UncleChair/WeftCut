import { useCallback, useEffect, useMemo, useState } from "react";
import {
  moveLayer,
  pasteLayer,
  trimLayer,
  type GroupSummary,
  type LayerSummary,
  type TrackSummary,
} from "../../ipc";
import { adjacentFrameBoundaryUs, snapFrameRound } from "../../frames";
import {
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

const UNSELECTED_CLIP_DRAG_ARM_MS = 100;

interface LayerDragGesture {
  state: DragState;
  phase: "pending" | "dragging";
  armAtMs: number;
  lastClientX: number;
  lastClientY: number;
}

interface PointerDragEvaluation {
  state: DragState;
  hasEditIntent: boolean;
  hasCommitChange: boolean;
  moveProjection: LayerMoveProjection | null;
}

/// Layer drag state machine (move / trim-start / trim-end): ghost
/// tracking via window pointermove, frame + timeline-boundary snapping,
/// and the commit-on-pointerup switch that lowers to
/// `moveLayer`/`pasteLayer`/`trimLayer`.
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
  const [gesture, setGesture] = useState<LayerDragGesture | null>(null);
  // Pending selection gestures stay private: callers render drag chrome only
  // after the temporal arm and a real frame/track change have both happened.
  const drag = gesture?.phase === "dragging" ? gesture.state : null;
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
      const entry = layerEntryById.get(
        placement.sourceLayerId ?? placement.layerId,
      );
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
      // Alt+drag copies only the layer under the pointer. In particular, an
      // auto-paired/grouped sibling stays untouched and the duplicate remains
      // detached, matching duplicate/paste semantics elsewhere in the app.
      const groupId =
        seed.duplicate || seed.escapeGroup
          ? undefined
          : groupByLayerId.get(seed.layerId);
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
      if (!seed) {
        setGesture(null);
        return;
      }
      const state: DragState = {
        ...seed,
        subjects: buildDragSubjects(seed),
        validity: "valid",
        conflictingLayerIds: [],
      };
      const armDelayMs =
        seed.kind === "move" && !seed.wasSelectedAtPointerDown
          ? UNSELECTED_CLIP_DRAG_ARM_MS
          : 0;
      setGesture({
        state,
        phase: "pending",
        armAtMs: Date.now() + armDelayMs,
        lastClientX: seed.startX,
        lastClientY: seed.startY,
      });
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

  const constrainedAnchorUs = useCallback(
    (state: DragState, deltaUs: number): number => {
      switch (state.kind) {
        case "move":
          return Math.max(0, state.originalTStart + deltaUs);
        case "trim-start":
          return Math.max(
            0,
            Math.min(
              state.originalTStart + deltaUs,
              adjacentFrameBoundaryUs(
                state.originalTEnd,
                -1,
                fpsNum,
                fpsDen,
              ),
            ),
          );
        case "trim-end":
          return Math.max(
            adjacentFrameBoundaryUs(
              state.originalTStart,
              1,
              fpsNum,
              fpsDen,
            ),
            state.originalTEnd + deltaUs,
          );
      }
    },
    [fpsDen, fpsNum],
  );

  const snapDeltaToTimelineBoundary = useCallback(
    (
      state: DragState,
      frameDeltaUs: number,
    ): number => {
      return snapDragDeltaToTimelineBoundary({
        // A duplicate leaves grouped siblings in place, so their boundaries
        // remain eligible snap targets. escapeGroup=true makes the snapping
        // helper ignore only the copied source layer.
        state: state.duplicate ? { ...state, escapeGroup: true } : state,
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
        // A move replaces the source intervals; a duplicate leaves them in
        // place, so the destination must also be checked against its source.
        replacedLayerIds: state.duplicate
          ? new Set()
          : new Set(state.subjects.map((subject) => subject.layerId)),
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

  const evaluatePointer = useCallback(
    (
      state: DragState,
      clientX: number,
      clientY: number,
    ): PointerDragEvaluation => {
      const deltaPx = clientX - state.startX;
      const rawDeltaUs = Math.round((deltaPx / pxPerSec) * 1_000_000);
      const anchor =
        state.kind === "trim-end" ? state.originalTEnd : state.originalTStart;
      // Compare grid destinations before calculating a drag delta. This is the
      // causality gate: snapping may refine a requested edit, but a stationary
      // pointer (including an off-grid audio anchor) cannot create one.
      const requestedFrameChange =
        snapFrameRound(anchor + rawDeltaUs, fpsNum, fpsDen) !==
        snapFrameRound(anchor, fpsNum, fpsDen);
      const frameDeltaUs = snapDragDelta(
        state.kind,
        state.originalTStart,
        state.originalTEnd,
        rawDeltaUs,
      );
      const overTrack =
        state.kind === "move" ? trackUnderPointer(clientY) : null;
      const destinationTrackId =
        overTrack && trackAcceptsForLayer(overTrack, state)
          ? overTrack.id
          : state.trackId;
      const trackChanged =
        state.kind === "move" && destinationTrackId !== state.trackId;

      const timeChanged =
        requestedFrameChange &&
        constrainedAnchorUs(state, frameDeltaUs) !== anchor;

      const hasEditIntent = timeChanged || trackChanged;
      // A purely vertical move preserves time. In particular, do not let its
      // zero horizontal delta be attracted to the playhead.
      const deltaUs = timeChanged
        ? snapDeltaToTimelineBoundary(state, frameDeltaUs)
        : 0;
      const moveProjection =
        state.kind === "move"
          ? buildMoveProjection(state, deltaUs, overTrack)
          : null;
      const nextState: DragState = {
        ...state,
        deltaUs,
        overTrackId: overTrack?.id ?? null,
        validity: moveProjection?.validity ?? "valid",
        conflictingLayerIds: moveProjection?.conflictingLayerIds ?? [],
      };

      const hasCommitChange =
        constrainedAnchorUs(state, deltaUs) !== anchor || trackChanged;

      return {
        state: nextState,
        hasEditIntent,
        hasCommitChange,
        moveProjection,
      };
    },
    [
      buildMoveProjection,
      constrainedAnchorUs,
      fpsDen,
      fpsNum,
      pxPerSec,
      snapDragDelta,
      snapDeltaToTimelineBoundary,
      trackUnderPointer,
    ],
  );

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      const clientX = e.clientX;
      const clientY = e.clientY;
      setGesture((current) => {
        if (!current) return null;
        const evaluation = evaluatePointer(current.state, clientX, clientY);
        const next = {
          ...current,
          lastClientX: clientX,
          lastClientY: clientY,
        };
        if (current.phase === "pending") {
          if (Date.now() < current.armAtMs || !evaluation.hasEditIntent) {
            return next;
          }
          return {
            ...next,
            phase: "dragging",
            state: evaluation.state,
          };
        }
        return { ...next, state: evaluation.state };
      });
    },
    [evaluatePointer],
  );

  const handlePointerUp = useCallback(
    async (e: PointerEvent) => {
      if (!gesture) return;
      const evaluation = evaluatePointer(
        gesture.state,
        e.clientX,
        e.clientY,
      );
      const temporalArmReached =
        gesture.phase === "dragging" || Date.now() >= gesture.armAtMs;
      setGesture(null);
      if (
        !temporalArmReached ||
        !evaluation.hasEditIntent ||
        !evaluation.hasCommitChange
      ) {
        return;
      }
      const committed = evaluation.state;
      const deltaUs = committed.deltaUs;
      const moveProjection = evaluation.moveProjection;

      try {
        // `docs/features.md#groups` — Alt-held at drag start opts the move /
        // trim out of group fanout for this single op.
        const escape = committed.escapeGroup;
        switch (committed.kind) {
          case "move": {
            if (!moveProjection || moveProjection.validity !== "valid") {
              setPendingPlacements(null);
              return;
            }
            if (committed.duplicate) {
              const pendingDuplicate = moveProjection.placements.find(
                (placement) => placement.layerId === committed.layerId,
              );
              if (!pendingDuplicate) return;
              const pendingId = `${committed.layerId}::pending-duplicate`;
              setPendingPlacements([
                {
                  ...pendingDuplicate,
                  layerId: pendingId,
                  sourceLayerId: committed.layerId,
                },
              ]);
              const duplicatedLayerId = await pasteLayer(
                committed.layerId,
                moveProjection.anchorStartUs,
                moveProjection.destinationTrackId,
              );
              setPendingPlacements([
                {
                  ...pendingDuplicate,
                  layerId: duplicatedLayerId,
                  sourceLayerId: committed.layerId,
                },
              ]);
              break;
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
            const newStart = constrainedAnchorUs(committed, deltaUs);
            await trimLayer(committed.layerId, "in", newStart, escape);
            break;
          }
          case "trim-end": {
            const newEnd = constrainedAnchorUs(committed, deltaUs);
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
      constrainedAnchorUs,
      evaluatePointer,
      gesture,
      onMutated,
    ],
  );

  // If an unselected clip moved during the grace window and the pointer then
  // rests, promote it exactly when the one-shot arm delay expires. This is an
  // activation timer, not a pointermove debounce: continuous motion never
  // pushes the deadline farther away.
  useEffect(() => {
    if (!gesture || gesture.phase !== "pending") return;
    const delayMs = Math.max(0, gesture.armAtMs - Date.now());
    const timer = window.setTimeout(() => {
      setGesture((current) => {
        if (!current || current.phase !== "pending") return current;
        if (Date.now() < current.armAtMs) return current;
        const evaluation = evaluatePointer(
          current.state,
          current.lastClientX,
          current.lastClientY,
        );
        if (!evaluation.hasEditIntent) return current;
        return {
          ...current,
          phase: "dragging",
          state: evaluation.state,
        };
      });
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [evaluatePointer, gesture]);

  useEffect(() => {
    if (!gesture) return;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [gesture, handlePointerMove, handlePointerUp]);

  return { drag, setDrag, pendingPlacements, pendingLayerById, dragLayerById };
}
