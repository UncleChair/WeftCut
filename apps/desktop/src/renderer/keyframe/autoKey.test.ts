import { describe, it, expect } from "vitest";
import type { AnimTrack } from "../ipc";
import { autoKeyTrack } from "./autoKey";

describe("autoKeyTrack", () => {
  it("upserts a new key at tInLayerUs on a Keyframed track", () => {
    const track: AnimTrack<number> = {
      mode: "Keyframed",
      value: [{ id: "a", t_us: 0, value: 0, interp: { kind: "Linear" } }],
    };
    const next = autoKeyTrack(track, 500_000, 0.5);
    expect(next.mode).toBe("Keyframed");
    if (next.mode !== "Keyframed") throw new Error("unreachable");
    expect(next.value.some((k) => k.t_us === 500_000 && k.value === 0.5)).toBe(true);
    expect(next.value).toHaveLength(2);
  });

  it("updates the value of an existing key at the same time in place", () => {
    const track: AnimTrack<number> = {
      mode: "Keyframed",
      value: [{ id: "a", t_us: 0, value: 0, interp: { kind: "Linear" } }],
    };
    const next = autoKeyTrack(track, 0, 0.9);
    if (next.mode !== "Keyframed") throw new Error("unreachable");
    expect(next.value).toHaveLength(1);
    expect(next.value[0]).toMatchObject({ id: "a", t_us: 0, value: 0.9 });
  });

  it("writes a Static value when the track is Static", () => {
    const track: AnimTrack<number> = { mode: "Static", value: 1 };
    const next = autoKeyTrack(track, 123, 0.25);
    expect(next).toEqual({ mode: "Static", value: 0.25 });
  });
});
