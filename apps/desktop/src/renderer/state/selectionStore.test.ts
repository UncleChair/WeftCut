import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLayerSelection,
  clearTransitionSelection,
  extendLayerSelection,
  retainLayerSelection,
  retainTransitionSelection,
  setLayerSelection,
  setTransitionSelection,
  useSelectionStore,
} from "./selectionStore";

beforeEach(clearLayerSelection);

describe("selectionStore", () => {
  it("treats a single-select write as a complete replacement", () => {
    setLayerSelection("layer-1", ["layer-1", "layer-2"]);
    setLayerSelection("layer-3", ["layer-3"]);

    expect(useSelectionStore.getState().primaryLayerId).toBe("layer-3");
    expect(Array.from(useSelectionStore.getState().selectedLayerIds)).toEqual(["layer-3"]);
    clearLayerSelection();
    expect(useSelectionStore.getState().primaryLayerId).toBeNull();
    expect(useSelectionStore.getState().selectedLayerIds.size).toBe(0);
  });

  it("sets a complete range and its primary atomically", () => {
    const observed: Array<[string | null, string[]]> = [];
    const unsub = useSelectionStore.subscribe((state) => {
      observed.push([state.primaryLayerId, Array.from(state.selectedLayerIds)]);
    });

    setLayerSelection("layer-2", ["layer-1", "layer-2", "layer-3"]);

    expect(observed).toEqual([
      ["layer-2", ["layer-1", "layer-2", "layer-3"]],
    ]);
    unsub();
  });

  it("extends the set while making the additive target primary", () => {
    setLayerSelection("layer-1", ["layer-1"]);
    extendLayerSelection("layer-3", ["layer-2", "layer-3"]);

    expect(useSelectionStore.getState().primaryLayerId).toBe("layer-3");
    expect(Array.from(useSelectionStore.getState().selectedLayerIds)).toEqual([
      "layer-1",
      "layer-2",
      "layer-3",
    ]);
  });

  it("normalizes every write to the primary/set invariants", () => {
    setLayerSelection("primary", ["sibling"]);
    expect(useSelectionStore.getState().selectedLayerIds.has("primary")).toBe(true);

    setLayerSelection(null, ["survivor"]);
    expect(useSelectionStore.getState().primaryLayerId).toBe("survivor");
    expect(useSelectionStore.getState().selectedLayerIds.has("survivor")).toBe(true);

    clearLayerSelection();
    expect(useSelectionStore.getState().primaryLayerId).toBeNull();
    expect(useSelectionStore.getState().selectedLayerIds.size).toBe(0);
  });

  it("does not notify subscribers when primary and set membership are unchanged", () => {
    setLayerSelection("layer-1", ["layer-1", "layer-2"]);
    const spy = vi.fn();
    const unsub = useSelectionStore.subscribe(spy);

    setLayerSelection("layer-1", ["layer-2", "layer-1", "layer-2"]);

    expect(spy).not.toHaveBeenCalled();
    unsub();
  });

  it("retains valid Layers and promotes a survivor when the primary disappears", () => {
    setLayerSelection("layer-1", ["layer-1", "layer-2", "layer-3"]);
    retainLayerSelection(["layer-2", "layer-3"]);

    expect(useSelectionStore.getState().primaryLayerId).toBe("layer-2");
    expect(Array.from(useSelectionStore.getState().selectedLayerIds)).toEqual(["layer-2", "layer-3"]);

    retainLayerSelection([]);
    expect(useSelectionStore.getState().primaryLayerId).toBeNull();
    expect(useSelectionStore.getState().selectedLayerIds.size).toBe(0);
  });
});

describe("transition selection (mutually exclusive with layer selection)", () => {
  it("selecting a transition deselects all layers", () => {
    setLayerSelection("layer-1", ["layer-1", "layer-2"]);
    setTransitionSelection("tr-1");

    expect(useSelectionStore.getState().selectedTransitionId).toBe("tr-1");
    expect(useSelectionStore.getState().primaryLayerId).toBeNull();
    expect(useSelectionStore.getState().selectedLayerIds.size).toBe(0);
  });

  it("selecting layers deselects the transition", () => {
    setTransitionSelection("tr-1");
    setLayerSelection("layer-1", ["layer-1"]);

    expect(useSelectionStore.getState().selectedTransitionId).toBeNull();
    expect(useSelectionStore.getState().primaryLayerId).toBe("layer-1");
  });

  it("extendLayerSelection also evicts the transition", () => {
    setTransitionSelection("tr-1");
    extendLayerSelection("layer-1", ["layer-1"]);
    expect(useSelectionStore.getState().selectedTransitionId).toBeNull();
  });

  it("clearLayerSelection clears the transition too (background-click semantics)", () => {
    setTransitionSelection("tr-1");
    clearLayerSelection();
    expect(useSelectionStore.getState().selectedTransitionId).toBeNull();
  });

  it("clearTransitionSelection clears only the transition", () => {
    setTransitionSelection("tr-1");
    clearTransitionSelection();
    expect(useSelectionStore.getState().selectedTransitionId).toBeNull();
  });

  it("retainTransitionSelection drops a vanished id and keeps a surviving one", () => {
    setTransitionSelection("tr-1");
    retainTransitionSelection(["tr-1", "tr-2"]);
    expect(useSelectionStore.getState().selectedTransitionId).toBe("tr-1");

    retainTransitionSelection(["tr-2"]);
    expect(useSelectionStore.getState().selectedTransitionId).toBeNull();
  });

  it("retainLayerSelection preserves a selected transition (layers were empty by invariant)", () => {
    setTransitionSelection("tr-1");
    retainLayerSelection(["layer-1", "layer-2"]);
    expect(useSelectionStore.getState().selectedTransitionId).toBe("tr-1");
  });

  it("does not notify subscribers when the transition selection is unchanged", () => {
    setTransitionSelection("tr-1");
    const spy = vi.fn();
    const unsub = useSelectionStore.subscribe(spy);

    setTransitionSelection("tr-1");

    expect(spy).not.toHaveBeenCalled();
    unsub();
  });
});
