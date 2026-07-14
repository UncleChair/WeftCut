import { describe, expect, it } from "vitest";
import {
  clamp,
  computeTimelineExtent,
  computeLayerSlices,
  formatRulerLabel,
  groupHue,
  indexGroups,
  keyframeAbsoluteX,
  keyframeHitTest,
  keyframeXWithinClip,
  layerOverlapClass,
  trackHeaderControls,
  trackKeyframeProperties,
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
    effects: [],
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

describe("computeTimelineExtent", () => {
  it("gives a new project a longer ruler plus minimum edit padding", () => {
    expect(
      computeTimelineExtent({
        durationUs: 0,
        pxPerSec: 80,
        viewportWidthPx: 0,
      }),
    ).toEqual({ widthPx: 1040, totalSec: 13 });
  });

  it("fills a wide viewport and keeps 35% trailing NLE workspace", () => {
    expect(
      computeTimelineExtent({
        durationUs: 0,
        pxPerSec: 80,
        viewportWidthPx: 1000,
      }),
    ).toEqual({ widthPx: 1350, totalSec: 16.875 });
  });

  it("adds pixel-stable trailing workspace after a long composition", () => {
    expect(
      computeTimelineExtent({
        durationUs: 30_000_000,
        pxPerSec: 80,
        viewportWidthPx: 1000,
      }),
    ).toEqual({ widthPx: 2750, totalSec: 34.375 });
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

describe("keyframeXWithinClip", () => {
  it("maps a layer-local keyframe time to px within the clip width", () => {
    expect(keyframeXWithinClip(0, 4_000_000, 200)).toBe(0);
    expect(keyframeXWithinClip(2_000_000, 4_000_000, 200)).toBe(100);
    expect(keyframeXWithinClip(4_000_000, 4_000_000, 200)).toBe(200);
  });
  it("clamps out-of-range keyframes to the clip bounds", () => {
    expect(keyframeXWithinClip(-1_000_000, 4_000_000, 200)).toBe(0);
    expect(keyframeXWithinClip(5_000_000, 4_000_000, 200)).toBe(200);
  });
  it("returns 0 for a zero-duration clip", () => {
    expect(keyframeXWithinClip(1_000_000, 0, 200)).toBe(0);
  });
});

describe("keyframeHitTest", () => {
  const diamonds = [
    { id: "a", x: 10 },
    { id: "b", x: 100 },
  ];
  it("returns the id whose x is within the radius of pointerX", () => {
    expect(keyframeHitTest(diamonds, 12, 6)).toBe("a");
    expect(keyframeHitTest(diamonds, 103, 6)).toBe("b");
  });
  it("returns null when no diamond is within the radius", () => {
    expect(keyframeHitTest(diamonds, 50, 6)).toBeNull();
  });
  it("returns the nearest when two are within the radius", () => {
    expect(keyframeHitTest([{ id: "a", x: 10 }, { id: "b", x: 14 }], 11, 6)).toBe("a");
  });
});

describe("trackHeaderControls", () => {
  const audio = () =>
    layer({ id: "a", kind: "Audio", params: { kind: "Audio" } as LayerSummary["params"] });
  const video = () =>
    layer({ id: "v", kind: "VideoClip", params: { kind: "VideoClip" } as LayerSummary["params"] });

  it("pure visual track: eye only, no audio", () => {
    expect(trackHeaderControls(track({ layers: [video()] }))).toEqual({
      showEye: true,
      hasAudio: false,
    });
  });

  it("combined row (visual + audio): eye + audio", () => {
    expect(trackHeaderControls(track({ layers: [video(), audio()] }))).toEqual({
      showEye: true,
      hasAudio: true,
    });
  });

  it("pure audio lane: audio, no eye", () => {
    expect(trackHeaderControls(track({ layers: [audio()] }))).toEqual({
      showEye: false,
      hasAudio: true,
    });
  });

  it("empty track: eye only", () => {
    expect(trackHeaderControls(track({ layers: [] }))).toEqual({
      showEye: true,
      hasAudio: false,
    });
  });
});

describe("keyframeAbsoluteX", () => {
  it("maps t_start+t_us to absolute px", () => {
    // 50px/s: a key at t_us=2s on a clip starting at 1s → (1+2)s*50 = 150
    expect(keyframeAbsoluteX(1_000_000, 2_000_000, 50)).toBe(150);
  });
  it("handles out-of-range (negative) t_us", () => {
    expect(keyframeAbsoluteX(1_000_000, -2_000_000, 50)).toBe(-50);
  });
});

describe("trackKeyframeProperties", () => {
  const kfTrack = { mode: "Keyframed" as const, value: [{ id: "k", t_us: 0, value: 1, interp: { kind: "Linear" as const } }] };
  const staticTrack = { mode: "Static" as const, value: 1 };
  it("returns the union of keyframed params across the track's layers, in descriptor order", () => {
    const track = {
      kind: "Video", layers: [
        { id: "a", kind: "VideoClip", params: { kind: "VideoClip", x: kfTrack, opacity: staticTrack } },
        { id: "b", kind: "VideoClip", params: { kind: "VideoClip", opacity: kfTrack } },
      ],
    } as unknown as import("../ipc").TrackSummary;
    expect(trackKeyframeProperties(track).map((d) => d.paramKey)).toEqual(["x", "opacity"]);
  });
  it("returns empty when no layer has a keyframed param", () => {
    const track = { kind: "Video", layers: [{ id: "a", kind: "VideoClip", params: { kind: "VideoClip", opacity: staticTrack } }] } as unknown as import("../ipc").TrackSummary;
    expect(trackKeyframeProperties(track)).toEqual([]);
  });
});
