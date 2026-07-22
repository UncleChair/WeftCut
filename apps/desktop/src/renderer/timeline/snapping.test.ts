import { describe, expect, it } from "vitest";
import type { GroupSummary, LayerSummary, TrackSummary } from "../ipc";
import {
  snapDragDeltaToTimelineBoundary,
  snapTimeToTimelineBoundary,
} from "./snapping";

function layer(id: string, startUs: number, endUs: number): LayerSummary {
  return {
    id,
    label: null,
    t_start_us: startUs,
    t_end_us: endUs,
    kind: "Color",
    color_hint: "#4488cc",
    enabled: true,
    locked: false,
    params: {
      kind: "Color",
      color: {
        mode: "Static",
        value: { r: 0, g: 0, b: 0, a: 1 },
      },
      width: 1920,
      height: 1080,
    },
    effects: [],
  };
}

function track(layers: LayerSummary[]): TrackSummary {
  return {
    id: "track-1",
    kind: "Video",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers,
  };
}

function baseOpts(overrides: {
  visibleTracks?: TrackSummary[];
  groups?: GroupSummary[];
  groupByLayerId?: Map<string, string>;
  currentTimeUs?: number;
  enabled?: boolean;
} = {}) {
  return {
    visibleTracks: overrides.visibleTracks ?? [track([])],
    groups: overrides.groups ?? [],
    groupByLayerId: overrides.groupByLayerId ?? new Map<string, string>(),
    currentTimeUs: overrides.currentTimeUs ?? 3_000_000,
    fpsNum: 30,
    fpsDen: 1,
    pxPerSec: 100,
    enabled: overrides.enabled ?? true,
    strengthPx: 20,
  };
}

describe("timeline snapping", () => {
  it("keeps move snapping by aligning a moved edge to the playhead", () => {
    const deltaUs = snapDragDeltaToTimelineBoundary({
      ...baseOpts(),
      state: {
        kind: "move",
        layerId: "layer-1",
        originalTStart: 1_000_000,
        originalTEnd: 2_000_000,
        escapeGroup: false,
      },
      frameDeltaUs: 950_000,
    });

    expect(deltaUs).toBe(1_000_000);
  });

  it("snaps an out-trim edge to the playhead", () => {
    const deltaUs = snapDragDeltaToTimelineBoundary({
      ...baseOpts(),
      state: {
        kind: "trim-end",
        layerId: "layer-1",
        originalTStart: 0,
        originalTEnd: 2_000_000,
        escapeGroup: false,
      },
      frameDeltaUs: 950_000,
    });

    expect(deltaUs).toBe(1_000_000);
  });

  it("allows an out-trim snap that leaves exactly one frame", () => {
    const deltaUs = snapDragDeltaToTimelineBoundary({
      ...baseOpts({ currentTimeUs: 33_333 }),
      state: {
        kind: "trim-end",
        layerId: "layer-1",
        originalTStart: 0,
        originalTEnd: 2_000_000,
        escapeGroup: false,
      },
      frameDeltaUs: -1_950_000,
    });

    expect(deltaUs).toBe(-1_966_667);
  });

  it("snaps an in-trim edge to the playhead", () => {
    const deltaUs = snapDragDeltaToTimelineBoundary({
      ...baseOpts({ currentTimeUs: 1_000_000 }),
      state: {
        kind: "trim-start",
        layerId: "layer-1",
        originalTStart: 2_000_000,
        originalTEnd: 5_000_000,
        escapeGroup: false,
      },
      frameDeltaUs: -950_000,
    });

    expect(deltaUs).toBe(-1_000_000);
  });

  it("allows an in-trim snap that leaves exactly one frame", () => {
    const deltaUs = snapDragDeltaToTimelineBoundary({
      ...baseOpts({ currentTimeUs: 1_966_667 }),
      state: {
        kind: "trim-start",
        layerId: "layer-1",
        originalTStart: 0,
        originalTEnd: 2_000_000,
        escapeGroup: false,
      },
      frameDeltaUs: 1_950_000,
    });

    expect(deltaUs).toBe(1_966_667);
  });

  it("does not snap drag operations when disabled", () => {
    const deltaUs = snapDragDeltaToTimelineBoundary({
      ...baseOpts({ enabled: false }),
      state: {
        kind: "trim-end",
        layerId: "layer-1",
        originalTStart: 0,
        originalTEnd: 2_000_000,
        escapeGroup: false,
      },
      frameDeltaUs: 950_000,
    });

    expect(deltaUs).toBe(950_000);
  });

  it("snaps a blade cut point to the playhead", () => {
    const snappedUs = snapTimeToTimelineBoundary({
      ...baseOpts(),
      timeUs: 2_950_000,
      layerId: "layer-1",
      isValidSnap: (boundaryUs) =>
        boundaryUs > 1_000_000 && boundaryUs < 4_000_000,
    });

    expect(snappedUs).toBe(3_000_000);
  });

  it("snaps a blade cut point to visible layer boundaries", () => {
    const snappedUs = snapTimeToTimelineBoundary({
      ...baseOpts({
        visibleTracks: [
          track([
            layer("layer-1", 1_000_000, 4_000_000),
            layer("layer-2", 3_000_000, 5_000_000),
          ]),
        ],
        currentTimeUs: 10_000_000,
      }),
      timeUs: 2_950_000,
      layerId: "layer-1",
      isValidSnap: (boundaryUs) =>
        boundaryUs > 1_000_000 && boundaryUs < 4_000_000,
    });

    expect(snappedUs).toBe(3_000_000);
  });
});
