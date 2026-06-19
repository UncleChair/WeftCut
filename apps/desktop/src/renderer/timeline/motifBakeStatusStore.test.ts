import { describe, expect, it, beforeEach } from "vitest";
import {
  selectLayerBakePhase,
  selectLayerBakeStatus,
  setLayerBakeStatuses,
  useMotifBakeStatusStore,
  motifWarmPhase,
  type LayerBakeStatus,
} from "./motifBakeStatusStore";

const baking: LayerBakeStatus = { phase: "baking", done: 1, total: 3 };

describe("motifWarmPhase", () => {
  it("prefers a live bake status when present", () => {
    expect(motifWarmPhase({ phase: "baking", done: 1, total: 3 }, 3, 3)).toEqual({ phase: "baking", done: 1, total: 3 });
    expect(motifWarmPhase({ phase: "error", done: 0, total: 3 }, 2, 3)).toEqual({ phase: "error", done: 0, total: 3 });
  });
  it("falls back to L0 coverage when no bake status", () => {
    expect(motifWarmPhase(null, 0, 5)).toBe(null);
    expect(motifWarmPhase(null, 2, 5)).toEqual({ phase: "warming", done: 2, total: 5 });
    expect(motifWarmPhase(null, 5, 5)).toEqual({ phase: "ready", done: 5, total: 5 });
  });
  it("treats a baked-on-disk key as ready regardless of L0 coverage", () => {
    // Disk persistence is durable and read back without a re-capture, so a
    // pre-baked layer is "done" even when L0 holds none (cold reopen) or only
    // some (partial eviction) of its frames.
    expect(motifWarmPhase(null, 0, 5, true)).toEqual({ phase: "ready", done: 5, total: 5 });
    expect(motifWarmPhase(null, 2, 5, true)).toEqual({ phase: "ready", done: 5, total: 5 });
  });
});

describe("motifBakeStatusStore", () => {
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
    expect(useMotifBakeStatusStore.getState().byLayer.a).toEqual(baking);
    setLayerBakeStatuses({ b: { phase: "ready", done: 3, total: 3 } });
    expect(useMotifBakeStatusStore.getState().byLayer.a).toBeUndefined();
    expect(useMotifBakeStatusStore.getState().byLayer.b?.phase).toBe("ready");
  });
});
