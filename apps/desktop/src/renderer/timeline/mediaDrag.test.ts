import { describe, expect, it } from "vitest";

import type { LayerSummary, MediaSummary, TrackSummary } from "../ipc";
import {
  MEDIA_DRAG_CURSOR_OFFSET_PX,
  mediaDragPayload,
  mediaPlacementDurationUs,
  planMediaDrop,
} from "./mediaDrag";

const staticNum = (value: number) => ({ mode: "Static" as const, value });

function media(overrides: Partial<MediaSummary> = {}): MediaSummary {
  return {
    id: "media-1",
    label: "Interview",
    path: "C:/media/interview.mp4",
    kind: "Video",
    duration_us: 3_000_000,
    width: 1920,
    height: 1080,
    size_bytes: 1024,
    available: true,
    decode_route: { route: "bypass" },
    codec: "h264",
    pix_fmt: "yuv420p",
    ...overrides,
  };
}

function visualLayer(
  id: string,
  tStartUs: number,
  tEndUs: number,
): LayerSummary {
  return {
    id,
    label: id,
    t_start_us: tStartUs,
    t_end_us: tEndUs,
    kind: "VideoClip",
    color_hint: "#5588aa",
    enabled: true,
    locked: false,
    params: {
      kind: "VideoClip",
      media_id: "media-existing",
      media_label: "existing.mp4",
      src_in_us: 0,
      src_out_us: tEndUs - tStartUs,
      x: staticNum(0),
      y: staticNum(0),
      scale_x: staticNum(1),
      scale_y: staticNum(1),
      opacity: staticNum(1),
      speed: 1,
      flip_h: false,
      flip_v: false,
      fade_in_us: 0,
      fade_out_us: 0,
    },
    effects: [],
  };
}

function audioLayer(
  id: string,
  tStartUs: number,
  tEndUs: number,
): LayerSummary {
  return {
    id,
    label: id,
    t_start_us: tStartUs,
    t_end_us: tEndUs,
    kind: "Audio",
    color_hint: "#aa8855",
    enabled: true,
    locked: false,
    params: {
      kind: "Audio",
      media_id: "media-audio",
      media_label: "audio.wav",
      src_in_us: 0,
      src_out_us: tEndUs - tStartUs,
      gain_db: staticNum(0),
      pan: staticNum(0),
      fade_in_us: 0,
      fade_out_us: 0,
      mute: false,
      role: "music",
    },
    effects: [],
  };
}

function track(layers: LayerSummary[], locked = false): TrackSummary {
  return {
    id: "track-1",
    kind: "Video",
    label: "A roll",
    enabled: true,
    locked,
    muted: false,
    solo: false,
    role: "a-roll",
    transient: false,
    layers,
  };
}

describe("media drag placement", () => {
  it("uses source duration and the timeline defaults for missing durations", () => {
    expect(mediaPlacementDurationUs(media())).toBe(3_000_000);
    expect(mediaPlacementDurationUs(media({ duration_us: null }))).toBe(
      2_000_000,
    );
    expect(
      mediaPlacementDurationUs(
        media({ kind: "Image", duration_us: null }),
      ),
    ).toBe(3_000_000);
  });

  it("places the pointer a fixed distance inside the ghost", () => {
    const payload = mediaDragPayload(media());
    const plan = planMediaDrop({
      track: track([]),
      media: payload,
      pointerXPx: MEDIA_DRAG_CURSOR_OFFSET_PX + 80,
      pxPerSec: 80,
      fpsNum: 30,
      fpsDen: 1,
    });

    expect(plan.rawStartUs).toBe(1_000_000);
    expect(plan.tStartUs).toBe(1_000_000);
    expect(plan.tEndUs).toBe(4_000_000);
    expect(plan.validity).toBe("valid");
  });

  it("obeys the existing tail-snap setting for the ghost and final drop", () => {
    const payload = mediaDragPayload(media());
    const targetTrack = track([visualLayer("previous", 0, 2_000_000)]);
    const plan = planMediaDrop({
      track: targetTrack,
      media: payload,
      // Raw start=1.9s. At 100px/s and strength=20px, the existing 2s
      // boundary is inside the 200ms snap radius. Before snapping this also
      // overlaps the previous clip, so collision must be evaluated afterward.
      pointerXPx: MEDIA_DRAG_CURSOR_OFFSET_PX + 190,
      pxPerSec: 100,
      fpsNum: 30,
      fpsDen: 1,
      snap: {
        visibleTracks: [targetTrack],
        groups: [],
        groupByLayerId: new Map(),
        currentTimeUs: 10_000_000,
        enabled: true,
        strengthPx: 20,
      },
    });

    expect(plan.rawStartUs).toBe(2_000_000);
    expect(plan.tStartUs).toBe(2_000_000);
    expect(plan.tEndUs).toBe(5_000_000);
    expect(plan.validity).toBe("valid");
  });

  it("keeps the unsnapped frame position when tail snap is disabled", () => {
    const payload = mediaDragPayload(media());
    const targetTrack = track([visualLayer("previous", 0, 2_000_000)]);
    const plan = planMediaDrop({
      track: targetTrack,
      media: payload,
      pointerXPx: MEDIA_DRAG_CURSOR_OFFSET_PX + 210,
      pxPerSec: 100,
      fpsNum: 30,
      fpsDen: 1,
      snap: {
        visibleTracks: [targetTrack],
        groups: [],
        groupByLayerId: new Map(),
        currentTimeUs: 10_000_000,
        enabled: false,
        strengthPx: 20,
      },
    });

    expect(plan.rawStartUs).toBe(2_100_000);
    expect(plan.tStartUs).toBe(2_100_000);
  });

  it("snaps the ghost tail as well as its head", () => {
    const payload = mediaDragPayload(media());
    const targetTrack = track([visualLayer("next", 5_000_000, 6_000_000)]);
    const plan = planMediaDrop({
      track: targetTrack,
      media: payload,
      // Raw [1.9s,4.9s); its tail is within 100ms of the next clip's 5s edge.
      pointerXPx: MEDIA_DRAG_CURSOR_OFFSET_PX + 190,
      pxPerSec: 100,
      fpsNum: 30,
      fpsDen: 1,
      snap: {
        visibleTracks: [targetTrack],
        groups: [],
        groupByLayerId: new Map(),
        currentTimeUs: 10_000_000,
        enabled: true,
        strengthPx: 20,
      },
    });

    expect(plan.tStartUs).toBe(2_000_000);
    expect(plan.tEndUs).toBe(5_000_000);
    expect(plan.validity).toBe("valid");
  });

  it("reports same-class overlap as a collision but allows a shared AV row", () => {
    const payload = mediaDragPayload(media());
    const collision = planMediaDrop({
      track: track([visualLayer("video", 0, 2_000_000)]),
      media: payload,
      pointerXPx: MEDIA_DRAG_CURSOR_OFFSET_PX + 80,
      pxPerSec: 80,
      fpsNum: 30,
      fpsDen: 1,
    });
    const shared = planMediaDrop({
      track: track([audioLayer("audio", 0, 2_000_000)]),
      media: payload,
      pointerXPx: MEDIA_DRAG_CURSOR_OFFSET_PX + 80,
      pxPerSec: 80,
      fpsNum: 30,
      fpsDen: 1,
    });

    expect(collision.validity).toBe("collision");
    expect(collision.conflictingLayerIds).toEqual(["video"]);
    expect(shared.validity).toBe("valid");
    expect(shared.sharesLane).toBe(true);
  });

  it("treats touching half-open intervals as valid and reports locked tracks", () => {
    const payload = mediaDragPayload(media());
    const adjacent = planMediaDrop({
      track: track([visualLayer("video", 0, 1_000_000)]),
      media: payload,
      pointerXPx: MEDIA_DRAG_CURSOR_OFFSET_PX + 80,
      pxPerSec: 80,
      fpsNum: 30,
      fpsDen: 1,
    });
    const locked = planMediaDrop({
      track: track([], true),
      media: payload,
      pointerXPx: MEDIA_DRAG_CURSOR_OFFSET_PX + 80,
      pxPerSec: 80,
      fpsNum: 30,
      fpsDen: 1,
    });

    expect(adjacent.validity).toBe("valid");
    expect(locked.validity).toBe("locked");
  });
});
