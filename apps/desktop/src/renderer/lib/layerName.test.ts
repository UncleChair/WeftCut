import { describe, expect, it } from "vitest";
import { layerDisplayName } from "./layerName";
import { TEXT_NAME_MAX } from "../../shared/textSnippet";
import en from "../i18n/locales/en-US";
import zh from "../i18n/locales/zh-CN";
import type { AnimTrack, LayerSummary, Rgba } from "../ipc";

const num = (value: number): AnimTrack<number> => ({ mode: "Static", value });
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };

/// The same five-line i18next as trackName.test.ts's: dotted lookup plus
/// `{{name}}` substitution over the real locale bundles. Asserting the shipped
/// strings is the point — "the kind rung reads as 文本 in zh-CN" is not provable
/// against a stub that echoes its key.
const translator =
  (locale: unknown) =>
  (key: string, values: Record<string, unknown>): string => {
    const raw = key
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        locale,
      );
    if (typeof raw !== "string") return String(values.defaultValue ?? key);
    return raw.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
      String(values[name]),
    );
  };
const tEn = translator(en);
const tZh = translator(zh);

function textLayer(content: string, label: string | null = null): LayerSummary {
  return {
    id: "L-text",
    label,
    t_start_us: 0,
    t_end_us: 1_000_000,
    kind: "Text",
    color_hint: "#b17bc1",
    enabled: true,
    locked: false,
    params: {
      kind: "Text",
      content,
      font_family: "Inter",
      font_size_px: 48,
      weight: 400,
      italic: false,
      align: "Center",
      anchor_x: num(0.5),
      anchor_y: num(0.5),
      color: { mode: "Static", value: WHITE },
      x: num(0),
      y: num(0),
      scale_x: num(1),
      scale_y: num(1),
      scale_linked: true,
      rotation_deg: num(0),
      opacity: num(1),
      outline: null,
      shadow: null,
    },
    effects: [],
  };
}

function videoLayer(
  mediaLabel: string,
  label: string | null = null,
): LayerSummary {
  return {
    id: "L-video",
    label,
    t_start_us: 0,
    t_end_us: 1_000_000,
    kind: "VideoClip",
    color_hint: "#446688",
    enabled: true,
    locked: false,
    params: {
      kind: "VideoClip",
      media_id: "M1",
      media_label: mediaLabel,
      src_in_us: 0,
      src_out_us: 1_000_000,
      x: num(0),
      y: num(0),
      scale_x: num(1),
      scale_y: num(1),
      scale_linked: true,
      rotation_deg: num(0),
      anchor_x: num(0.5),
      anchor_y: num(0.5),
      opacity: num(1),
      speed: 1,
      flip_h: false,
      flip_v: false,
      fade_in_us: 0,
      fade_out_us: 0,
    },
    effects: [],
  };
}

describe("layerDisplayName", () => {
  it("prefers the layer's own label over every derived rung", () => {
    expect(layerDisplayName(videoLayer("beach.mp4", "Opening shot"), tEn)).toBe(
      "Opening shot",
    );
    expect(layerDisplayName(textLayer("Hello world", "Title card"), tEn)).toBe(
      "Title card",
    );
    // A stored label is user content: it reads the same in every locale.
    expect(layerDisplayName(textLayer("Hello world", "Title card"), tZh)).toBe(
      "Title card",
    );
  });

  it("falls back to the media label for a clip that has one", () => {
    expect(layerDisplayName(videoLayer("beach.mp4"), tEn)).toBe("beach.mp4");
  });

  // Nothing in the app writes a Text layer's label — `applyAddLayer` stores
  // `label: null` and an .srt import runs it per cue — so without this rung a
  // caption track is a hundred blocks all reading "Text".
  it("names an unlabelled Text layer by the words it renders", () => {
    expect(layerDisplayName(textLayer("Once upon a time"), tEn)).toBe(
      "Once upon a time",
    );
    // Content is user text too: no locale turns it into anything else.
    expect(layerDisplayName(textLayer("从前有座山"), tZh)).toBe("从前有座山");
  });

  // A caption is routinely two or three lines. Naming it by its raw content
  // would put a newline into a one-row chip, a history row and a tooltip.
  it("collapses newlines and whitespace runs into one line", () => {
    expect(layerDisplayName(textLayer("first line\nsecond line"), tEn)).toBe(
      "first line second line",
    );
    expect(layerDisplayName(textLayer("  spaced   out \t"), tEn)).toBe(
      "spaced out",
    );
  });

  // The cap is on what comes BACK, ellipsis included — a caller sizing a row
  // can trust the number without re-measuring.
  it("caps a pasted paragraph at the name budget, ellipsis inside it", () => {
    const name = layerDisplayName(textLayer("x".repeat(500)), tEn);
    expect(name).toHaveLength(TEXT_NAME_MAX);
    expect(name.endsWith("...")).toBe(true);
    // Exactly at the budget nothing is spent on dots.
    const exact = layerDisplayName(textLayer("y".repeat(TEXT_NAME_MAX)), tEn);
    expect(exact).toBe("y".repeat(TEXT_NAME_MAX));
  });

  // Blank content is absent, exactly as a blank label is: a zero-width name is
  // strictly worse than the kind word it displaced, and the panels that filter
  // empty names out would render a row with no name at all.
  it("falls through to the translated kind when the text is blank", () => {
    for (const blank of ["", "   ", "\n\t "]) {
      expect(layerDisplayName(textLayer(blank), tEn)).toBe("Text");
      expect(layerDisplayName(textLayer(blank), tZh)).toBe("文本");
    }
  });

  it("never returns the uuid", () => {
    const nameless = videoLayer("");
    expect(layerDisplayName(nameless, tEn)).toBe("Video");
    expect(layerDisplayName(nameless, tEn)).not.toContain(nameless.id);
  });
});
