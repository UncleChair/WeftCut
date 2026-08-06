import { create } from "zustand";

import { snapFrameRound } from "../frames";
import type {
  GroupSummary,
  MediaSummary,
  TrackSummary,
} from "../ipc";
import type { LayerOverlapClass } from "./geometry";
import {
  evaluateTimelinePlacements,
  type PlacementValidity,
} from "./placement";
import { snapDragDeltaToTimelineBoundary } from "./snapping";

export const MEDIA_DRAG_TYPE = "application/x-weftcut-media";

// Keep the pointer inside the ghost instead of pinning it to the left edge.
// This leaves the clip's start, the content immediately before it, and the
// collision boundary visible while the user is positioning the drop.
export const MEDIA_DRAG_CURSOR_OFFSET_PX = 32;

const FALLBACK_MEDIA_DURATION_US = 2_000_000;
const DEFAULT_IMAGE_DURATION_US = 3_000_000;

export interface MediaDragPayload {
  mediaId: string;
  kind: string;
  label: string;
  durationUs: number;
}

export interface MediaDragVisual {
  clientX: number;
  clientY: number;
  width: number;
  height: number;
  pointerOffsetX: number;
  pointerOffsetY: number;
}

export interface MediaDragAbsorptionTarget {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type MediaDropValidity = PlacementValidity;

export interface MediaDropPlan {
  /// Unsnapped value sent to add_media_layer.
  rawStartUs: number;
  tStartUs: number;
  tEndUs: number;
  validity: MediaDropValidity;
  conflictingLayerIds: string[];
  overlapClass: LayerOverlapClass;
  /// When true, the ghost occupies the same half-height slot that the final
  /// layer will use beside an opposite-class layer.
  sharesLane: boolean;
}

export interface MediaDropSnapOptions {
  visibleTracks: readonly TrackSummary[];
  groups: readonly GroupSummary[];
  groupByLayerId: ReadonlyMap<string, string>;
  currentTimeUs: number;
  enabled: boolean;
  strengthPx: number;
}

interface MediaDragState {
  active: MediaDragPayload | null;
  dropTargetTrackId: string | null;
  visual: MediaDragVisual | null;
  absorptionTarget: MediaDragAbsorptionTarget | null;
  begin: (payload: MediaDragPayload, visual?: MediaDragVisual) => void;
  moveVisual: (clientX: number, clientY: number) => void;
  claimDropTarget: (
    trackId: string,
    absorptionTarget?: MediaDragAbsorptionTarget,
  ) => void;
  releaseDropTarget: (trackId: string) => void;
  end: () => void;
}

export const useMediaDragStore = create<MediaDragState>((set) => ({
  active: null,
  dropTargetTrackId: null,
  visual: null,
  absorptionTarget: null,
  begin: (active, visual) =>
    set({
      active,
      dropTargetTrackId: null,
      visual: visual ?? null,
      absorptionTarget: null,
    }),
  moveVisual: (clientX, clientY) =>
    set((state) =>
      state.active === null || state.visual === null
        ? state
        : { visual: { ...state.visual, clientX, clientY } },
    ),
  claimDropTarget: (trackId, absorptionTarget) =>
    set((state) =>
      state.dropTargetTrackId === trackId &&
      state.absorptionTarget === absorptionTarget
        ? state
        : {
            dropTargetTrackId: trackId,
            absorptionTarget: absorptionTarget ?? null,
          },
    ),
  releaseDropTarget: (trackId) =>
    set((state) =>
      state.dropTargetTrackId === trackId
        ? { dropTargetTrackId: null, absorptionTarget: null }
        : state,
    ),
  end: () =>
    set({
      active: null,
      dropTargetTrackId: null,
      visual: null,
      absorptionTarget: null,
    }),
}));

export function mediaPlacementDurationUs(media: MediaSummary): number {
  // Matches add_media_layer's user-visible defaults. Still images get a
  // useful timeline span; animated images with a probed duration keep it.
  if (media.kind === "Image") {
    const durationUs = media.duration_us;
    return durationUs !== null && durationUs >= 500_000
      ? durationUs
      : DEFAULT_IMAGE_DURATION_US;
  }
  return media.duration_us ?? FALLBACK_MEDIA_DURATION_US;
}

export function mediaDragPayload(media: MediaSummary): MediaDragPayload {
  return {
    mediaId: media.id,
    kind: media.kind,
    label: media.label,
    durationUs: mediaPlacementDurationUs(media),
  };
}

export function parseMediaDrag(e: React.DragEvent): MediaDragPayload | null {
  try {
    const raw = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MediaDragPayload>;
    if (
      typeof parsed.mediaId !== "string" ||
      typeof parsed.kind !== "string" ||
      typeof parsed.label !== "string" ||
      typeof parsed.durationUs !== "number"
    ) {
      return null;
    }
    return parsed as MediaDragPayload;
  } catch {
    return null;
  }
}

function mediaOverlapClass(kind: string): LayerOverlapClass {
  return kind === "Audio" ? "audio" : "visual";
}

export function planMediaDrop({
  track,
  media,
  pointerXPx,
  pxPerSec,
  fpsNum,
  fpsDen,
  snap,
}: {
  track: TrackSummary;
  media: MediaDragPayload;
  pointerXPx: number;
  pxPerSec: number;
  fpsNum: number;
  fpsDen: number;
  snap?: MediaDropSnapOptions;
}): MediaDropPlan {
  const baseRawStartUs = Math.max(
    0,
    Math.round(
      ((pointerXPx - MEDIA_DRAG_CURSOR_OFFSET_PX) / pxPerSec) * 1_000_000,
    ),
  );
  // add_media_layer creates tEnd from the *raw* start plus source duration,
  // then applyAddLayer snaps both edges independently. This mirrors the
  // frame-grid case; Audio commits on the sample grid instead (ADR 0038), so
  // an audio ghost can sit a sub-frame off its committed layer.
  const baseTStartUs = snapFrameRound(baseRawStartUs, fpsNum, fpsDen);
  const baseTEndUs = snapFrameRound(
    baseRawStartUs + media.durationUs,
    fpsNum,
    fpsDen,
  );
  const boundaryDeltaUs = snap
    ? snapDragDeltaToTimelineBoundary({
        state: {
          kind: "move",
          // The incoming layer has no project id yet. This sentinel cannot
          // match a live layer, so every visible boundary remains eligible.
          layerId: "__media-drop-ghost__",
          originalTStart: baseTStartUs,
          originalTEnd: baseTEndUs,
          escapeGroup: true,
        },
        frameDeltaUs: 0,
        visibleTracks: snap.visibleTracks,
        groups: snap.groups,
        groupByLayerId: snap.groupByLayerId,
        currentTimeUs: snap.currentTimeUs,
        fpsNum,
        fpsDen,
        pxPerSec,
        enabled: snap.enabled,
        strengthPx: snap.strengthPx,
      })
    : 0;
  // Apply the chosen boundary delta to the actor input, then recompute both
  // snapped edges. The ghost and collision interval therefore match the
  // committed layer even at fractional frame rates.
  const rawStartUs = Math.max(0, baseRawStartUs + boundaryDeltaUs);
  const tStartUs = snapFrameRound(rawStartUs, fpsNum, fpsDen);
  const tEndUs = snapFrameRound(
    rawStartUs + media.durationUs,
    fpsNum,
    fpsDen,
  );
  const overlapClass = mediaOverlapClass(media.kind);
  const evaluation = evaluateTimelinePlacements({
    tracks: [track],
    placements: [
      {
        layerId: "__media-drop-ghost__",
        trackId: track.id,
        tStartUs,
        tEndUs,
        overlapClass,
        locked: false,
      },
    ],
    replacedLayerIds: new Set(),
  });

  return {
    rawStartUs,
    tStartUs,
    tEndUs,
    validity: evaluation.validity,
    conflictingLayerIds: evaluation.conflictingLayerIds,
    overlapClass,
    sharesLane: evaluation.sharesLane,
  };
}
