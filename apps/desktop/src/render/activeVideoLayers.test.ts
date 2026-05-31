import { describe, it, expect } from "vitest";
import { selectActiveVideoLayers, referencedVideoMediaIds } from "./activeVideoLayers";
import type { ProjectSummary } from "../ipc";

const layer = (over: Record<string, unknown>) => ({
  id: "L", label: null, t_start_us: 0, t_end_us: 1_000_000, kind: "VideoClip",
  color_hint: "#000", enabled: true, locked: false, effects: [],
  params: { kind: "VideoClip", media_id: "vid", media_label: "", src_in_us: 0, src_out_us: 1_000_000,
    x: 0, y: 0, scale_x: 1, scale_y: 1, opacity: 1, speed: 1, flip_h: false, flip_v: false,
    fade_in_us: 0, fade_out_us: 0 },
  ...over,
});
const summaryOf = (tracks: unknown[]): ProjectSummary =>
  ({ tracks } as unknown as ProjectSummary);

describe("selectActiveVideoLayers", () => {
  it("selects enabled VideoClip layers on enabled tracks overlapping [aUs, bUs]", () => {
    const s = summaryOf([
      { enabled: true, layers: [layer({ id: "A", params: { kind: "VideoClip", media_id: "a", src_in_us: 0 } })] },
    ]);
    expect(selectActiveVideoLayers(s, 0, 999_999).map((l) => l.layerId)).toEqual(["A"]);
  });

  it("skips disabled tracks, disabled layers, and non-VideoClip layers", () => {
    const s = summaryOf([
      { enabled: false, layers: [layer({ id: "offtrack" })] },
      { enabled: true, layers: [layer({ id: "offlayer", enabled: false })] },
      { enabled: true, layers: [layer({ id: "audio", params: { kind: "Audio", media_id: "x" } })] },
      { enabled: true, layers: [layer({ id: "keep", params: { kind: "VideoClip", media_id: "k", src_in_us: 0 } })] },
    ]);
    expect(selectActiveVideoLayers(s, 0, 999_999).map((l) => l.layerId)).toEqual(["keep"]);
  });

  it("excludes layers outside [aUs, bUs] (bUs inclusive)", () => {
    const s = summaryOf([
      { enabled: true, layers: [
        layer({ id: "before", t_start_us: 0, t_end_us: 100 }),   // ends at 100 → excluded when aUs=100
        layer({ id: "after", t_start_us: 200, t_end_us: 300 }),  // starts at 200 → excluded when bUs=199
      ] },
    ]);
    expect(selectActiveVideoLayers(s, 100, 199).map((l) => l.layerId)).toEqual([]);
  });
});

describe("referencedVideoMediaIds", () => {
  it("returns distinct media ids for layers overlapping [startUs, endUs)", () => {
    const s = summaryOf([
      { enabled: true, layers: [
        layer({ id: "A", t_start_us: 0, t_end_us: 500, params: { kind: "VideoClip", media_id: "a", src_in_us: 0 } }),
        layer({ id: "B", t_start_us: 500, t_end_us: 1000, params: { kind: "VideoClip", media_id: "a", src_in_us: 0 } }),
        layer({ id: "C", t_start_us: 2000, t_end_us: 3000, params: { kind: "VideoClip", media_id: "c", src_in_us: 0 } }),
      ] },
    ]);
    // Range [0, 1000): A and B (both media "a"); C excluded.
    expect([...referencedVideoMediaIds(s, 0, 1000)].sort()).toEqual(["a"]);
  });
});
