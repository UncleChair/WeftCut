import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  moveLayer,
  moveLayersToNewTrack,
  pasteLayer,
  trimLayer,
  type GroupSummary,
  type LayerSummary,
  type TrackSummary,
} from "../../ipc";
import {
  adjacentFrameBoundaryUs,
  boundaryDisplayFrameUs,
  snapFrameRound,
} from "../../frames";
import { logMutationFailure } from "../../errors/tryMutate";
import { transportPause, transportSeek } from "../../state/playbackStore";
import { setPlayheadTimeUs } from "../../state/playheadStore";
import {
  layerOverlapClass,
  trackIdAtClientY,
  type MeasuredTrackRow,
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
  SPAWN_TRACK_ID,
  type PlacementValidity,
  type TimelinePlacement,
} from "../placement";

/// Tracks are kind-agnostic: any layer can land on any track. This
/// reject hook always accepts; routing is by LayerParams, not track
/// kind. See docs/data-model.md (kind-agnostic tracks) / ADR 0023.
///
/// Takes the destination's ID rather than its summary because one destination
/// has no summary: the drop strip names a lane that does not exist yet.
function trackAcceptsForLayer(_targetTrackId: string, _drag: DragState): boolean {
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
/// `moveLayer`/`moveLayersToNewTrack`/`pasteLayer`/`trimLayer`.
export function useLayerDrag(opts: {
  tracks: TrackSummary[];
  groups: GroupSummary[];
  groupByLayerId: Map<string, string>;
  orderedTracks: VisualTrack[];
  /// Live track-id → lane-element registry, owned by the Timeline. Measured
  /// per pointer event; see `destinationUnderPointer`.
  laneEls: React.RefObject<Map<string, HTMLElement>>;
  /// The drop strip's row. Deliberately NOT an entry in `laneEls`: that registry
  /// maps TRACK ids to lanes and the hit-test walks `orderedTracks` to find them,
  /// so a row that is not a track could never be reached through it. Handed over
  /// separately and folded into the same measured rows instead — one band rule
  /// still decides every destination.
  dropStripEl: React.RefObject<HTMLElement | null>;
  pxPerSec: number;
  fpsNum: number;
  fpsDen: number;
  tailSnapEnabled: boolean;
  tailSnapStrengthPx: number;
  /// A raise minted a lane. The Timeline reveals it: a spawned lane carries no
  /// role, so the A/B filter would hide the clip the user just raised.
  onLaneSpawned: (trackId: string) => void;
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
    laneEls,
    dropStripEl,
    pxPerSec,
    fpsNum,
    fpsDen,
    tailSnapEnabled,
    tailSnapStrengthPx,
    onLaneSpawned,
    onMutated,
  } = opts;
  const [gesture, setGesture] = useState<LayerDragGesture | null>(null);
  // Pending selection gestures stay private: callers render drag chrome only
  // after the temporal arm and a real frame/track change have both happened.
  const drag = gesture?.phase === "dragging" ? gesture.state : null;
  const [pendingPlacements, setPendingPlacements] =
    useState<PendingLayerPlacement[] | null>(null);

  const layerEntryById = useMemo(() => {
    const layerById = new Map<
      string,
      { layer: LayerSummary; trackId: string; trackLocked: boolean }
    >();
    for (const track of tracks) {
      for (const layer of track.layers) {
        layerById.set(layer.id, {
          layer,
          trackId: track.id,
          trackLocked: track.locked,
        });
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

  /// Which destination a pointer at `clientY` is over, as a track id —
  /// `SPAWN_TRACK_ID` when that destination is the drop strip, i.e. a lane that
  /// does not exist yet (ADR 0042). Measure the rendered rows, then band-select.
  /// Cost is one forced reflow per pointer event; the remaining rect reads then
  /// hit clean layout.
  const destinationUnderPointer = useCallback(
    (clientY: number): string | null => {
      const rows: MeasuredTrackRow[] = [];
      // Walk `orderedTracks`, not the registry: only rendered lanes are
      // droppable, and the AB display filter hides some tracks entirely.
      for (const { track } of orderedTracks) {
        const el = laneEls.current.get(track.id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        rows.push({ trackId: track.id, top: rect.top, bottom: rect.bottom });
      }
      // The strip joins the SAME row list, so the seam between it and the
      // topmost lane is decided by the one band rule that already hands an
      // expanded track's sub-lanes to their owner. A second hit-test would be a
      // second chance to disagree with this one at exactly that boundary.
      const stripEl = dropStripEl.current;
      if (stripEl) {
        const rect = stripEl.getBoundingClientRect();
        rows.push({
          trackId: SPAWN_TRACK_ID,
          top: rect.top,
          bottom: rect.bottom,
        });
      }
      return trackIdAtClientY(rows, clientY);
    },
    [dropStripEl, laneEls, orderedTracks],
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

  // -------- Trim monitor preview --------

  // While a trim drag is live, the monitor shows the frame the dragged
  // boundary KEEPS: the out side shows the last kept frame (the traditional
  // NLE tail-trim display — never the frame past the cut), the in side the
  // first. The playhead is not the preview cursor: its position is captured
  // once at gesture start and restored when the gesture ends, so a trim
  // never relocates the user's park position.
  const trimPreviewUs = (() => {
    if (!drag || drag.kind === "move") return null;
    const boundaryUs = constrainedAnchorUs(drag, drag.deltaUs);
    return boundaryDisplayFrameUs(
      boundaryUs,
      drag.kind === "trim-end" ? "out" : "in",
      fpsNum,
      fpsDen,
    );
  })();
  const trimPreviewActive = trimPreviewUs !== null;
  const trimRestoreUsRef = useRef<number | null>(null);

  useEffect(() => {
    if (trimPreviewUs === null) return;
    if (trimRestoreUsRef.current === null) {
      trimRestoreUsRef.current = playheadTimeUs();
      // Trimming while playing would fight the running transport for the
      // monitor — park it first (Premiere stops playback on a trim drag too).
      transportPause();
    }
    // Dedup is the effect dep itself: the value is frame-quantized upstream,
    // so a pointer wiggle inside one frame never re-seeks.
    transportSeek(trimPreviewUs);
  }, [trimPreviewUs]);

  useEffect(() => {
    if (!trimPreviewActive) return;
    return () => {
      const restoreUs = trimRestoreUsRef.current;
      trimRestoreUsRef.current = null;
      if (restoreUs === null) return;
      // Optimistic store write + transport seek (the seekExact pattern in
      // state/navigation.ts): engine emits during the preview may have moved
      // the playhead line, so put both the line and the monitor back.
      setPlayheadTimeUs(restoreUs);
      transportSeek(restoreUs);
    };
  }, [trimPreviewActive]);

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
      overTrackId: string | null,
    ): LayerMoveProjection => {
      const anchorStartUs = Math.max(0, state.originalTStart + deltaUs);
      const actualDeltaUs = anchorStartUs - state.originalTStart;
      const destinationTrackId =
        overTrackId !== null && trackAcceptsForLayer(overTrackId, state)
          ? overTrackId
          : state.trackId;
      // A raise takes the WHOLE subject set onto the one new lane and carries
      // every time verbatim: `move_layers_to_new_track` has no delta for a
      // sibling to follow. Projecting them all onto `SPAWN_TRACK_ID` is exactly
      // the question "could one empty lane hold them" — which is what makes a set
      // that would overlap itself there answer `"collision"` and refuse.
      const spawning = destinationTrackId === SPAWN_TRACK_ID;
      const projected: TimelinePlacement[] = [];

      for (const subject of state.subjects) {
        const entry = layerEntryById.get(subject.layerId);
        if (!entry) continue;
        const durationUs = subject.originalTEnd - subject.originalTStart;
        const isAnchor = subject.layerId === state.layerId;
        const tStartUs = spawning
          ? subject.originalTStart
          : isAnchor
            ? anchorStartUs
            : Math.max(0, subject.originalTStart + actualDeltaUs);
        projected.push({
          layerId: subject.layerId,
          trackId: spawning || isAnchor ? destinationTrackId : subject.trackId,
          tStartUs,
          tEndUs: tStartUs + durationUs,
          overlapClass: layerOverlapClass(entry.layer),
          // The SOURCE lane's lock speaks too. With a real destination the target
          // lane's own lock already refuses — a sibling's destination IS its
          // source — but a raise names one lane that does not exist yet, so
          // without this the strip would be a way around a lock. `"locked"`
          // out-ranks `"spawn"`, which is the whole refusal.
          locked: entry.layer.locked || entry.trackLocked,
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
      // Vertical causality gate, mirroring the frame gate above: a track
      // change must be CAUSED by vertical travel. Without it any hit-test
      // disagreement at rest reads as edit intent, and a motionless click on
      // a selected clip (arm delay 0) commits a cross-track move. Skipping
      // the measurement on horizontal-only drags is a free side benefit.
      const movedVertically = Math.abs(clientY - state.startY) >= 1;
      const hitTrackId =
        state.kind === "move" && movedVertically
          ? destinationUnderPointer(clientY)
          : null;
      // Alt+drag lowers to `pasteLayer`, which needs a lane that already exists,
      // and there is no create-and-paste operation — so the strip is simply not a
      // destination for a duplicate. Withheld here rather than refused at
      // release, the same instinct as this gesture's other pre-checks.
      const overTrackId =
        hitTrackId === SPAWN_TRACK_ID && state.duplicate ? null : hitTrackId;
      const destinationTrackId =
        overTrackId !== null && trackAcceptsForLayer(overTrackId, state)
          ? overTrackId
          : state.trackId;
      const trackChanged =
        state.kind === "move" && destinationTrackId !== state.trackId;

      const timeChanged =
        requestedFrameChange &&
        constrainedAnchorUs(state, frameDeltaUs) !== anchor;

      const hasEditIntent = timeChanged || trackChanged;
      // A purely vertical move preserves time. In particular, do not let its
      // zero horizontal delta be attracted to the playhead. A raise onto the
      // strip preserves it too, whatever the pointer did horizontally: the commit
      // carries times verbatim, so a ghost that slid would promise an edit
      // `move_layers_to_new_track` cannot make.
      const deltaUs =
        timeChanged && destinationTrackId !== SPAWN_TRACK_ID
          ? snapDeltaToTimelineBoundary(state, frameDeltaUs)
          : 0;
      const moveProjection =
        state.kind === "move"
          ? buildMoveProjection(state, deltaUs, overTrackId)
          : null;
      const nextState: DragState = {
        ...state,
        deltaUs,
        overTrackId,
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
      destinationUnderPointer,
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
            const spawning =
              moveProjection?.destinationTrackId === SPAWN_TRACK_ID;
            // The verdict a committable release has to carry: `"spawn"` over the
            // strip (a lane that does not exist yet is never `"valid"`),
            // `"valid"` over a real lane. Collision and lock out-rank both, so
            // this one comparison is also the refusal — the locked case needs no
            // branch of its own.
            if (
              !moveProjection ||
              moveProjection.validity !== (spawning ? "spawn" : "valid")
            ) {
              setPendingPlacements(null);
              return;
            }
            if (spawning) {
              // ONE history entry, from ONE operation: the lane appears, every
              // subject moves onto it, and every lane the raise emptied goes with
              // it, so one undo puts all of it back. Never decomposed into
              // add-track + move — that is two entries and a stranded lane if the
              // second half fails.
              //
              // A bridge is keyed by destination track id and this destination
              // has no id until the commit returns, so one written here could
              // match no lane and would never clear. Nothing to bridge either —
              // times are carried verbatim, so the only change is which row the
              // clip sits on. Any bridge an earlier gesture left is dropped for
              // the same reason: the raise moves its subjects out from under it.
              setPendingPlacements(null);
              const spawnedTrackId = await moveLayersToNewTrack(
                committed.subjects.map((subject) => subject.layerId),
              );
              onLaneSpawned(spawnedTrackId);
              break;
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
        logMutationFailure(err, "Timeline drag commit");
      }
    },
    [
      constrainedAnchorUs,
      evaluatePointer,
      gesture,
      onLaneSpawned,
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
