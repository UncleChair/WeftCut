import { describe, expect, it } from "vitest";
import { keyAt, prevKeyAt, nextKeyAt } from "./nav";
import { resolveNavLayer } from "./nav";
import type { AnimTrack } from "../ipc";
import type { LayerSummary, TrackSummary } from "../ipc";

const track3: AnimTrack<number> = {
  mode: "Keyframed",
  value: [
    { id: "a", t_us: 0, value: 0, interp: { kind: "Linear" } },
    { id: "b", t_us: 1_000_000, value: 1, interp: { kind: "Linear" } },
    { id: "c", t_us: 2_000_000, value: 0, interp: { kind: "Linear" } },
  ],
};
const staticTrack: AnimTrack<number> = { mode: "Static", value: 0.5 };

describe("keyAt", () => {
  it("returns the key at an exact t_us", () => expect(keyAt(track3, 1_000_000)?.id).toBe("b"));
  it("returns null off a key", () => expect(keyAt(track3, 1_500_000)).toBeNull());
  it("returns null for a Static track", () => expect(keyAt(staticTrack, 0)).toBeNull());
});

describe("prevKeyAt", () => {
  it("finds the latest key strictly before", () => expect(prevKeyAt(track3, 1_500_000)?.id).toBe("b"));
  it("steps off a key sitting exactly on it", () => expect(prevKeyAt(track3, 1_000_000)?.id).toBe("a"));
  it("returns null before the first key", () => expect(prevKeyAt(track3, 0)).toBeNull());
  it("returns null for a Static track", () => expect(prevKeyAt(staticTrack, 0)).toBeNull());
});

describe("nextKeyAt", () => {
  it("finds the earliest key strictly after", () => expect(nextKeyAt(track3, 500_000)?.id).toBe("b"));
  it("steps off a key sitting exactly on it", () => expect(nextKeyAt(track3, 1_000_000)?.id).toBe("c"));
  it("returns null after the last key", () => expect(nextKeyAt(track3, 2_000_000)).toBeNull());
  it("returns the first key from before the first", () => expect(nextKeyAt(track3, -1_000_000)?.id).toBe("a"));
  it("returns null for a Static track", () => expect(nextKeyAt(staticTrack, 0)).toBeNull());
});

const layer = (id: string, opacityMode: "Static" | "Keyframed"): LayerSummary =>
  ({
    id,
    params: {
      opacity:
        opacityMode === "Keyframed"
          ? { mode: "Keyframed", value: [{ id: `${id}k`, t_us: 0, value: 1, interp: { kind: "Linear" } }] }
          : { mode: "Static", value: 1 },
    },
  }) as unknown as LayerSummary;

const trackOf = (...layers: LayerSummary[]): TrackSummary =>
  ({ layers }) as unknown as TrackSummary;

describe("resolveNavLayer", () => {
  it("returns the sole keyframed clip when only one has the param", () => {
    const tr = trackOf(layer("L1", "Keyframed"), layer("L2", "Static"));
    expect(resolveNavLayer(tr, "opacity", null)?.id).toBe("L1");
  });
  it("returns the focused clip when several are keyframed", () => {
    const tr = trackOf(layer("L1", "Keyframed"), layer("L2", "Keyframed"));
    expect(resolveNavLayer(tr, "opacity", "L2")?.id).toBe("L2");
  });
  it("returns null when several are keyframed and none is focused", () => {
    const tr = trackOf(layer("L1", "Keyframed"), layer("L2", "Keyframed"));
    expect(resolveNavLayer(tr, "opacity", null)).toBeNull();
  });
  it("ignores a focused id outside the candidate set", () => {
    const tr = trackOf(layer("L1", "Keyframed"));
    expect(resolveNavLayer(tr, "opacity", "OTHER")?.id).toBe("L1");
  });
  it("returns null when no clip has the param keyframed", () => {
    const tr = trackOf(layer("L1", "Static"));
    expect(resolveNavLayer(tr, "opacity", "L1")).toBeNull();
  });
  it("a LINKED layer is never a scale_y candidate (its twin belongs to the composite lane)", () => {
    const kf = { mode: "Keyframed", value: [{ id: "k", t_us: 0, value: 1, interp: { kind: "Linear" } }] };
    const linked = { id: "LK", params: { scale_linked: true, scale_y: kf } } as unknown as LayerSummary;
    const unlinked = { id: "UN", params: { scale_linked: false, scale_y: kf } } as unknown as LayerSummary;
    // Sole-candidate resolution skips the linked layer entirely…
    expect(resolveNavLayer(trackOf(linked), "scale_y", null)).toBeNull();
    // …so an unlinked neighbour resolves as the SOLE candidate despite the twin.
    expect(resolveNavLayer(trackOf(linked, unlinked), "scale_y", null)?.id).toBe("UN");
    // scale_x stays navigable on the linked layer (it's the composite's read side).
    const linkedX = { id: "LK", params: { scale_linked: true, scale_x: kf } } as unknown as LayerSummary;
    expect(resolveNavLayer(trackOf(linkedX), "scale_x", null)?.id).toBe("LK");
  });
});
