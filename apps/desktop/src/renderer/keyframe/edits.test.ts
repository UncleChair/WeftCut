import { describe, expect, it } from "vitest";
import {
  liftToKeyframed, collapseToStatic, upsertKeyframe, removeKeyframe,
  retimeKeyframe, setKeyframeInterp, smoothKeyframe, smoothTrack,
} from "./edits";
import type { AnimTrack } from "../ipc";
import { resolveAnimated } from "../render/animated";

// resolveAnimated is wasm-backed now; the wasm is loaded by the global test
// setup (vitest.config.ts setupFiles).

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

function mkKf(id: string, t_us: number, value: number) {
  return { id, t_us, value, interp: { kind: "Linear" as const } };
}

describe("smoothKeyframe", () => {
  it("is a no-op on Static", () => {
    const s = { mode: "Static" as const, value: 3 };
    expect(smoothKeyframe(s, "x")).toBe(s);
  });

  it("does not overshoot at a peak (extremum → flat tangent)", () => {
    // values 0, 10, 0 — middle is a local max; smoothed curve must never exceed 10.
    const track = {
      mode: "Keyframed" as const,
      value: [mkKf("a", 0, 0), mkKf("b", 1_000_000, 10), mkKf("c", 2_000_000, 0)],
    };
    const out = smoothTrack(track);
    for (let t = 0; t <= 2_000_000; t += 50_000) {
      expect(resolveAnimated(out, t, 0)).toBeLessThanOrEqual(10 + 1e-6);
      expect(resolveAnimated(out, t, 0)).toBeGreaterThanOrEqual(-1e-6);
    }
  });

  it("does not undershoot at a valley (symmetric to the peak case)", () => {
    // values 10, 0, 10 — middle is a local min; smoothed curve must never drop below 0.
    const track = {
      mode: "Keyframed" as const,
      value: [mkKf("a", 0, 10), mkKf("b", 1_000_000, 0), mkKf("c", 2_000_000, 10)],
    };
    const out = smoothTrack(track);
    for (let t = 0; t <= 2_000_000; t += 50_000) {
      expect(resolveAnimated(out, t, 0)).toBeGreaterThanOrEqual(-1e-6);
      expect(resolveAnimated(out, t, 0)).toBeLessThanOrEqual(10 + 1e-6);
    }
  });

  it("leaves a single-keyframe track's interp unchanged (no neighbours)", () => {
    const track = { mode: "Keyframed" as const, value: [mkKf("a", 0, 4)] };
    const out = smoothKeyframe(track, "a");
    if (out.mode !== "Keyframed") throw new Error("expected keyframed");
    expect(out.value).toEqual(track.value); // content unchanged: no segment to smooth
  });

  it("keeps a flat (equal-value) segment Linear", () => {
    const track = {
      mode: "Keyframed" as const,
      value: [mkKf("a", 0, 5), mkKf("b", 1_000_000, 5), mkKf("c", 2_000_000, 9)],
    };
    const out = smoothKeyframe(track, "a");
    if (out.mode !== "Keyframed") throw new Error("expected keyframed");
    expect(out.value[0]!.interp.kind).toBe("Linear"); // a→b is flat (Δv=0)
  });

  it("produces in-range control-point y on a monotone ramp", () => {
    const track = {
      mode: "Keyframed" as const,
      value: [mkKf("a", 0, 0), mkKf("b", 1_000_000, 5), mkKf("c", 2_000_000, 10)],
    };
    const out = smoothKeyframe(track, "b");
    if (out.mode !== "Keyframed") throw new Error("expected keyframed");
    const seg = out.value[1]!.interp; // outgoing segment of b
    if (seg.kind !== "Bezier") throw new Error("expected bezier");
    expect(seg.p1[1]).toBeGreaterThanOrEqual(0);
    expect(seg.p1[1]).toBeLessThanOrEqual(1);
  });
});
