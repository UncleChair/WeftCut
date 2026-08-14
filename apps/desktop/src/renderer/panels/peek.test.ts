import { describe, expect, it } from "vitest";
import {
  buildPeekItems,
  peekCategory,
  restackTargetForGap,
  splitPeekSections,
  type PeekItem,
} from "./peek";
import type { LayerSummary, TrackSummary } from "../ipc";

function item(
  id: string,
  kind: string,
  opts: { trackIndex?: number; spansPlayhead?: boolean } = {},
): PeekItem {
  const spans = opts.spansPlayhead ?? true;
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
    trackIndex: opts.trackIndex ?? 0,
    offsetUs: spans ? 0 : 100_000,
    spansPlayhead: spans,
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

describe("splitPeekSections", () => {
  it("splits on the playhead: spanning items go At-playhead, the rest Nearby", () => {
    const sections = splitPeekSections(
      [
        item("live", "VideoClip", { spansPlayhead: true }),
        item("soon", "VideoClip", { spansPlayhead: false }),
      ],
      "all",
    );
    expect(sections.atPlayhead.map((i) => i.layer.id)).toEqual(["live"]);
    expect(sections.nearby.map((i) => i.layer.id)).toEqual(["soon"]);
  });

  it("orders At-playhead visuals top-of-stack first, merging every visual kind", () => {
    // `Project.tracks` is ordered bottom-of-z-stack first, so the highest
    // track index composites on top and must render first. Visual kinds
    // (video / image / color / motif / text) interleave in one list.
    const sections = splitPeekSections(
      [
        item("bottom-video", "VideoClip", { trackIndex: 1 }),
        item("top-text", "Text", { trackIndex: 5 }),
        item("mid-motif", "Motif", { trackIndex: 3 }),
      ],
      "all",
    );
    expect(sections.atPlayhead.map((i) => i.layer.id)).toEqual([
      "top-text",
      "mid-motif",
      "bottom-video",
    ]);
  });

  it("sinks spanning audio rows to the section tail in their input order", () => {
    // Audio never sorts by z (it mixes by role, ADR 0023): even from the
    // topmost track it trails every visual, in the order it arrived.
    const sections = splitPeekSections(
      [
        item("a1", "Audio", { trackIndex: 9 }),
        item("v", "VideoClip", { trackIndex: 1 }),
        item("a2", "Audio", { trackIndex: 4 }),
      ],
      "all",
    );
    expect(sections.atPlayhead.map((i) => i.layer.id)).toEqual([
      "v",
      "a1",
      "a2",
    ]);
  });

  it("keeps the Nearby section in the existing proximity order", () => {
    // Nearby's sort is buildPeekItems' business; the split must not
    // rearrange it, whatever the track indices say.
    const sections = splitPeekSections(
      [
        item("n1", "VideoClip", { spansPlayhead: false, trackIndex: 7 }),
        item("n2", "Text", { spansPlayhead: false, trackIndex: 2 }),
        item("n3", "Audio", { spansPlayhead: false, trackIndex: 5 }),
      ],
      "all",
    );
    expect(sections.nearby.map((i) => i.layer.id)).toEqual(["n1", "n2", "n3"]);
  });

  it("applies a category filter to both sections", () => {
    const sections = splitPeekSections(
      [
        item("live-v", "VideoClip"),
        item("live-a", "Audio"),
        item("near-v", "VideoClip", { spansPlayhead: false }),
        item("near-a", "Audio", { spansPlayhead: false }),
      ],
      "audio",
    );
    expect(sections.atPlayhead.map((i) => i.layer.id)).toEqual(["live-a"]);
    expect(sections.nearby.map((i) => i.layer.id)).toEqual(["near-a"]);
  });

  it("a filter matching nothing leaves both sections empty", () => {
    const sections = splitPeekSections([item("v", "VideoClip")], "text");
    expect(sections.atPlayhead).toEqual([]);
    expect(sections.nearby).toEqual([]);
  });
});

describe("restackTargetForGap", () => {
  // Visible rows top-of-stack first, the At-playhead render order. The
  // dragged row is rows[fromIndex]; a gap g sits directly above rows[g].
  const rows = () => [
    item("top", "ImageOverlay", { trackIndex: 5 }),
    item("mid", "Text", { trackIndex: 3 }),
    item("bottom", "VideoClip", { trackIndex: 1 }),
  ];

  it("maps an interior gap to 'directly above the visible row below it'", () => {
    // Dragging the top row to the gap between mid and bottom.
    expect(restackTargetForGap(rows(), 0, 2)).toEqual({
      anchorId: "bottom",
      position: "above",
    });
  });

  it("maps the top gap to above the first visible row", () => {
    expect(restackTargetForGap(rows(), 2, 0)).toEqual({
      anchorId: "top",
      position: "above",
    });
  });

  it("maps the section-bottom gap to below the last visible row", () => {
    expect(restackTargetForGap(rows(), 0, 3)).toEqual({
      anchorId: "bottom",
      position: "below",
    });
  });

  it("reports the row's own gap and its following gap as no-ops", () => {
    expect(restackTargetForGap(rows(), 1, 1)).toBeNull();
    expect(restackTargetForGap(rows(), 1, 2)).toBeNull();
  });

  it("a single-row list has only no-op gaps", () => {
    const solo = [item("only", "VideoClip", { trackIndex: 2 })];
    expect(restackTargetForGap(solo, 0, 0)).toBeNull();
    expect(restackTargetForGap(solo, 0, 1)).toBeNull();
  });

  it("derives anchors from the visible rows only (filtered-out neighbours never anchor)", () => {
    // A category chip hid "mid": the function sees exactly what the user
    // sees, so the drop below the remaining top row anchors on "bottom" —
    // never on the hidden layer between them (ADR 0044 decision 5).
    const visible = [
      item("top", "ImageOverlay", { trackIndex: 5 }),
      item("bottom", "VideoClip", { trackIndex: 1 }),
    ];
    expect(restackTargetForGap(visible, 1, 0)).toEqual({
      anchorId: "top",
      position: "above",
    });
    expect(restackTargetForGap(visible, 0, 2)).toEqual({
      anchorId: "bottom",
      position: "below",
    });
  });

  it("an empty list or an out-of-range gap resolves to no-op", () => {
    expect(restackTargetForGap([], 0, 0)).toBeNull();
    expect(restackTargetForGap(rows(), 0, 4)).toBeNull();
    expect(restackTargetForGap(rows(), 0, -1)).toBeNull();
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

/// Key + args, so a name assertion says which rung of `trackDisplayName` ran
/// without pinning the English copy.
const T = (key: string, values: Record<string, unknown>): string =>
  values.n === undefined ? key : `${key}#${String(values.n)}`;

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
      T,
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
      T,
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
      T,
    );

    // Spanning item sorts first (LIVE), then the rest by start time.
    expect(items.map((i) => i.layer.id)).toEqual(["span", "past", "future"]);
    const byId = new Map(items.map((i) => [i.layer.id, i]));
    expect(byId.get("span")!.spansPlayhead).toBe(true);
    expect(byId.get("span")!.offsetUs).toBe(0);
    expect(byId.get("past")!.offsetUs).toBe(-100_000);
    expect(byId.get("future")!.offsetUs).toBe(200_000);
  });

  // z is exactly the track's position in the project array, so the item must
  // carry the index of its track in the *full* array — role tracks included —
  // for the At-playhead stack to order against.
  it("indexes each item's track by its position in the full track array", () => {
    const items = buildPeekItems(
      [
        track("t-role", "a-roll", [layer("skip", 800_000, 1_200_000)]),
        track("t-b", null, [layer("b", 800_000, 1_200_000)]),
        track("t-c", null, [layer("c", 700_000, 900_000)]),
      ],
      NOW,
      500_000,
      T,
    );

    const byId = new Map(items.map((i) => [i.layer.id, i]));
    expect(byId.get("b")!.trackIndex).toBe(1);
    expect(byId.get("c")!.trackIndex).toBe(2);
  });

  // The row's sublabel is the header's name, so an unnamed lane reads as its
  // position rather than as its dominant layer class.
  it("names each row's track the way the track header does", () => {
    const named = track("t-named", null, [layer("a", 800_000, 1_200_000)]);
    const unnamed = { ...track("t-plain", null, [layer("b", 800_000, 1_200_000)]), label: null };
    const items = buildPeekItems([named, unnamed], NOW, 5_000_000, T);
    const byId = new Map(items.map((i) => [i.layer.id, i]));
    expect(byId.get("a")!.trackLabel).toBe("t-named");
    expect(byId.get("b")!.trackLabel).toBe("tracks.positional#2");
  });
});

describe("section membership at the window edges", () => {
  it("layers touching the playhead are At-playhead; the rest of the window is Nearby", () => {
    const items = buildPeekItems(
      [
        // Ends exactly at the playhead (t_end == now) → still spanning.
        track("t-ends-now", null, [layer("ends-now", 600_000, NOW)]),
        // Starts exactly at the playhead (t_start == now) → spanning.
        track("t-starts-now", null, [layer("starts-now", NOW, 1_400_000)]),
        // Inside the window but strictly past → Nearby.
        track("t-past", null, [layer("past", 501_000, 999_999)]),
        // Inside the window but strictly future → Nearby.
        track("t-future", null, [layer("future", 1_000_001, 1_499_000)]),
      ],
      NOW,
      500_000,
      T,
    );

    const sections = splitPeekSections(items, "all");
    // Both spanning rows are visual, so they z-order top-of-stack first:
    // t-starts-now sits above t-ends-now in the track array.
    expect(sections.atPlayhead.map((i) => i.layer.id)).toEqual([
      "starts-now",
      "ends-now",
    ]);
    expect(sections.nearby.map((i) => i.layer.id)).toEqual(["past", "future"]);
  });
});
