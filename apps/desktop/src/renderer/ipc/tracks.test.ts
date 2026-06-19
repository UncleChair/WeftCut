import { describe, expect, it } from "vitest";
import { trackStatic, type AnimTrack } from "./index";

describe("trackStatic", () => {
  it("returns the static value", () => {
    expect(trackStatic({ mode: "Static", value: 0.5 }, 1)).toBe(0.5);
  });
  it("returns the first keyframe value (mirror of the old Rust static_or)", () => {
    const t: AnimTrack<number> = {
      mode: "Keyframed",
      value: [
        { id: "k1", t_us: 5, value: 0.25, interp: { kind: "Linear" } },
        { id: "k2", t_us: 9, value: 0.75, interp: { kind: "Linear" } },
      ],
    };
    expect(trackStatic(t, 1)).toBe(0.25);
  });
  it("falls back on empty keyframes", () => {
    expect(trackStatic({ mode: "Keyframed", value: [] }, 1)).toBe(1);
  });
});
