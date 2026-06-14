import { describe, expect, it, beforeEach } from "vitest";
import {
  selectKeyframe, clearKeyframeSelection, getSelectedKeyframe,
  useKeyframeSelectionStore,
} from "./selectionStore";

beforeEach(() => clearKeyframeSelection());

describe("keyframeSelectionStore", () => {
  it("selects and reads back a key", () => {
    selectKeyframe({ layerId: "L", paramKey: "opacity", kfId: "k1" });
    expect(getSelectedKeyframe()).toEqual({ layerId: "L", paramKey: "opacity", kfId: "k1" });
  });
  it("clear() empties the selection", () => {
    selectKeyframe({ layerId: "L", paramKey: "x", kfId: "k1" });
    clearKeyframeSelection();
    expect(getSelectedKeyframe()).toBeNull();
  });
  it("isSelected matches only the exact (layer,param,kf) triple", () => {
    selectKeyframe({ layerId: "L", paramKey: "x", kfId: "k1" });
    const sel = useKeyframeSelectionStore.getState().selected;
    const eq = (a: typeof sel, layerId: string, paramKey: string, kfId: string) =>
      !!a && a.layerId === layerId && a.paramKey === paramKey && a.kfId === kfId;
    expect(eq(sel, "L", "x", "k1")).toBe(true);
    expect(eq(sel, "L", "x", "k2")).toBe(false);
    expect(eq(sel, "L", "y", "k1")).toBe(false);
  });
});
