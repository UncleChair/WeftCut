import { describe, expect, it } from "vitest";
import { createInstance } from "i18next";
import { trackDisplayName } from "./trackName";
import en from "../i18n/locales/en-US";
import zh from "../i18n/locales/zh-CN";
import type { TrackRole, TrackSummary } from "../ipc";

function track(partial: Partial<TrackSummary>): TrackSummary {
  return {
    id: "T",
    kind: "Video",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers: [],
    ...partial,
  };
}

/// A five-line i18next: dotted lookup + `{{name}}` substitution, run against the
/// real locale bundles. Asserting the shipped strings is the point — "reads
/// correctly in zh-CN" is not provable against a stub that echoes its key.
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

describe("trackDisplayName", () => {
  it("prefers the user's own label over every derived rung", () => {
    const t0 = track({ id: "t0", label: "Interview", role: "a-roll" });
    const t1 = track({ id: "t1", label: "Broll cuts" });
    const tracks = [t0, t1];
    expect(trackDisplayName(t0, tracks, tEn)).toBe("Interview");
    expect(trackDisplayName(t1, tracks, tEn)).toBe("Broll cuts");
    // A stored label is user content: it reads the same in every locale.
    expect(trackDisplayName(t0, tracks, tZh)).toBe("Interview");
  });

  // Clearing the rename field writes a blank, and a blank must not leave a
  // nameless row — the same rule `layerDisplayName` already follows.
  it("treats a blank label as absent", () => {
    for (const blank of ["", "   ", "\t\n"]) {
      const roleLess = track({ id: "x", label: blank });
      expect(trackDisplayName(roleLess, [roleLess], tEn)).toBe("Track 1");
      const reserved = track({ id: "y", label: blank, role: "b-roll" });
      expect(trackDisplayName(reserved, [reserved], tEn)).toBe("B roll");
    }
  });

  // The role stamp exists so the reserved skeleton is nameable in the user's
  // language; a literal in the project file could never be.
  it("derives every role in both locales", () => {
    const expected: Record<TrackRole, [string, string]> = {
      "a-roll": ["A roll", "A 轨"],
      "b-roll": ["B roll", "B 轨"],
      "audio-a": ["A roll audio", "A 轨音频"],
      "audio-b": ["B roll audio", "B 轨音频"],
      caption: ["Captions", "字幕"],
    };
    for (const [role, [english, chinese]] of Object.entries(expected)) {
      const t0 = track({ role: role as TrackRole });
      expect(trackDisplayName(t0, [t0], tEn), role).toBe(english);
      expect(trackDisplayName(t0, [t0], tZh), role).toBe(chinese);
    }
  });

  it("numbers a role-less track by its 1-based slot from the bottom", () => {
    const tracks = [
      track({ id: "bottom" }),
      track({ id: "middle" }),
      track({ id: "top" }),
    ];
    expect(tracks.map((x) => trackDisplayName(x, tracks, tEn))).toEqual([
      "Track 1",
      "Track 2",
      "Track 3",
    ]);
    expect(trackDisplayName(tracks[2]!, tracks, tZh)).toBe("轨道 3");
  });

  // Renumbering is the accepted consequence of a positional name (ADR 0042);
  // Premiere and Resolve renumber too.
  it("renumbers when a lane below is pruned", () => {
    const kept = track({ id: "kept" });
    const before = [track({ id: "gone" }), kept];
    expect(trackDisplayName(kept, before, tEn)).toBe("Track 2");
    expect(trackDisplayName(kept, [kept], tEn)).toBe("Track 1");
  });

  // A spawned lane appends at the tail, so a caller whose snapshot predates it
  // still shows the number the lane is about to be given — never "Track 0".
  it("gives a track the list does not hold the tail slot", () => {
    const fresh = track({ id: "fresh" });
    expect(trackDisplayName(fresh, [track({ id: "a" }), track({ id: "b" })], tEn))
      .toBe("Track 3");
    expect(trackDisplayName(fresh, [], tEn)).toBe("Track 1");
  });
});

// The role keys have a second reader: copy that has to NAME a lane reaches them
// through i18next's `$t(…)` nesting rather than through a call-site argument.
// A renamed key would leave the raw `$t(tracks.roles.a-roll)` on screen.
describe("locale strings that name a lane", () => {
  const LOCALES = { "en-US": en, "zh-CN": zh };
  const at = (locale: unknown, dotted: string): unknown =>
    dotted
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        locale,
      );
  const strings = (node: unknown): string[] =>
    typeof node === "string"
      ? [node]
      : Object.values(node as Record<string, unknown>).flatMap(strings);

  it("resolves every nested key reference", () => {
    for (const [name, locale] of Object.entries(LOCALES)) {
      for (const value of strings(locale)) {
        for (const [, key] of value.matchAll(/\$t\(([^)]+)\)/g)) {
          expect(typeof at(locale, key!), `${name} → ${key}`).toBe("string");
        }
      }
    }
  });

  it("gives the A/B empty-state hint the localized role names", async () => {
    for (const [lng, locale] of Object.entries(LOCALES)) {
      const i18n = createInstance();
      await i18n.init({
        lng,
        resources: { [lng]: { translation: locale } },
        interpolation: { escapeValue: false },
      });
      const hint = i18n.t("timeline.empty_ab_mode", { key: "Shift+A" });
      expect(hint, lng).toContain(at(locale, "tracks.roles.a-roll"));
      expect(hint, lng).toContain(at(locale, "tracks.roles.b-roll"));
      expect(hint, lng).not.toContain("$t(");
    }
  });
});
