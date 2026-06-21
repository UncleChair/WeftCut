import { describe, expect, it } from "vitest";
import { groupPeekItems, peekCategory, type PeekItem } from "./peek";
import type { LayerSummary } from "../ipc";

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
