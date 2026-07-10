import { describe, expect, it, vi } from "vitest";
import {
  getCommand,
  listCommands,
  registerCommandProvider,
  subscribeCommandRegistry,
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

  it("drops duplicate ids from later providers", () => {
    const un1 = registerCommandProvider(() => [def("save")]);
    const un2 = registerCommandProvider(() => [def("save"), def("redo")]);
    expect(listCommands().map((c) => c.id)).toEqual(["save", "redo"]);
    un1();
    un2();
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
