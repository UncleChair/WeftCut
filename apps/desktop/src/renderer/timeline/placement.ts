import type { TrackSummary } from "../ipc";
import {
  layerOverlapClass,
  type LayerOverlapClass,
} from "./geometry";

/// `"spawn"` is the placement policy's fourth answer: no lane can take this
/// clip, so one is made for it. It is what the command path has always done
/// internally (`main/state/commands.ts`'s reverse scan appends a lane when
/// nothing is free) and what the drop path could not say — see ADR 0042.
export type PlacementValidity = "valid" | "collision" | "locked" | "spawn";

/// Placement target standing in for "a lane that does not exist yet" — the drop
/// strip. Keeping it a target id rather than a flag is what makes the strip's
/// answer structural: it travels the same evaluation, the same claim/release
/// drop-target protocol and the same ghost geometry a lane does, and no drop
/// surface has to special-case it.
export const SPAWN_TRACK_ID = "__weftcut-spawn-track__";

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
 *
 * A placement on `SPAWN_TRACK_ID` answers `"spawn"`: the lane it names has no
 * committed content to overlap, so a fresh lane is empty by construction.
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
  let spawns = false;

  const addConflict = (layerId: string) => {
    if (conflictSet.has(layerId)) return;
    conflictSet.add(layerId);
    conflictingLayerIds.push(layerId);
  };

  for (const placement of placements) {
    if (placement.trackId === SPAWN_TRACK_ID) {
      // A locked SUBJECT still refuses — that is a property of the clip being
      // placed, not of the destination, and the destination has no content.
      if (placement.locked) locked = true;
      spawns = true;
      continue;
    }
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
    // `spawn` ranks below collision so a multi-selection that would overlap
    // itself on the one new lane still refuses instead of promising a lane it
    // cannot fill.
    validity: locked
      ? "locked"
      : conflictingLayerIds.length > 0
        ? "collision"
        : spawns
          ? "spawn"
          : "valid",
    conflictingLayerIds,
    sharesLane,
  };
}
