import { describe, expect, it } from "vitest";
import {
  buildPeekItems,
  groupPeekItems,
  peekCategory,
  type PeekItem,
} from "./peek";
import type { LayerSummary, TrackSummary } from "../ipc";

function item(id: string, kind: string): PeekItem {
  return {
    layer: {
      id,
      kind,
      label: null,
      t_start_us: 0,
      t_end_us: 1_000_000,
      enabled: true,
      locked: false,
      color_hint: "#888",
      params: { kind } as LayerSummary["params"],
      effects: [],
    },
    trackId: `track-${id}`,
    trackLabel: id,
    trackKind: kind,
    offsetUs: 0,
    spansPlayhead: true,
  };
}

describe("peekCategory", () => {
  it("maps Audio to audio", () => expect(peekCategory("Audio")).toBe("audio"));
  it("maps Text to text", () => {
    expect(peekCategory("Text")).toBe("text");
  });
  it("maps every visual kind to video", () => {
    for (const k of ["VideoClip", "ImageOverlay", "Color", "Motif"]) {
      expect(peekCategory(k)).toBe("video");
    }
  });
});

describe("groupPeekItems", () => {
  const items = [item("v", "VideoClip"), item("a", "Audio"), item("s", "Text")];

  it("filter=all returns sections in video/audio/text order", () => {
    const sections = groupPeekItems(items, "all");
    expect(sections.map((s) => s.category)).toEqual(["video", "audio", "text"]);
    expect(sections.map((s) => s.items.length)).toEqual([1, 1, 1]);
  });

  it("a specific filter returns only that section", () => {
    const sections = groupPeekItems(items, "audio");
    expect(sections).toHaveLength(1);
    expect(sections[0]!.category).toBe("audio");
    expect(sections[0]!.items[0]!.layer.id).toBe("a");
  });

  it("filter with no matching items returns no sections", () => {
    expect(groupPeekItems([item("a", "Audio")], "video")).toEqual([]);
  });

  it("preserves input order within a section", () => {
    const two = [item("a1", "Audio"), item("a2", "Audio")];
    const [section] = groupPeekItems(two, "audio");
    expect(section!.items.map((i) => i.layer.id)).toEqual(["a1", "a2"]);
  });
});

function layer(
  id: string,
  startUs: number,
  endUs: number,
  kind = "Color",
): LayerSummary {
  return {
    id,
    kind,
    label: null,
    t_start_us: startUs,
    t_end_us: endUs,
    enabled: true,
    locked: false,
    color_hint: "#888",
    params: { kind } as LayerSummary["params"],
    effects: [],
  };
}

function track(
  id: string,
  role: TrackSummary["role"],
  layers: LayerSummary[],
): TrackSummary {
  return {
    id,
    kind: "Video",
    label: id,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role,
    transient: false,
    layers,
  };
}

// Playhead at 1s, ±0.5s window → intersection range [500_000, 1_500_000].
const NOW = 1_000_000;

describe("buildPeekItems windowing", () => {
  it("keeps only role-null layers that intersect the ±window", () => {
    const items = buildPeekItems(
      [
        track("t-in", null, [layer("in", 800_000, 1_200_000)]),
        // Assigned-role track: never surfaced by Nearby.
        track("t-role", "a-roll", [layer("role", 800_000, 1_200_000)]),
        // Ends exactly at the low edge (t_end <= lo) → excluded.
        track("t-before", null, [layer("before", 0, 500_000)]),
        // Starts exactly at the high edge (t_start >= hi) → excluded.
        track("t-after", null, [layer("after", 1_500_000, 2_000_000)]),
      ],
      NOW,
      500_000,
    );

    expect(items.map((i) => i.layer.id)).toEqual(["in"]);
  });

  it("flattens overlapping role-null tracks in time order", () => {
    const items = buildPeekItems(
      [
        track("t-late", null, [layer("late", 1_200_000, 1_400_000)]),
        track("t-early", null, [layer("early", 700_000, 900_000)]),
      ],
      NOW,
      5_000_000,
    );

    // Neither spans the playhead, so ordering is purely by start time.
    expect(items.map((i) => i.layer.id)).toEqual(["early", "late"]);
  });

  it("signs the offset by side and flags the spanning layer as LIVE", () => {
    const items = buildPeekItems(
      [
        track("t", null, [
          layer("span", 800_000, 1_200_000),
          layer("past", 700_000, 900_000),
          layer("future", 1_200_000, 1_400_000),
        ]),
      ],
      NOW,
      5_000_000,
    );

    // Spanning item sorts first (LIVE), then the rest by start time.
    expect(items.map((i) => i.layer.id)).toEqual(["span", "past", "future"]);
    const byId = new Map(items.map((i) => [i.layer.id, i]));
    expect(byId.get("span")!.spansPlayhead).toBe(true);
    expect(byId.get("span")!.offsetUs).toBe(0);
    expect(byId.get("past")!.offsetUs).toBe(-100_000);
    expect(byId.get("future")!.offsetUs).toBe(200_000);
  });
});
