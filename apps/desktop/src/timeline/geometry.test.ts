import { describe, expect, it } from "vitest";
import {
  clamp,
  computeLayerSlices,
  formatRulerLabel,
  groupHue,
  indexGroups,
  layerOverlapClass,
  visualOrderedTracks,
} from "./geometry";
import type { LayerSummary, TrackSummary } from "../ipc";

function layer(partial: Partial<LayerSummary>): LayerSummary {
  return {
    id: "L",
    kind: "VideoClip",
    label: null,
    t_start_us: 0,
    t_end_us: 1_000_000,
    enabled: true,
    locked: false,
    color_hint: "#888",
    params: { kind: "VideoClip" } as LayerSummary["params"],
    ...partial,
  };
}

function track(partial: Partial<TrackSummary>): TrackSummary {
  return {
    id: "T",
    kind: "Video",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers: [],
    ...partial,
  };
}

describe("clamp", () => {
  it("clamps to bounds", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe("layerOverlapClass", () => {
  it("classifies Audio vs everything else", () => {
    expect(layerOverlapClass(layer({ params: { kind: "Audio" } as never }))).toBe("audio");
    expect(layerOverlapClass(layer({ params: { kind: "Text" } as never }))).toBe("visual");
  });
});

describe("computeLayerSlices", () => {
  it("gives full slice when no opposite-class overlap", () => {
    const a = layer({ id: "a" });
    const slices = computeLayerSlices([a]);
    expect(slices.get("a")).toBe("full");
  });
  it("splits overlapping visual+audio into top/bottom", () => {
    const v = layer({ id: "v", t_start_us: 0, t_end_us: 2_000_000 });
    const a = layer({
      id: "a",
      params: { kind: "Audio" } as never,
      t_start_us: 1_000_000,
      t_end_us: 3_000_000,
    });
    const slices = computeLayerSlices([v, a]);
    expect(slices.get("v")).toBe("top");
    expect(slices.get("a")).toBe("bottom");
  });
  it("keeps non-overlapping pairs full", () => {
    const v = layer({ id: "v", t_start_us: 0, t_end_us: 1_000_000 });
    const a = layer({
      id: "a",
      params: { kind: "Audio" } as never,
      t_start_us: 2_000_000,
      t_end_us: 3_000_000,
    });
    const slices = computeLayerSlices([v, a]);
    expect(slices.get("v")).toBe("full");
    expect(slices.get("a")).toBe("full");
  });
  it("treats touching but non-overlapping layers (half-open intervals) as full", () => {
    const v = layer({ id: "v", t_start_us: 0, t_end_us: 1_000_000 });
    const a = layer({
      id: "a",
      params: { kind: "Audio" } as never,
      t_start_us: 1_000_000,
      t_end_us: 2_000_000,
    });
    const slices = computeLayerSlices([v, a]);
    expect(slices.get("v")).toBe("full");
    expect(slices.get("a")).toBe("full");
  });
});

describe("visualOrderedTracks", () => {
  it("reverses data order and marks the role/extra boundary", () => {
    const t0 = track({ id: "t0", role: null, transient: true });
    const t1 = track({ id: "t1", role: "a-roll" as never });
    const t2 = track({ id: "t2", role: "b-roll" as never });
    const out = visualOrderedTracks([t0, t1, t2]);
    expect(out.map((v) => v.track.id)).toEqual(["t2", "t1", "t0"]);
    expect(out.map((v) => v.isGroupStart)).toEqual([false, false, true]);
  });
  it("produces isGroupStart === false for every entry when all tracks have role: null", () => {
    const tracks = [
      track({ id: "t0", role: null }),
      track({ id: "t1", role: null }),
      track({ id: "t2", role: null }),
    ];
    const out = visualOrderedTracks(tracks);
    expect(out.every((v) => v.isGroupStart === false)).toBe(true);
  });
});

describe("groupHue", () => {
  it("is deterministic, integer, in [0,360), and skips the 60-120 band for 20 ids", () => {
    for (let i = 0; i < 20; i++) {
      const id = `g-${i}`;
      const h = groupHue(id);
      expect(h).toBe(groupHue(id));
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
      expect(h < 60 || h >= 120).toBe(true);
    }
  });
});

describe("indexGroups", () => {
  it("maps layer ids to group ids", () => {
    const idx = indexGroups([
      { id: "g1", label: null, layer_ids: ["a", "b"] },
    ]);
    expect(idx.get("a")).toBe("g1");
    expect(idx.get("b")).toBe("g1");
    expect(idx.get("c")).toBeUndefined();
  });
});

describe("formatRulerLabel", () => {
  it("formats mm:ss for >=1s steps", () => {
    expect(formatRulerLabel(65, 5)).toBe("1:05");
  });
  it("formats centiseconds for sub-second steps", () => {
    expect(formatRulerLabel(1.25, 0.5)).toBe("0:01.25");
  });
});
