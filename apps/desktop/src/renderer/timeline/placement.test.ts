import { describe, expect, it } from "vitest";

import type { LayerSummary, TrackSummary } from "../ipc";
import {
  evaluateTimelinePlacements,
  placementRefuses,
  previewTrackId,
  SPAWN_TRACK_ID,
  type TimelinePlacement,
} from "./placement";

function layer(
  id: string,
  tStartUs: number,
  tEndUs: number,
  kind: "visual" | "audio" = "visual",
): LayerSummary {
  return {
    id,
    kind: kind === "audio" ? "Audio" : "Color",
    label: id,
    t_start_us: tStartUs,
    t_end_us: tEndUs,
    enabled: true,
    locked: false,
    color_hint: "#888",
    params: {
      kind: kind === "audio" ? "Audio" : "Color",
    } as LayerSummary["params"],
    effects: [],
  };
}

function track(
  id: string,
  layers: LayerSummary[],
  locked = false,
): TrackSummary {
  return {
    id,
    kind: "Video",
    label: id,
    enabled: true,
    locked,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers,
  };
}

function placement(
  layerId: string,
  trackId: string,
  tStartUs: number,
  tEndUs: number,
  overlapClass: "visual" | "audio" = "visual",
): TimelinePlacement {
  return { layerId, trackId, tStartUs, tEndUs, overlapClass, locked: false };
}

describe("evaluateTimelinePlacements", () => {
  it("reports a same-class collision while excluding the layer's old position", () => {
    const result = evaluateTimelinePlacements({
      tracks: [
        track("track-1", [
          layer("stationary", 0, 2_000_000),
          layer("moving", 2_000_000, 4_000_000),
        ]),
      ],
      placements: [placement("moving", "track-1", 1_000_000, 3_000_000)],
      replacedLayerIds: new Set(["moving"]),
    });

    expect(result).toEqual({
      validity: "collision",
      conflictingLayerIds: ["stationary"],
      sharesLane: false,
    });
  });

  it("allows visual and audio placements to share a track", () => {
    const result = evaluateTimelinePlacements({
      tracks: [track("track-1", [layer("audio", 0, 2_000_000, "audio")])],
      placements: [placement("moving", "track-1", 1_000_000, 3_000_000)],
      replacedLayerIds: new Set(["moving"]),
    });

    expect(result.validity).toBe("valid");
    expect(result.conflictingLayerIds).toEqual([]);
    expect(result.sharesLane).toBe(true);
  });

  it("detects collisions between two projected group members", () => {
    const result = evaluateTimelinePlacements({
      tracks: [track("track-1", []), track("track-2", [])],
      placements: [
        placement("anchor", "track-2", 1_000_000, 3_000_000),
        placement("sibling", "track-2", 2_000_000, 4_000_000),
      ],
      replacedLayerIds: new Set(["anchor", "sibling"]),
    });

    expect(result.validity).toBe("collision");
    expect(result.conflictingLayerIds).toEqual(["anchor", "sibling"]);
  });

  it("treats touching half-open ranges as valid", () => {
    const result = evaluateTimelinePlacements({
      tracks: [track("track-1", [layer("before", 0, 1_000_000)])],
      placements: [placement("moving", "track-1", 1_000_000, 2_000_000)],
      replacedLayerIds: new Set(["moving"]),
    });

    expect(result.validity).toBe("valid");
  });

  it("reports a locked target before collision validity", () => {
    const result = evaluateTimelinePlacements({
      tracks: [track("track-1", [layer("stationary", 0, 2_000_000)], true)],
      placements: [placement("moving", "track-1", 1_000_000, 3_000_000)],
      replacedLayerIds: new Set(["moving"]),
    });

    expect(result.validity).toBe("locked");
    expect(result.conflictingLayerIds).toEqual(["stationary"]);
  });

  // The fourth outcome (ADR 0042): "no lane can take this, so spawn one".
  it("answers spawn for the spawn target, whatever the committed timeline holds", () => {
    const result = evaluateTimelinePlacements({
      // Every lane in the project is occupied across the placement's span and
      // one of them is locked — none of that reaches a lane that does not exist.
      tracks: [
        track("track-1", [layer("busy", 0, 10_000_000)]),
        track("track-2", [layer("also-busy", 0, 10_000_000)], true),
      ],
      placements: [
        placement("incoming", SPAWN_TRACK_ID, 1_000_000, 3_000_000),
      ],
      replacedLayerIds: new Set(),
    });

    expect(result).toEqual({
      validity: "spawn",
      conflictingLayerIds: [],
      sharesLane: false,
    });
  });

  it("refuses a spawn whose own projections would overlap on the one new lane", () => {
    const result = evaluateTimelinePlacements({
      tracks: [],
      placements: [
        placement("anchor", SPAWN_TRACK_ID, 0, 2_000_000),
        placement("sibling", SPAWN_TRACK_ID, 1_000_000, 3_000_000),
      ],
      replacedLayerIds: new Set(["anchor", "sibling"]),
    });

    expect(result.validity).toBe("collision");
    expect(result.conflictingLayerIds).toEqual(["anchor", "sibling"]);
  });

  it("keeps a locked subject refused even when the destination is spawned", () => {
    const result = evaluateTimelinePlacements({
      tracks: [],
      placements: [
        { ...placement("incoming", SPAWN_TRACK_ID, 0, 2_000_000), locked: true },
      ],
      replacedLayerIds: new Set(),
    });

    expect(result.validity).toBe("locked");
  });

  it("lets opposite-class projections share the spawned lane", () => {
    const result = evaluateTimelinePlacements({
      tracks: [],
      placements: [
        placement("visual", SPAWN_TRACK_ID, 0, 2_000_000),
        placement("audio", SPAWN_TRACK_ID, 0, 2_000_000, "audio"),
      ],
      replacedLayerIds: new Set(["visual", "audio"]),
    });

    expect(result.validity).toBe("spawn");
    expect(result.sharesLane).toBe(true);
  });
});

// Two consequences of `"spawn"` being COMMITTABLE, both of which showed up as
// wrong chrome before they were stated once: a `!== "valid"` test reads a raise as
// a refusal, and a destination that names no lane leaves the dragged chip with
// nowhere to render.
describe("placementRefuses", () => {
  it("refuses only collision and lock — a spawn is a destination being created", () => {
    expect(placementRefuses("collision")).toBe(true);
    expect(placementRefuses("locked")).toBe(true);
    expect(placementRefuses("spawn")).toBe(false);
    expect(placementRefuses("valid")).toBe(false);
  });
});

describe("previewTrackId", () => {
  it("previews a raise on the lane the clip is still on", () => {
    expect(previewTrackId(SPAWN_TRACK_ID, "track-1")).toBe("track-1");
  });

  it("previews on the destination lane once there is one", () => {
    expect(previewTrackId("track-2", "track-1")).toBe("track-2");
    expect(previewTrackId(null, "track-1")).toBe("track-1");
  });
});
