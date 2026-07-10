import { describe, expect, it } from "vitest";
import { rankEntries } from "./matcher";
import { pinyinHaystacks } from "./pinyin";
import type { SearchEntry, SearchEntryType } from "./types";

let n = 0;
function mk(type: SearchEntryType, label: string, extra: string[] = []): SearchEntry {
  const hay = [label, ...extra];
  const p = pinyinHaystacks(label);
  if (p) hay.push(p.full, p.initials);
  n += 1;
  return {
    key: `${type}:${n}`,
    type,
    label,
    context: "",
    haystacks: hay,
    payload: { type: "marker", markerId: String(n), tUs: 0 },
  };
}

describe("rankEntries", () => {
  it("matches full pinyin against a Chinese label", () => {
    const out = rankEntries("zimu", [mk("caption", "字幕第一行")]);
    expect(out.get("caption")).toHaveLength(1);
  });

  it("matches pinyin initials", () => {
    const out = rankEntries("zm", [mk("caption", "字幕第一行")]);
    expect(out.get("caption")).toHaveLength(1);
  });

  it("matches CJK queries against the original label", () => {
    const out = rankEntries("字幕", [mk("caption", "字幕第一行"), mk("caption", "别的内容")]);
    expect(out.get("caption")).toHaveLength(1);
    expect(out.get("caption")![0]!.entry.label).toBe("字幕第一行");
  });

  it("matches an extra haystack (en label on a zh entry)", () => {
    const out = rankEntries("export", [mk("command", "导出…", ["Export…"])]);
    expect(out.get("command")).toHaveLength(1);
  });

  it("drops non-matches", () => {
    const out = rankEntries("qqqq", [mk("media", "beach.mp4")]);
    expect(out.size).toBe(0);
  });

  it("empty query lists commands only (browse mode)", () => {
    const out = rankEntries("", [mk("command", "Save"), mk("media", "beach.mp4")]);
    expect(out.get("command")).toHaveLength(1);
    expect(out.has("media")).toBe(false);
  });

  it("caps each group at limitPerGroup", () => {
    const entries = Array.from({ length: 9 }, (_, i) => mk("clip", `clip ${i}`));
    const out = rankEntries("clip", entries, 5);
    expect(out.get("clip")).toHaveLength(5);
  });

  it("highlight indexes point into the label only for direct label matches", () => {
    const direct = rankEntries("bea", [mk("media", "beach.mp4")]).get("media")![0]!;
    expect(direct.highlight.length).toBeGreaterThan(0);
    const viaPinyin = rankEntries("zm", [mk("caption", "字幕")]).get("caption")![0]!;
    expect(viaPinyin.highlight).toHaveLength(0);
  });

  it("command boost raises score over an identical-label non-command", () => {
    const out = rankEntries("export", [mk("clip", "Export project"), mk("command", "Export project")]);
    expect(out.get("command")![0]!.score).toBeGreaterThan(out.get("clip")![0]!.score);
  });

  it("prefix matches rank first within a group", () => {
    const out = rankEntries("save", [mk("clip", "project saver"), mk("clip", "save project")]);
    expect(out.get("clip")![0]!.entry.label).toBe("save project");
  });

  it("browse mode floors the command cap at 8 even when limitPerGroup is smaller", () => {
    const cmds = Array.from({ length: 10 }, (_, i) => mk("command", `command ${i}`));
    expect(rankEntries("", cmds, 3).get("command")).toHaveLength(8);
  });
});
