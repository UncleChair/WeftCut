import { describe, expect, it } from "vitest";

import en from "../i18n/locales/en-US";
import { MENU_SPEC } from "./menuSpec";

// Item ids are already locked by the type system (`MenuCommandId`); what the
// compiler can't see is the i18n side — a section title or object-form
// hintKey that resolves to nothing renders a raw key in the menu bar.
function resolveKey(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<any>((acc, k) => acc?.[k], obj);
}

describe("MENU_SPEC", () => {
  it("every section title and hintKey resolves in the en-US locale", () => {
    for (const section of MENU_SPEC) {
      expect(typeof resolveKey(en, section.titleKey), section.titleKey).toBe(
        "string",
      );
      for (const entry of section.entries) {
        if (typeof entry === "object") {
          expect(typeof resolveKey(en, entry.hintKey), entry.hintKey).toBe(
            "string",
          );
        }
      }
    }
  });

  it("no command id appears twice within a section", () => {
    for (const section of MENU_SPEC) {
      const ids = section.entries
        .filter((e) => e !== "---")
        .map((e) => (typeof e === "string" ? e : e.id));
      expect(new Set(ids).size, section.titleKey).toBe(ids.length);
    }
  });
});
