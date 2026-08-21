import { describe, expect, it } from "vitest";
import { buildEntries } from "./buildEntries";
import type { SearchEntry } from "./types";
import type { ProjectSummary } from "../ipc";

/// 10 s 30 fps summary: video track (clip at 2 s), caption track (one real
/// Text layer + one whitespace-only Text layer), a B-Roll track whose clip
/// reuses media m1 EARLIER (500 ms — exercises the usage sort), one labeled
/// + one blank-label marker, and one media item.
function fixtureSummary(): ProjectSummary {
  return {
    project_id: "p1",
    name: "fixture",
    composition: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, duration_pinned: false, fps_locked: false },
    track_count: 3,
    layer_count: 5,
    duration_us: 10_000_000,
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [
      {
        id: "m1", label: "beach.mp4", path: "C:/x/beach.mp4", kind: "Video",
        duration_us: 5_000_000, width: 1920, height: 1080, size_bytes: 1,
        available: true, decode_route: { kind: "Original" } as never,
        codec: "h264", pix_fmt: "yuv420p",
      },
    ],
    tracks: [
      {
        id: "t1", kind: "Video", label: "A-Roll", enabled: true, locked: false,
        muted: false, solo: false, role: "a-roll", transient: false,
        layers: [
          {
            id: "l1", label: null, t_start_us: 2_000_000, t_end_us: 4_000_000,
            kind: "VideoClip", color_hint: "", enabled: true, locked: false,
            effects: [],
            params: {
              kind: "VideoClip", media_id: "m1", media_label: "beach.mp4",
              src_in_us: 0, src_out_us: 2_000_000,
              x: { mode: "Static", value: 0 }, y: { mode: "Static", value: 0 },
              scale_x: { mode: "Static", value: 1 }, scale_y: { mode: "Static", value: 1 },
              scale_linked: true,
              rotation_deg: { mode: "Static", value: 0 },
              anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
              opacity: { mode: "Static", value: 1 },
              speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0,
            },
          },
        ],
      },
      {
        id: "t2", kind: "Subtitle", label: null, enabled: true, locked: false,
        muted: false, solo: false, role: "caption", transient: false,
        layers: [
          {
            id: "lc", label: null, t_start_us: 1_000_000, t_end_us: 3_000_000,
            kind: "Text", color_hint: "", enabled: true, locked: false,
            effects: [],
            params: {
              kind: "Text", content: "字幕第一行",
              font_family: "Arial", font_size_px: 16, weight: 400, italic: false,
              align: "Center", anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
              color: { mode: "Static", value: { r: 255, g: 255, b: 255, a: 255 } },
              x: { mode: "Static", value: 0 }, y: { mode: "Static", value: 0 },
              scale_x: { mode: "Static", value: 1 }, scale_y: { mode: "Static", value: 1 },
              scale_linked: true,
              rotation_deg: { mode: "Static", value: 0 },
              opacity: { mode: "Static", value: 1 },
              outline: null, shadow: null,
              box_w: null, box_h: null, valign: "Middle", line_height: 0, letter_spacing: 0,
            },
          },
          {
            id: "lc2", label: null, t_start_us: 4_000_000, t_end_us: 5_000_000,
            kind: "Text", color_hint: "", enabled: true, locked: false,
            effects: [],
            params: {
              kind: "Text", content: "   ",
              font_family: "Arial", font_size_px: 16, weight: 400, italic: false,
              align: "Center", anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
              color: { mode: "Static", value: { r: 255, g: 255, b: 255, a: 255 } },
              x: { mode: "Static", value: 0 }, y: { mode: "Static", value: 0 },
              scale_x: { mode: "Static", value: 1 }, scale_y: { mode: "Static", value: 1 },
              scale_linked: true,
              rotation_deg: { mode: "Static", value: 0 },
              opacity: { mode: "Static", value: 1 },
              outline: null, shadow: null,
              box_w: null, box_h: null, valign: "Middle", line_height: 0, letter_spacing: 0,
            },
          },
        ],
      },
      {
        id: "t3", kind: "Video", label: "B-Roll", enabled: true, locked: false,
        muted: false, solo: false, role: "b-roll", transient: false,
        layers: [
          {
            id: "l2", label: null, t_start_us: 500_000, t_end_us: 1_500_000,
            kind: "VideoClip", color_hint: "", enabled: true, locked: false,
            effects: [],
            params: {
              kind: "VideoClip", media_id: "m1", media_label: "beach.mp4",
              src_in_us: 0, src_out_us: 1_000_000,
              x: { mode: "Static", value: 0 }, y: { mode: "Static", value: 0 },
              scale_x: { mode: "Static", value: 1 }, scale_y: { mode: "Static", value: 1 },
              scale_linked: true,
              rotation_deg: { mode: "Static", value: 0 },
              anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
              opacity: { mode: "Static", value: 1 },
              speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0,
            },
          },
          // Unnamed AND media-less: the only layer here that reaches the
          // translated-kind fallback. Starts after l2 so it can't disturb the
          // earliest-layer assertions.
          {
            id: "l3", label: null, t_start_us: 6_000_000, t_end_us: 7_000_000,
            kind: "Color", color_hint: "", enabled: true, locked: false,
            effects: [],
            params: {
              kind: "Color",
              color: { mode: "Static", value: { r: 0, g: 0, b: 0, a: 255 } },
              width: 1920, height: 1080,
            },
          },
        ],
      },
    ],
    markers: [
      {
        id: "mk1", t_us: 5_000_000, end_t_us: null, label: "章节一", color_hint: "",
      },
      {
        id: "mk2", t_us: 6_000_000, end_t_us: null, label: "  ", color_hint: "",
      },
    ],
    groups: [],
    audio_roles: [],
  };
}

const CMDS = [
  { id: "save", label: "保存", enLabel: "Save", actionId: "save" as const },
];

/// Stand-in for a zh-CN UI: `t` translates, `tEn` returns the en-US name via
/// `defaultValue` (which is the raw kind). Stubs rather than real i18n keeps
/// this a pure-function test, and the deliberate zh/en split is what proves the
/// en-US name still lands in the haystacks.
const LOCALE = {
  t: (key: string, values: Record<string, unknown>) =>
    key === "kinds.color" ? "颜色" : String(values.defaultValue),
  tEn: (_key: string, values: Record<string, unknown>) =>
    String(values.defaultValue),
};

function byKey(entries: SearchEntry[], key: string): SearchEntry {
  const e = entries.find((x) => x.key === key);
  if (!e) throw new Error(`missing entry ${key}`);
  return e;
}

describe("buildEntries", () => {
  it("null summary → command entries only", () => {
    const out = buildEntries(null, CMDS, LOCALE);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("command");
    // zh label + en label + pinyin of the zh label
    expect(out[0]!.haystacks).toContain("保存");
    expect(out[0]!.haystacks).toContain("Save");
    expect(out[0]!.haystacks).toContain("baocun");
    expect(out[0]!.haystacks).toContain("bc");
  });

  it("emits media entries with timeline usages sorted by start", () => {
    const m = byKey(buildEntries(fixtureSummary(), [], LOCALE), "media:m1");
    expect(m.label).toBe("beach.mp4");
    // l2 is pushed AFTER l1 (t3 iterates after t1) but starts earlier —
    // sorted-first proves the tStartUs sort, not insertion order.
    expect(m.payload).toMatchObject({
      type: "media",
      mediaId: "m1",
      usages: [
        { layerId: "l2", trackId: "t3", tStartUs: 500_000 },
        { layerId: "l1", trackId: "t1", tStartUs: 2_000_000 },
      ],
    });
  });

  it("emits track entries with the earliest layer as jump target", () => {
    const t = byKey(buildEntries(fixtureSummary(), [], LOCALE), "track:t1");
    expect(t.payload).toMatchObject({ type: "track", firstLayerId: "l1" });
  });

  it("Text layers become caption entries (content = haystack), not clips", () => {
    const out = buildEntries(fixtureSummary(), [], LOCALE);
    const cap = out.find((e) => e.type === "caption");
    expect(cap).toBeDefined();
    expect(cap!.label).toBe("字幕第一行");
    expect(cap!.haystacks).toContain("zimudiyihang");
    expect(out.some((e) => e.type === "clip" && e.key.includes(cap!.key.split(":")[1]!))).toBe(false);
  });

  it("whitespace-only Text layers produce no entry at all", () => {
    const out = buildEntries(fixtureSummary(), [], LOCALE);
    expect(out.some((e) => e.key === "caption:lc2")).toBe(false);
    expect(out.some((e) => e.key === "clip:lc2")).toBe(false);
  });

  it("clip entries fall back label → media_label and carry track · timecode context", () => {
    const clip = byKey(buildEntries(fixtureSummary(), [], LOCALE), "clip:l1");
    expect(clip.label).toBe("beach.mp4");
    expect(clip.context).toBe("A-Roll · 00:00:02:00");
  });

  it("a media-less unnamed clip shows the localized kind and indexes the en-US one too", () => {
    const clip = byKey(buildEntries(fixtureSummary(), [], LOCALE), "clip:l3");
    // Displayed name follows the UI locale — same string the timeline block shows.
    expect(clip.label).toBe("颜色");
    // …but "color" still finds it on a zh-CN UI, and so does the pinyin.
    expect(clip.haystacks).toContain("Color");
    expect(clip.haystacks).toContain("yanse");
  });

  it("markers with labels become entries; unlabeled ones are skipped", () => {
    const out = buildEntries(fixtureSummary(), [], LOCALE);
    expect(byKey(out, "marker:mk1").payload).toMatchObject({ type: "marker", tUs: 5_000_000 });
    // mk2's label is whitespace-only — trimmed empty, so no entry.
    expect(out.some((e) => e.key === "marker:mk2")).toBe(false);
  });
});
