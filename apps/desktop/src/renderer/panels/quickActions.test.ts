import { describe, expect, it } from "vitest";
import { FoldVertical, UnfoldVertical } from "lucide-react";

import { buildAppCommands } from "../commands/appCommands";
import { ACTION_DEFS, type ActionId } from "../shortcuts/defs";
import type { HandlerMap } from "../shortcuts/useShortcuts";
import {
  QUICK_ACTION_IDS,
  QUICK_ACTION_SECTIONS,
  resolveIcon,
  type QuickActionItem,
  type QuickActionState,
} from "./quickActions";

/// Every catalogued action wired, so the factory emits the full command set.
function allHandlers(): HandlerMap {
  const handlers: HandlerMap = {};
  for (const id of Object.keys(ACTION_DEFS) as ActionId[]) {
    handlers[id] = () => {};
  }
  return handlers;
}

function commandIds(): Set<string> {
  const defs = buildAppCommands(
    allHandlers(),
    {
      addColorLayer: () => {},
      addTextLayer: () => {},
      openMotifPicker: () => {},
      openAgentPanel: () => {},
      enterAgentMode: () => {},
    },
    { busy: false, canUndo: false, canRedo: false, canBlade: false, exportLocked: false },
  );
  return new Set(defs.map((d) => d.id));
}

/// Build a state, naming only the fields a case actually exercises — so adding
/// a field to `QuickActionState` doesn't rewrite every literal in this file.
function state(over: Partial<QuickActionState> = {}): QuickActionState {
  return { tool: "select", displayMode: "AbRoll", hasRange: false, ...over };
}

describe("quickActions catalogue", () => {
  // The strip resolves `run` / `enabled` / `labelKey` by id at render time, so
  // a typo or a renamed action would silently drop a button instead of failing
  // to compile. This is that gate.
  it("every strip id resolves to a real command", () => {
    const available = commandIds();
    for (const id of QUICK_ACTION_IDS) {
      expect(available, `no command registered for "${id}"`).toContain(id);
    }
  });

  it("has no duplicate ids across sections", () => {
    expect(new Set(QUICK_ACTION_IDS).size).toBe(QUICK_ACTION_IDS.length);
  });

  // Both halves matter: the static fallback, and what actually reaches the
  // button once a state-bearing `iconFor` has had its say.
  it("gives every item an icon in every state", () => {
    for (const section of QUICK_ACTION_SECTIONS) {
      for (const item of section.items) {
        expect(item.icon, `"${item.id}" has no icon`).toBeTruthy();
        for (const displayMode of ["AbRoll", "ShowAll"] as const) {
          expect(
            resolveIcon(item, state({ displayMode })),
            `"${item.id}" resolves no icon @ ${displayMode}`,
          ).toBeTruthy();
        }
      }
    }
  });

  // A radio section models a modal choice, so exactly one member must read as
  // armed for any reachable state — otherwise the strip shows either no
  // current tool or two at once.
  it("radio sections arm exactly one item per state", () => {
    const states: QuickActionState[] = [
      state({ tool: "select", displayMode: "AbRoll" }),
      state({ tool: "select", displayMode: "ShowAll" }),
      state({ tool: "blade", displayMode: "AbRoll" }),
      state({ tool: "blade", displayMode: "ShowAll" }),
    ];
    for (const section of QUICK_ACTION_SECTIONS) {
      if (section.mode !== "radio") continue;
      for (const s of states) {
        const armed = section.items.filter((item) => item.active?.(s) === true);
        expect(armed, `section "${section.id}" @ tool=${s.tool}`).toHaveLength(1);
      }
    }
  });

  // The mode is what the panel turns into `aria-checked` / `aria-pressed` /
  // nothing, so `active` has to be present exactly where a pressed state is
  // claimed. A stateful section missing it would render permanently unpressed;
  // a `command` item carrying it would announce a switch that doesn't exist.
  it("declares a pressed state on exactly the stateful sections", () => {
    for (const section of QUICK_ACTION_SECTIONS) {
      for (const item of section.items) {
        if (section.mode === "command") {
          expect(item.active, `"${item.id}" is momentary but declares active`)
            .toBeUndefined();
        } else {
          expect(item.active, `"${item.id}" declares no active`).toBeTypeOf(
            "function",
          );
        }
      }
    }
  });

  // The glyph is the at-a-glance read of the display mode; the pressed border
  // alone can't say WHICH way the rows are folded. It depicts the current
  // state (not the click's effect) so it agrees with `aria-pressed`.
  it("folds and unfolds the display-toggle glyph with the mode", () => {
    const item: QuickActionItem | undefined = QUICK_ACTION_SECTIONS.flatMap(
      (s) => s.items,
    ).find((i) => i.id === "toggleDisplayMode");
    if (!item) throw new Error("no strip item for toggleDisplayMode");
    expect(resolveIcon(item, state({ displayMode: "AbRoll" }))).toBe(FoldVertical);
    expect(resolveIcon(item, state({ displayMode: "ShowAll" }))).toBe(
      UnfoldVertical,
    );
  });

  it("tracks the display mode with the retired pill's own hint wording", () => {
    const item = QUICK_ACTION_SECTIONS.flatMap((s) => s.items).find(
      (i) => i.id === "toggleDisplayMode",
    );
    expect(item?.hint?.(state({ displayMode: "AbRoll" }))).toBe(
      "timeline.mode_ab_hint",
    );
    expect(item?.hint?.(state({ displayMode: "ShowAll" }))).toBe(
      "timeline.mode_all_hint",
    );
    expect(item?.active?.(state({ displayMode: "AbRoll" }))).toBe(true);
    expect(item?.active?.(state({ displayMode: "ShowAll" }))).toBe(false);
  });

  // The Clear button spends most of its life disabled; the hint is the only
  // thing that explains why, so it must actually change with the range.
  it("explains why Clear is unavailable when no range is marked", () => {
    const item = QUICK_ACTION_SECTIONS.flatMap((s) => s.items).find(
      (i) => i.id === "clearRange",
    );
    expect(item?.hint?.(state({ hasRange: false }))).toBe(
      "quick_actions.clear_range_empty",
    );
    expect(item?.hint?.(state({ hasRange: true }))).toBe("actions.clear_range");
  });
});
