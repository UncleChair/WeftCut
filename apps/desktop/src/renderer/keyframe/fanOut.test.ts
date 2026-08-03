import { describe, expect, it } from "vitest";
import type { AnimTrack } from "../ipc";
import { fanOutEntries, twinTrackCopy } from "./fanOut";

const kfTrack: AnimTrack<number> = {
  mode: "Keyframed",
  value: [
    { id: "a", t_us: 0, value: 1, interp: { kind: "Linear" } },
    { id: "b", t_us: 1_000_000, value: 2, interp: { kind: "Bezier", p1: [0.3, 0], p2: [0.7, 1] } },
  ],
};

describe("twinTrackCopy", () => {
  it("copies (t_us, value, interp) exactly but mints fresh ids", () => {
    const copy = twinTrackCopy(kfTrack);
    expect(copy.mode).toBe("Keyframed");
    const src = (kfTrack as Extract<AnimTrack<number>, { mode: "Keyframed" }>).value;
    const dst = (copy as Extract<AnimTrack<number>, { mode: "Keyframed" }>).value;
    expect(dst.map((k) => [k.t_us, k.value, k.interp])).toEqual(src.map((k) => [k.t_us, k.value, k.interp]));
    expect(dst.map((k) => k.id)).not.toContain("a");
    expect(dst.map((k) => k.id)).not.toContain("b");
  });
  it("shares no mutable state with the source (Bezier handles are re-created)", () => {
    const copy = twinTrackCopy(kfTrack) as Extract<AnimTrack<number>, { mode: "Keyframed" }>;
    const srcInterp = (kfTrack as Extract<AnimTrack<number>, { mode: "Keyframed" }>).value[1]!.interp;
    const dstInterp = copy.value[1]!;
    expect(dstInterp.interp).not.toBe(srcInterp);
    if (srcInterp.kind === "Bezier" && dstInterp.interp.kind === "Bezier") {
      expect(dstInterp.interp.p1).not.toBe(srcInterp.p1);
    }
  });
  it("Static passes through as a fresh Static", () => {
    const s: AnimTrack<number> = { mode: "Static", value: 2 };
    const copy = twinTrackCopy(s);
    expect(copy).toEqual(s);
    expect(copy).not.toBe(s);
  });
});

describe("fanOutEntries", () => {
  it("authored track under the first key, twins under the rest", () => {
    const entries = fanOutEntries(["scale_x", "scale_y"], kfTrack);
    expect(entries.map(([k]) => k)).toEqual(["scale_x", "scale_y"]);
    expect(entries[0]![1]).toBe(kfTrack); // authored ids preserved for the read side
    const twin = entries[1]![1] as Extract<AnimTrack<number>, { mode: "Keyframed" }>;
    expect(twin.value.map((k) => [k.t_us, k.value])).toEqual([[0, 1], [1_000_000, 2]]);
    expect(twin.value.map((k) => k.id)).not.toContain("a");
  });
});
