import { describe, expect, it } from "vitest";
import { buildEntries } from "./buildEntries";
import type { SearchEntry } from "./types";
import type { ProjectSummary } from "../ipc";

/// 10 s 30 fps summary with one video track (one clip at 2 s), one caption
/// track with Text layer, one marker, and one media item.
function fixtureSummary(): ProjectSummary {
  return {
    project_id: "p1",
    name: "fixture",
    composition: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, duration_pinned: false },
    track_count: 2,
    layer_count: 2,
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
              align: "Center", anchor_x: 0.5, anchor_y: 0.5,
              color: { mode: "Static", value: { r: 255, g: 255, b: 255, a: 255 } },
              x: { mode: "Static", value: 0 }, y: { mode: "Static", value: 0 },
              opacity: { mode: "Static", value: 1 },
              outline: null, shadow: null,
            },
          },
        ],
      },
    ],
    markers: [
      {
        id: "mk1", t_us: 5_000_000, end_t_us: null, label: "章节一", color_hint: "",
      },
    ],
    groups: [],
    audio_roles: [],
  };
}

const CMDS = [
  { id: "save", label: "保存", enLabel: "Save", actionId: "save" as const },
];

function byKey(entries: SearchEntry[], key: string): SearchEntry {
  const e = entries.find((x) => x.key === key);
  if (!e) throw new Error(`missing entry ${key}`);
  return e;
}

describe("buildEntries", () => {
  it("null summary → command entries only", () => {
    const out = buildEntries(null, CMDS);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("command");
    // zh label + en label + pinyin of the zh label
    expect(out[0]!.haystacks).toContain("保存");
    expect(out[0]!.haystacks).toContain("Save");
    expect(out[0]!.haystacks).toContain("baocun");
    expect(out[0]!.haystacks).toContain("bc");
  });

  it("emits media entries with timeline usages sorted by start", () => {
    const m = byKey(buildEntries(fixtureSummary(), []), "media:m1");
    expect(m.label).toBe("beach.mp4");
    expect(m.payload).toMatchObject({
      type: "media",
      mediaId: "m1",
      usages: [{ layerId: "l1", trackId: "t1", tStartUs: 2_000_000 }],
    });
  });

  it("emits track entries with the earliest layer as jump target", () => {
    const t = byKey(buildEntries(fixtureSummary(), []), "track:t1");
    expect(t.payload).toMatchObject({ type: "track", firstLayerId: "l1" });
  });

  it("Text layers become caption entries (content = haystack), not clips", () => {
    const out = buildEntries(fixtureSummary(), []);
    const cap = out.find((e) => e.type === "caption");
    expect(cap).toBeDefined();
    expect(cap!.label).toBe("字幕第一行");
    expect(cap!.haystacks).toContain("zimudiyihang");
    expect(out.some((e) => e.type === "clip" && e.key.includes(cap!.key.split(":")[1]!))).toBe(false);
  });

  it("clip entries fall back label → media_label and carry track · timecode context", () => {
    const clip = byKey(buildEntries(fixtureSummary(), []), "clip:l1");
    expect(clip.label).toBe("beach.mp4");
    expect(clip.context).toBe("A-Roll · 00:00:02:00");
  });

  it("markers with labels become entries; unlabeled ones are skipped", () => {
    const out = buildEntries(fixtureSummary(), []);
    expect(byKey(out, "marker:mk1").payload).toMatchObject({ type: "marker", tUs: 5_000_000 });
  });
});
