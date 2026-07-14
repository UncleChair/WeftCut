import type { TrackSummary } from "../ipc";
import {
  layerOverlapClass,
  type LayerOverlapClass,
} from "./geometry";

export type PlacementValidity = "valid" | "collision" | "locked";

export interface TimelinePlacement {
  layerId: string;
  trackId: string;
  tStartUs: number;
  tEndUs: number;
  overlapClass: LayerOverlapClass;
  locked: boolean;
}

export interface TimelinePlacementEvaluation {
  validity: PlacementValidity;
  conflictingLayerIds: string[];
  sharesLane: boolean;
}

function rangesOverlap(
  aStartUs: number,
  aEndUs: number,
  bStartUs: number,
  bEndUs: number,
): boolean {
  return aEndUs > bStartUs && bEndUs > aStartUs;
}

/**
 * Evaluate projected layer positions against the committed timeline and one
 * another. `replacedLayerIds` removes the subjects' old positions before the
 * projections are checked, which prevents a moving clip colliding with itself.
 *
 * This is the shared overlap seam for incoming-media ghosts and existing-layer
 * move ghosts: visual/visual and audio/audio overlap is invalid, visual/audio
 * overlap is a legal shared lane, and touching half-open ranges are legal.
 */
export function evaluateTimelinePlacements({
  tracks,
  placements,
  replacedLayerIds,
}: {
  tracks: readonly TrackSummary[];
  placements: readonly TimelinePlacement[];
  replacedLayerIds: ReadonlySet<string>;
}): TimelinePlacementEvaluation {
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const conflictingLayerIds: string[] = [];
  const conflictSet = new Set<string>();
  let locked = false;
  let sharesLane = false;

  const addConflict = (layerId: string) => {
    if (conflictSet.has(layerId)) return;
    conflictSet.add(layerId);
    conflictingLayerIds.push(layerId);
  };

  for (const placement of placements) {
    const targetTrack = trackById.get(placement.trackId);
    if (placement.locked || targetTrack?.locked) locked = true;
    if (!targetTrack) continue;

    for (const layer of targetTrack.layers) {
      if (replacedLayerIds.has(layer.id)) continue;
      if (
        !rangesOverlap(
          placement.tStartUs,
          placement.tEndUs,
          layer.t_start_us,
          layer.t_end_us,
        )
      ) {
        continue;
      }
      if (placement.overlapClass === layerOverlapClass(layer)) {
        addConflict(layer.id);
      } else {
        sharesLane = true;
      }
    }
  }

  // A cross-track group move can place the anchor onto a sibling's track.
  // Their committed positions were removed above, so compare every projected
  // pair to preserve the same invariant inside the moving set.
  for (let i = 0; i < placements.length; i += 1) {
    const left = placements[i]!;
    for (let j = i + 1; j < placements.length; j += 1) {
      const right = placements[j]!;
      if (
        left.trackId !== right.trackId ||
        !rangesOverlap(
          left.tStartUs,
          left.tEndUs,
          right.tStartUs,
          right.tEndUs,
        )
      ) {
        continue;
      }
      if (left.overlapClass === right.overlapClass) {
        addConflict(left.layerId);
        addConflict(right.layerId);
      } else {
        sharesLane = true;
      }
    }
  }

  return {
    validity: locked
      ? "locked"
      : conflictingLayerIds.length > 0
        ? "collision"
        : "valid",
    conflictingLayerIds,
    sharesLane,
  };
}
