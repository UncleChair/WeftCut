import { describe, expect, it } from "vitest";
import { filterEffects, groupEffects, type EffectPickItem } from "./effectPickerMatch";

const blur: EffectPickItem = {
  kind: "blur",
  label: "模糊",
  desc: "高斯柔化",
  category: "blur",
  categoryLabel: "模糊",
};
const chroma: EffectPickItem = {
  kind: "chromakey",
  label: "色度抠像",
  desc: "去除绿幕/蓝幕背景",
  category: "keying",
  categoryLabel: "抠像",
};
const grade: EffectPickItem = {
  kind: "grade",
  label: "Color Grade",
  desc: "Lift/gamma/gain",
  category: "color",
  categoryLabel: "Color",
};
const all = [blur, chroma, grade];

describe("filterEffects", () => {
  it("browse mode: an empty query returns the catalog in registration order", () => {
    expect(filterEffects("", all)).toEqual(all);
    expect(filterEffects("   ", all)).toEqual(all);
  });

  it("matches the raw kind, so an English query finds a CJK-labelled effect", () => {
    expect(filterEffects("chroma", all).map((i) => i.kind)).toEqual(["chromakey"]);
  });

  it("matches full pinyin and initials of a CJK label", () => {
    expect(filterEffects("mohu", all).map((i) => i.kind)).toContain("blur");
    expect(filterEffects("mh", all).map((i) => i.kind)).toContain("blur");
  });

  it("matches the CJK label itself", () => {
    expect(filterEffects("抠像", all).map((i) => i.kind)).toEqual(["chromakey"]);
  });

  it("drops everything when nothing scores above the floor", () => {
    expect(filterEffects("zzzzqq", all)).toEqual([]);
  });

  it("ranks a label prefix above a mid-string match", () => {
    const items: EffectPickItem[] = [
      { ...grade, kind: "sharp", label: "Unsharp Color", desc: "" },
      { ...grade, kind: "grade", label: "Color Grade", desc: "" },
    ];
    expect(filterEffects("color", items)[0]!.kind).toBe("grade");
  });
});

describe("groupEffects", () => {
  it("buckets into EFFECT_CATEGORY_ORDER and drops empty groups", () => {
    const groups = groupEffects(all);
    expect(groups.map((g) => g.category)).toEqual(["blur", "keying", "color"]);
    expect(groups[1]!.label).toBe("抠像");
    expect(groups[0]!.items.map((i) => i.kind)).toEqual(["blur"]);
  });

  it("group order stays fixed even when relevance reorders the flat list", () => {
    // grade (color) ranked first, blur last — the headers must not reshuffle.
    const groups = groupEffects([grade, chroma, blur]);
    expect(groups.map((g) => g.category)).toEqual(["blur", "keying", "color"]);
  });

  it("an empty result set produces no groups", () => {
    expect(groupEffects([])).toEqual([]);
  });
});
