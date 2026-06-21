import { describe, it, expect, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@/bridge/ipc", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@/bridge/events", () => ({ listen: vi.fn() }));

import { addEffect, updateEffect, moveEffect, removeEffect } from "./index";

describe("effect IPC wrappers", () => {
  it("addEffect sends camelCase layerId + kind and returns the id", async () => {
    invoke.mockResolvedValue("e1");
    const id = await addEffect("L1", "blur");
    expect(invoke).toHaveBeenCalledWith("add_effect", { layerId: "L1", kind: "blur" });
    expect(id).toBe("e1");
  });
  it("updateEffect sends layerId, effectId, patch", async () => {
    invoke.mockResolvedValue(undefined);
    await updateEffect("L1", "E1", { enabled: false });
    expect(invoke).toHaveBeenCalledWith("update_effect", {
      layerId: "L1",
      effectId: "E1",
      patch: { enabled: false },
    });
  });
  it("moveEffect sends a 0-based newIndex", async () => {
    invoke.mockResolvedValue(undefined);
    await moveEffect("L1", "E1", 0);
    expect(invoke).toHaveBeenCalledWith("move_effect", { layerId: "L1", effectId: "E1", newIndex: 0 });
  });
  it("removeEffect sends layerId + effectId", async () => {
    invoke.mockResolvedValue(undefined);
    await removeEffect("L1", "E1");
    expect(invoke).toHaveBeenCalledWith("remove_effect", { layerId: "L1", effectId: "E1" });
  });
});
