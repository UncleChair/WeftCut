import { describe, expect, it } from "vitest";
import { filterEffects, groupEffects, type EffectPickItem } from "./effectPickerMatch";
import { listEffects } from "../render/effects/effectRegistry";
import en from "../i18n/locales/en-US";
import zh from "../i18n/locales/zh-CN";

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

// The fixtures above prove the matcher; these prove the catalog the app
// actually ships is reachable through it. Data-driven off `listEffects()`, so
// a new entry whose label nobody can type turns this red the day it lands.
describe("the shipped catalog", () => {
  const at = (loc: unknown, dotted: string): string =>
    dotted.split(".").reduce<any>((acc, k) => acc?.[k], loc) as string;

  /// Picker rows built the way `useCatalogItems` builds them — catalog entry
  /// plus the locale's own strings.
  const rowsIn = (loc: unknown): EffectPickItem[] =>
    listEffects().map((d) => ({
      kind: d.kind,
      label: at(loc, d.nameI18nKey),
      desc: at(loc, `effects.${d.kind}.desc`),
      category: d.category,
      categoryLabel: at(loc, `effects.category.${d.category}`),
    }));

  for (const [locale, loc] of Object.entries({ "en-US": en, "zh-CN": zh })) {
    it(`every entry is findable by the name it shows in ${locale}`, () => {
      const rows = rowsIn(loc);
      for (const row of rows) {
        expect(filterEffects(row.label, rows)[0]?.kind, `${locale} "${row.label}"`)
          .toBe(row.kind);
      }
    });
  }

  it("typing an English name prefix reaches the colour trio", () => {
    const rows = rowsIn(en);
    for (const [query, kind] of [["bright", "brightness"], ["contr", "contrast"], ["satur", "saturation"]]) {
      expect(filterEffects(query!, rows)[0]?.kind, query).toBe(kind);
    }
  });

  it("groups the trio under Color, in registration order", () => {
    const groups = groupEffects(rowsIn(en));
    const color = groups.find((g) => g.category === "color")!;
    expect(color.label).toBe("Color");
    expect(color.items.map((i) => i.kind)).toEqual(["brightness", "contrast", "saturation"]);
  });
});
