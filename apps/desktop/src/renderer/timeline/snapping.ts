import type { GroupSummary, TrackSummary } from "../ipc";
import { adjacentFrameBoundaryUs, snapFrameRound } from "../frames";

const US_PER_SEC = 1_000_000;

export type TimelineDragSnapKind = "move" | "trim-start" | "trim-end";

export interface TimelineDragSnapState {
  kind: TimelineDragSnapKind;
  layerId: string;
  originalTStart: number;
  originalTEnd: number;
  escapeGroup: boolean;
}

interface TimelineSnapOptions {
  visibleTracks: readonly TrackSummary[];
  groups: readonly GroupSummary[];
  groupByLayerId: ReadonlyMap<string, string>;
  currentTimeUs: number;
  fpsNum: number;
  fpsDen: number;
  pxPerSec: number;
  enabled: boolean;
  strengthPx: number;
}

interface TimelineSnapBoundaryOptions extends TimelineSnapOptions {
  layerId?: string;
  escapeGroup?: boolean;
  isValidSnap?: (boundaryUs: number) => boolean;
}

function thresholdUs(strengthPx: number, pxPerSec: number): number {
  if (pxPerSec <= 0) return 0;
  return (Math.max(0, strengthPx) / pxPerSec) * US_PER_SEC;
}

function ignoredLayerIds(
  layerId: string | undefined,
  escapeGroup: boolean,
  groups: readonly GroupSummary[],
  groupByLayerId: ReadonlyMap<string, string>,
): Set<string> {
  const ignored = new Set<string>();
  if (!layerId) return ignored;
  ignored.add(layerId);
  if (!escapeGroup) {
    const groupId = groupByLayerId.get(layerId);
    const group = groupId ? groups.find((g) => g.id === groupId) : null;
    for (const memberId of group?.layer_ids ?? []) {
      ignored.add(memberId);
    }
  }
  return ignored;
}

function timelineBoundaries(
  opts: TimelineSnapOptions,
  ignored: ReadonlySet<string>,
): number[] {
  const boundaries: number[] = [];
  for (const track of opts.visibleTracks) {
    for (const layer of track.layers) {
      if (ignored.has(layer.id)) continue;
      boundaries.push(snapFrameRound(layer.t_start_us, opts.fpsNum, opts.fpsDen));
      boundaries.push(snapFrameRound(layer.t_end_us, opts.fpsNum, opts.fpsDen));
    }
  }
  boundaries.push(snapFrameRound(opts.currentTimeUs, opts.fpsNum, opts.fpsDen));
  return boundaries;
}

function dragAnchors(
  state: TimelineDragSnapState,
  frameDeltaUs: number,
): { originalUs: number; desiredUs: number }[] {
  switch (state.kind) {
    case "move":
      return [
        {
          originalUs: state.originalTStart,
          desiredUs: Math.max(0, state.originalTStart + frameDeltaUs),
        },
        {
          originalUs: state.originalTEnd,
          desiredUs: Math.max(0, state.originalTEnd + frameDeltaUs),
        },
      ];
    case "trim-start":
      return [
        {
          originalUs: state.originalTStart,
          desiredUs: state.originalTStart + frameDeltaUs,
        },
      ];
    case "trim-end":
      return [
        {
          originalUs: state.originalTEnd,
          desiredUs: state.originalTEnd + frameDeltaUs,
        },
      ];
  }
}

function validDragDelta(
  state: TimelineDragSnapState,
  deltaUs: number,
  fpsNum: number,
  fpsDen: number,
): boolean {
  switch (state.kind) {
    case "move":
      return state.originalTStart + deltaUs >= 0;
    case "trim-start": {
      const newStart = state.originalTStart + deltaUs;
      return (
        newStart >= 0 &&
        newStart <=
          adjacentFrameBoundaryUs(
            state.originalTEnd,
            -1,
            fpsNum,
            fpsDen,
          )
      );
    }
    case "trim-end":
      return (
        state.originalTEnd + deltaUs >=
        adjacentFrameBoundaryUs(
          state.originalTStart,
          1,
          fpsNum,
          fpsDen,
        )
      );
  }
}

export function snapDragDeltaToTimelineBoundary(
  opts: TimelineSnapOptions & {
    state: TimelineDragSnapState;
    frameDeltaUs: number;
  },
): number {
  if (!opts.enabled) return opts.frameDeltaUs;
  const maxDistanceUs = thresholdUs(opts.strengthPx, opts.pxPerSec);
  if (maxDistanceUs <= 0) return opts.frameDeltaUs;

  const ignored = ignoredLayerIds(
    opts.state.layerId,
    opts.state.escapeGroup,
    opts.groups,
    opts.groupByLayerId,
  );
  const boundaries = timelineBoundaries(opts, ignored);
  const anchors = dragAnchors(opts.state, opts.frameDeltaUs);

  let bestDeltaUs: number | null = null;
  let bestDistanceUs = Number.POSITIVE_INFINITY;
  for (const boundaryUs of boundaries) {
    for (const anchor of anchors) {
      const distanceUs = Math.abs(boundaryUs - anchor.desiredUs);
      if (distanceUs > maxDistanceUs || distanceUs >= bestDistanceUs) {
        continue;
      }
      const deltaUs = boundaryUs - anchor.originalUs;
      if (!validDragDelta(opts.state, deltaUs, opts.fpsNum, opts.fpsDen)) continue;
      bestDistanceUs = distanceUs;
      bestDeltaUs = deltaUs;
    }
  }

  return bestDeltaUs ?? opts.frameDeltaUs;
}

export function snapTimeToTimelineBoundary(
  opts: TimelineSnapBoundaryOptions & { timeUs: number },
): number {
  if (!opts.enabled) return opts.timeUs;
  const maxDistanceUs = thresholdUs(opts.strengthPx, opts.pxPerSec);
  if (maxDistanceUs <= 0) return opts.timeUs;

  const ignored = ignoredLayerIds(
    opts.layerId,
    opts.escapeGroup ?? false,
    opts.groups,
    opts.groupByLayerId,
  );
  const boundaries = timelineBoundaries(opts, ignored);

  let bestBoundaryUs: number | null = null;
  let bestDistanceUs = Number.POSITIVE_INFINITY;
  for (const boundaryUs of boundaries) {
    if (opts.isValidSnap && !opts.isValidSnap(boundaryUs)) continue;
    const distanceUs = Math.abs(boundaryUs - opts.timeUs);
    if (distanceUs <= maxDistanceUs && distanceUs < bestDistanceUs) {
      bestDistanceUs = distanceUs;
      bestBoundaryUs = boundaryUs;
    }
  }

  return bestBoundaryUs ?? opts.timeUs;
}
