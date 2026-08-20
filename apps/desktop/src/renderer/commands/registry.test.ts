// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("../ipc", () => ({ logEmit: vi.fn(() => Promise.resolve()) }));

import { logEmit } from "../ipc";
import {
  getCommand,
  listCommands,
  registerCommandProvider,
  subscribeCommandRegistry,
  useCommandProvider,
  type CommandDef,
} from "./registry";

const def = (id: string): CommandDef => ({ id, labelKey: `actions.${id}`, run: () => {} });

describe("command registry", () => {
  it("lists commands from registered providers and unregisters cleanly", () => {
    const un = registerCommandProvider(() => [def("save"), def("undo")]);
    expect(listCommands().map((c) => c.id)).toEqual(["save", "undo"]);
    expect(getCommand("undo")?.labelKey).toBe("actions.undo");
    un();
    expect(listCommands()).toHaveLength(0);
  });

  it("drops duplicate ids from later providers and warns once", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const un1 = registerCommandProvider(() => [def("save")]);
    const un2 = registerCommandProvider(() => [def("save"), def("redo")]);
    expect(listCommands().map((c) => c.id)).toEqual(["save", "redo"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("save");
    un1();
    un2();
    warnSpy.mockRestore();
  });

  it("notifies subscribers on register and unregister", () => {
    const spy = vi.fn();
    const unsub = subscribeCommandRegistry(spy);
    const un = registerCommandProvider(() => []);
    expect(spy).toHaveBeenCalledTimes(1);
    un();
    expect(spy).toHaveBeenCalledTimes(2);
    unsub();
  });

  it("reads provider defs lazily (fresh flags each list call)", () => {
    let enabled = false;
    const un = registerCommandProvider(() => [
      { ...def("export"), enabled: () => enabled },
    ]);
    expect(listCommands()[0]!.enabled!()).toBe(false);
    enabled = true;
    expect(listCommands()[0]!.enabled!()).toBe(true);
    un();
  });
});

// The registry-level funnel: any surface that dispatches through
// listCommands/getCommand (palette, in-app menu bar, Quick Actions) logs the
// same `Shortcut` row the keyboard dispatcher emits — with nothing for the
// surface to remember. Guards the wrap in listCommands.
describe("registry dispatch logging", () => {
  beforeEach(() => {
    vi.mocked(logEmit).mockClear();
  });

  it("one dispatch → one Shortcut row keyed by the command id", () => {
    const run = vi.fn();
    const un = registerCommandProvider(() => [{ ...def("createCheckpoint"), run }]);
    getCommand("createCheckpoint")!.run();
    expect(run).toHaveBeenCalledTimes(1);
    expect(logEmit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logEmit).mock.calls[0]![0]).toMatchObject({
      level: "info",
      category: { kind: "Shortcut" },
      source: { kind: "User" },
      message: "Shortcut: createCheckpoint",
      i18n_args: { actionId: "createCheckpoint", label_key: "actions.createCheckpoint" },
    });
    un();
  });

  it("a throwing handler logs one error row instead of escaping", () => {
    const un = registerCommandProvider(() => [
      {
        ...def("save"),
        run: () => {
          throw new Error("disk full");
        },
      },
    ]);
    expect(() => getCommand("save")!.run()).not.toThrow();
    expect(logEmit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logEmit).mock.calls[0]![0]).toMatchObject({
      level: "error",
      category: { kind: "Shortcut" },
      message: "Shortcut save failed: Error: disk full",
    });
    un();
  });
});

describe("useCommandProvider", () => {
  it("registers on mount, re-reads a churned getDefs lazily without re-registering, and unregisters on unmount", () => {
    const spy = vi.fn();
    const unsub = subscribeCommandRegistry(spy);

    // The two getDefs closures share NO state: "pause" below is only
    // reachable if the hook reads the rerender-time closure through its ref —
    // a ref-less hook stuck on the mount-time closure would keep listing
    // "play" and fail here.
    const { rerender, unmount } = renderHook(
      ({ getDefs }: { getDefs: () => CommandDef[] }) => useCommandProvider(getDefs),
      { initialProps: { getDefs: () => [def("play")] } },
    );

    // Mount registers exactly once.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(listCommands().map((c) => c.id)).toEqual(["play"]);

    // A fresh getDefs identity on rerender is read through the ref — the
    // provider itself never re-registers, so the listener count stays put.
    rerender({ getDefs: () => [def("pause")] });
    expect(listCommands().map((c) => c.id)).toEqual(["pause"]);
    expect(spy).toHaveBeenCalledTimes(1);

    unmount();
    expect(listCommands()).toHaveLength(0);
    expect(spy).toHaveBeenCalledTimes(2);

    unsub();
  });
});
