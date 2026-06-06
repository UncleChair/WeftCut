import { describe, expect, it, beforeEach } from "vitest";
import {
  selectLayerBakePhase,
  selectLayerBakeStatus,
  setLayerBakeStatuses,
  useTemplateBakeStatusStore,
  type LayerBakeStatus,
} from "./templateBakeStatusStore";

const baking: LayerBakeStatus = { phase: "baking", done: 1, total: 3 };

describe("templateBakeStatusStore", () => {
  beforeEach(() => setLayerBakeStatuses({}));

  it("pure phase selector: present → phase, absent → null", () => {
    const byLayer = { a: baking };
    expect(selectLayerBakePhase(byLayer, "a")).toBe("baking");
    expect(selectLayerBakePhase(byLayer, "missing")).toBe(null);
  });

  it("pure status selector: present → object, absent → null", () => {
    const byLayer = { a: baking };
    expect(selectLayerBakeStatus(byLayer, "a")).toEqual(baking);
    expect(selectLayerBakeStatus(byLayer, "missing")).toBe(null);
  });

  it("setLayerBakeStatuses replaces the whole map", () => {
    setLayerBakeStatuses({ a: baking });
    expect(useTemplateBakeStatusStore.getState().byLayer.a).toEqual(baking);
    setLayerBakeStatuses({ b: { phase: "ready", done: 3, total: 3 } });
    expect(useTemplateBakeStatusStore.getState().byLayer.a).toBeUndefined();
    expect(useTemplateBakeStatusStore.getState().byLayer.b?.phase).toBe("ready");
  });
});
