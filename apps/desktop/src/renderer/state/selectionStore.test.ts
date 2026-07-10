import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  selectedLayerId,
  setSelectedLayerId,
  useSelectionStore,
} from "./selectionStore";

beforeEach(() => setSelectedLayerId(null));

describe("selectionStore", () => {
  it("sets and reads the selected layer id", () => {
    setSelectedLayerId("layer-1");
    expect(selectedLayerId()).toBe("layer-1");
    setSelectedLayerId(null);
    expect(selectedLayerId()).toBeNull();
  });

  it("does not notify subscribers on a same-value write", () => {
    setSelectedLayerId("layer-1");
    const spy = vi.fn();
    const unsub = useSelectionStore.subscribe(spy);
    setSelectedLayerId("layer-1");
    expect(spy).not.toHaveBeenCalled();
    unsub();
  });
});
