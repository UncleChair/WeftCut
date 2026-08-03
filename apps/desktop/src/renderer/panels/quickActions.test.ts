import { describe, expect, it } from "vitest";

import { buildAppCommands } from "../commands/appCommands";
import { ACTION_DEFS, type ActionId } from "../shortcuts/defs";
import type { HandlerMap } from "../shortcuts/useShortcuts";
import {
  QUICK_ACTION_IDS,
  QUICK_ACTION_SECTIONS,
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
    { addColorLayer: () => {}, addTextLayer: () => {}, openMotifPicker: () => {} },
    { busy: false, canUndo: false, canRedo: false, canBlade: false, exportLocked: false },
  );
  return new Set(defs.map((d) => d.id));
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

  it("gives every item an icon", () => {
    for (const section of QUICK_ACTION_SECTIONS) {
      for (const item of section.items) {
        expect(item.icon, `"${item.id}" has no icon`).toBeTruthy();
      }
    }
  });

  // A radio section models a modal choice, so exactly one member must read as
  // armed for any reachable state — otherwise the strip shows either no
  // current tool or two at once.
  it("radio sections arm exactly one item per state", () => {
    const states: QuickActionState[] = [
      { tool: "select", displayMode: "AbRoll" },
      { tool: "select", displayMode: "ShowAll" },
      { tool: "blade", displayMode: "AbRoll" },
      { tool: "blade", displayMode: "ShowAll" },
    ];
    for (const section of QUICK_ACTION_SECTIONS) {
      if (section.mode !== "radio") continue;
      for (const state of states) {
        const armed = section.items.filter((item) => item.active(state));
        expect(armed, `section "${section.id}" @ tool=${state.tool}`).toHaveLength(1);
      }
    }
  });

  it("tracks the display mode with the retired pill's own hint wording", () => {
    const item = QUICK_ACTION_SECTIONS.flatMap((s) => s.items).find(
      (i) => i.id === "toggleDisplayMode",
    );
    expect(item?.hint?.({ tool: "select", displayMode: "AbRoll" })).toBe(
      "timeline.mode_ab_hint",
    );
    expect(item?.hint?.({ tool: "select", displayMode: "ShowAll" })).toBe(
      "timeline.mode_all_hint",
    );
    expect(item?.active({ tool: "select", displayMode: "AbRoll" })).toBe(true);
    expect(item?.active({ tool: "select", displayMode: "ShowAll" })).toBe(false);
  });
});
