import { describe, expect, it } from "vitest";
import { keyAt, prevKeyAt, nextKeyAt } from "./nav";
import type { AnimTrack } from "../ipc";

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
});

describe("nextKeyAt", () => {
  it("finds the earliest key strictly after", () => expect(nextKeyAt(track3, 500_000)?.id).toBe("b"));
  it("steps off a key sitting exactly on it", () => expect(nextKeyAt(track3, 1_000_000)?.id).toBe("c"));
  it("returns null after the last key", () => expect(nextKeyAt(track3, 2_000_000)).toBeNull());
});
