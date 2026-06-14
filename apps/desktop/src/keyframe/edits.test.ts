import { describe, expect, it } from "vitest";
import {
  liftToKeyframed, collapseToStatic, upsertKeyframe, removeKeyframe,
  retimeKeyframe, setKeyframeInterp,
} from "./edits";
import type { AnimTrack } from "../ipc";

const kf = (id: string, t: number, value: number): AnimTrack<number> =>
  ({ mode: "Keyframed", value: [{ id, t_us: t, value, interp: { kind: "Linear" } }] });

describe("liftToKeyframed", () => {
  it("makes a single-key track at tUs", () => {
    const tr = liftToKeyframed(0.5, 1_000_000);
    expect(tr.mode).toBe("Keyframed");
    if (tr.mode !== "Keyframed") throw new Error();
    expect(tr.value).toHaveLength(1);
    expect(tr.value[0]!.t_us).toBe(1_000_000);
    expect(tr.value[0]!.value).toBe(0.5);
  });
});

describe("collapseToStatic", () => {
  it("evaluates the track at tUs and returns Static", () => {
    const tr: AnimTrack<number> = { mode: "Keyframed", value: [
      { id: "a", t_us: 0, value: 0, interp: { kind: "Linear" } },
      { id: "b", t_us: 10_000_000, value: 10, interp: { kind: "Linear" } },
    ]};
    expect(collapseToStatic(tr, 5_000_000, 1)).toEqual({ mode: "Static", value: 5 });
  });
});

describe("upsertKeyframe", () => {
  it("lifts a Static track, keying current value at other times too", () => {
    const tr = upsertKeyframe({ mode: "Static", value: 0.2 }, 2_000_000, 0.9);
    if (tr.mode !== "Keyframed") throw new Error();
    expect(tr.value.map((k) => [k.t_us, k.value])).toEqual([[2_000_000, 0.9]]);
  });
  it("updates the key when one already sits at tUs", () => {
    const tr = upsertKeyframe(kf("a", 1_000_000, 0.1), 1_000_000, 0.7);
    if (tr.mode !== "Keyframed") throw new Error();
    expect(tr.value).toHaveLength(1);
    expect(tr.value[0]!.value).toBe(0.7);
  });
  it("inserts a new key sorted by t_us", () => {
    const tr = upsertKeyframe(kf("a", 2_000_000, 0.1), 1_000_000, 0.9);
    if (tr.mode !== "Keyframed") throw new Error();
    expect(tr.value.map((k) => k.t_us)).toEqual([1_000_000, 2_000_000]);
  });
});

describe("removeKeyframe", () => {
  it("removes by id, staying Keyframed when keys remain", () => {
    const tr: AnimTrack<number> = { mode: "Keyframed", value: [
      { id: "a", t_us: 0, value: 0, interp: { kind: "Linear" } },
      { id: "b", t_us: 1_000_000, value: 1, interp: { kind: "Linear" } },
    ]};
    const out = removeKeyframe(tr, "a", 1);
    if (out.mode !== "Keyframed") throw new Error();
    expect(out.value.map((k) => k.id)).toEqual(["b"]);
  });
  it("collapses to Static at the removed key's value when it was the last", () => {
    expect(removeKeyframe(kf("a", 0, 0.33), "a", 1)).toEqual({ mode: "Static", value: 0.33 });
  });
});

describe("retimeKeyframe", () => {
  it("moves a key and re-sorts", () => {
    const tr: AnimTrack<number> = { mode: "Keyframed", value: [
      { id: "a", t_us: 0, value: 0, interp: { kind: "Linear" } },
      { id: "b", t_us: 1_000_000, value: 1, interp: { kind: "Linear" } },
    ]};
    const out = retimeKeyframe(tr, "a", 2_000_000);
    if (out.mode !== "Keyframed") throw new Error();
    expect(out.value.map((k) => k.id)).toEqual(["b", "a"]);
  });
});

describe("setKeyframeInterp", () => {
  it("changes a key's interpolation", () => {
    const out = setKeyframeInterp(kf("a", 0, 0), "a", { kind: "Hold" });
    if (out.mode !== "Keyframed") throw new Error();
    expect(out.value[0]!.interp).toEqual({ kind: "Hold" });
  });
});
