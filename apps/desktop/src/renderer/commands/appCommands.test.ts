import { afterEach, describe, expect, it } from "vitest";
import { buildAppCommands } from "./appCommands";
import { ACTION_DEFS } from "../shortcuts/defs";
import type { HandlerMap } from "../shortcuts";
import { setTool } from "../state/toolStore";
import en from "../i18n/locales/en-US";

const noop = () => {};

// App's real HandlerMap keys (everything except the Timeline-local group
// ops), including the palette action itself.
const handlers: HandlerMap = {
  save: noop, saveAs: noop, closeProject: noop, undo: noop, redo: noop,
  togglePlay: noop, deleteSelected: noop, copySelected: noop, pasteAtPlayhead: noop,
  importMedia: noop, export: noop,
  selectTool: noop, toggleBladeMode: noop, toggleLog: noop, focusLogSearch: noop,
  toggleDisplayMode: noop,
  seekFrameBack: noop, seekFrameForward: noop, seekSecondBack: noop,
  seekSecondForward: noop, seekPrevEdit: noop, seekNextEdit: noop,
  seekStart: noop, seekEnd: noop,
  openSearchPalette: noop, openSettings: noop,
};

const menu = {
  addColorLayer: noop, addTextLayer: noop,
  openMotifPicker: noop,
  openAgentPanel: noop, enterAgentMode: noop,
};

const flags = { busy: false, canUndo: true, canRedo: false, canBlade: true, exportLocked: true };

function resolveKey(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<any>((acc, k) => acc?.[k], obj);
}

describe("buildAppCommands", () => {
  it("derives one command per handled ActionId, excluding openSearchPalette", () => {
    const defs = buildAppCommands(handlers, menu, flags);
    const ids = defs.map((d) => d.id);
    expect(ids).toContain("save");
    expect(ids).toContain("seekStart");
    expect(ids).not.toContain("openSearchPalette");
    expect(ids).not.toContain("groupSelected"); // Timeline registers those
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("appends the menu-only commands", () => {
    const ids = buildAppCommands(handlers, menu, flags).map((d) => d.id);
    for (const id of [
      "addColorLayer",
      "addTextLayer",
      "openMotifPicker",
      "openAgentPanel",
      "enterAgentMode",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("lists Settings once, from the catalogue rather than as a menu-only entry", () => {
    // It carries a binding now (Cmd+, — the macOS App menu's Settings slot), so
    // it arrives through the HandlerMap; appending it again would double it.
    const defs = buildAppCommands(handlers, menu, flags);
    expect(defs.filter((d) => d.id === "openSettings")).toHaveLength(1);
    expect(defs.find((d) => d.id === "openSettings")?.actionId).toBe("openSettings");
  });

  it("every labelKey resolves in the en-US locale", () => {
    for (const d of buildAppCommands(handlers, menu, flags)) {
      expect(typeof resolveKey(en, d.labelKey), d.labelKey).toBe("string");
    }
  });

  it("wires enabled gates to the flags", () => {
    const defs = buildAppCommands(handlers, menu, flags);
    const by = (id: string) => defs.find((d) => d.id === id)!;
    expect(by("undo").enabled!()).toBe(true);
    expect(by("redo").enabled!()).toBe(false);
    expect(by("export").enabled!()).toBe(false);
    expect(by("togglePlay").enabled).toBeUndefined();
  });

  describe("tool checkmarks", () => {
    afterEach(() => setTool("select"));

    it("read toolStore live, not a build-time snapshot", () => {
      // Built BEFORE the tool switch: a snapshot would freeze on "select".
      const defs = buildAppCommands(handlers, menu, flags);
      const by = (id: string) => defs.find((d) => d.id === id)!;
      expect(by("selectTool").checked!()).toBe(true);
      expect(by("toggleBladeMode").checked!()).toBe(false);
      setTool("blade");
      expect(by("selectTool").checked!()).toBe(false);
      expect(by("toggleBladeMode").checked!()).toBe(true);
      // Non-modal commands are not checkable at all.
      expect(by("save").checked).toBeUndefined();
    });
  });

  it("shortcut-backed commands reuse ACTION_DEFS labelKeys", () => {
    const save = buildAppCommands(handlers, menu, flags).find((d) => d.id === "save")!;
    expect(save.labelKey).toBe(ACTION_DEFS.save.labelKey);
    expect(save.actionId).toBe("save");
  });
});
