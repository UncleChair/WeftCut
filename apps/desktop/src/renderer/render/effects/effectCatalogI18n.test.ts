// @vitest-environment jsdom
// The catalog's localisation guard.
//
// Every catalog string the UI asks for is looked up with a `defaultValue`
// fallback — `EffectPicker` for the label, description and group heading,
// `EffectsSection` for the card title, `EffectParamField` for each param label —
// so a key missing from zh-CN degrades SILENTLY at runtime: an English word in a
// Chinese panel, or the raw param key as a label. There is no linter here, so
// this file is the only thing that turns a half-localised entry red.
//
// Keys are derived from the descriptors rather than listed, so a new catalog
// entry is covered the moment it lands.
import { describe, expect, it } from "vitest";
import en from "../../i18n/locales/en-US";
import zh from "../../i18n/locales/zh-CN";
import { listEffects, type EffectDescriptor } from "./effectRegistry";

const LOCALES = { "en-US": en, "zh-CN": zh };

/// Dotted lookup into a locale module, the way `t()` resolves a nested key.
/// Reading the modules the app reads — rather than re-parsing them as text —
/// is what makes a key that exists but holds an empty string a failure too.
const at = (loc: unknown, dotted: string): unknown =>
  dotted.split(".").reduce<any>((acc, k) => acc?.[k], loc);

/// Every key the UI asks for on behalf of one catalog entry.
function catalogKeys(d: EffectDescriptor): string[] {
  return [
    `effects.${d.kind}.name`,
    `effects.${d.kind}.desc`,
    `effects.category.${d.category}`,
    ...Object.keys(d.params).map((p) => `effects.${d.kind}.params.${p}`),
  ];
}

/// The predicate under test. Empty / whitespace-only counts as missing — it
/// renders as a blank label, which is worse than the English fallback.
function missingKeys(loc: unknown, keys: readonly string[]): string[] {
  return keys.filter((k) => {
    const v = at(loc, k);
    return typeof v !== "string" || v.trim() === "";
  });
}

describe("effect catalog localisation", () => {
  const CATALOG = listEffects();

  // A green run over an empty catalog would prove nothing.
  it("has entries to check", () => {
    expect(CATALOG.length).toBeGreaterThan(0);
  });

  it("resolves every entry's name, description, category and param labels in both locales", () => {
    for (const [locale, loc] of Object.entries(LOCALES)) {
      for (const d of CATALOG) {
        expect(missingKeys(loc, catalogKeys(d)), `${locale} / ${d.kind}`).toEqual([]);
      }
    }
  });

  // `EffectPicker` labels from `nameI18nKey` while `EffectsSection` titles the
  // card from the kind, so a descriptor that points `nameI18nKey` elsewhere
  // makes the picker and the card name the same effect two different things —
  // and puts a key outside this guard's reach.
  it("derives every entry's nameI18nKey from its kind", () => {
    for (const d of CATALOG) expect(d.nameI18nKey, d.kind).toBe(`effects.${d.kind}.name`);
  });

  // The red direction. Asserted against holed copies of the real locales,
  // because the green case above runs against locales that are already
  // complete — on its own it would still pass if `missingKeys` never reported
  // anything. Each case narrows `missingKeys` to the one key it holes, so an
  // unrelated real hole cannot make these misreport (that is the case above's
  // job) and each asserts the key resolves before the hole is made.
  describe("catches a hole in either locale", () => {
    const entry = CATALOG[0]!;
    const param = Object.keys(entry.params)[0]!;
    const holed = (loc: unknown): any => structuredClone(loc);
    const bothWays = (loc: unknown, key: string, hole: (h: any) => void) => {
      expect(missingKeys(loc, [key]), `${key} resolves today`).toEqual([]);
      const h = holed(loc);
      hole(h);
      expect(missingKeys(h, [key])).toEqual([key]);
    };

    for (const [locale, loc] of Object.entries(LOCALES)) {
      it(`a deleted param label in ${locale}`, () => {
        bothWays(loc, `effects.${entry.kind}.params.${param}`,
          (h) => { delete h.effects[entry.kind].params[param]; });
      });
      it(`a blanked description in ${locale}`, () => {
        bothWays(loc, `effects.${entry.kind}.desc`,
          (h) => { h.effects[entry.kind].desc = "   "; });
      });
      it(`a deleted name in ${locale}`, () => {
        bothWays(loc, `effects.${entry.kind}.name`,
          (h) => { delete h.effects[entry.kind].name; });
      });
    }
  });
});
