// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
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

describe("useCommandProvider", () => {
  it("registers on mount, re-reads a churned getDefs lazily without re-registering, and unregisters on unmount", () => {
    const spy = vi.fn();
    const unsub = subscribeCommandRegistry(spy);

    let defs = [def("play")];
    const { rerender, unmount } = renderHook(
      ({ getDefs }: { getDefs: () => CommandDef[] }) => useCommandProvider(getDefs),
      { initialProps: { getDefs: () => defs } },
    );

    // Mount registers exactly once.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(listCommands().map((c) => c.id)).toEqual(["play"]);

    // A fresh getDefs identity on rerender is read through the ref — the
    // provider itself never re-registers, so the listener count stays put.
    defs = [def("pause")];
    rerender({ getDefs: () => defs });
    expect(listCommands().map((c) => c.id)).toEqual(["pause"]);
    expect(spy).toHaveBeenCalledTimes(1);

    unmount();
    expect(listCommands()).toHaveLength(0);
    expect(spy).toHaveBeenCalledTimes(2);

    unsub();
  });
});
