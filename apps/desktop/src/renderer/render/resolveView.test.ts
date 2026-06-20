import { describe, expect, it } from "vitest";
import type { AnimTrack, Rgba, TextView, VideoClipView } from "../ipc";
import { resolveTextView, resolveVideoClipView } from "./resolveView";

const stat = (v: number): AnimTrack<number> => ({ mode: "Static", value: v });
const ramp: AnimTrack<number> = {
  mode: "Keyframed",
  value: [
    { id: "a", t_us: 0, value: 0, interp: { kind: "Linear" } },
    { id: "b", t_us: 1_000_000, value: 1, interp: { kind: "Linear" } },
  ],
};
const white: Rgba = { r: 255, g: 255, b: 255, a: 255 };

describe("resolveView", () => {
  it("static tracks resolve to their value at any time", () => {
    const raw: VideoClipView = {
      media_id: "m", media_label: "m", src_in_us: 0, src_out_us: 1,
      x: stat(10), y: stat(20), scale_x: stat(1), scale_y: stat(2), opacity: stat(0.5),
      speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0,
    };
    const r = resolveVideoClipView(raw, 123_456);
    expect(r).toMatchObject({ x: 10, y: 20, scale_x: 1, scale_y: 2, opacity: 0.5, speed: 1 });
  });
  it("keyframed numeric tracks resolve time-aware (value_at semantics)", () => {
    const raw: VideoClipView = {
      media_id: "m", media_label: "m", src_in_us: 0, src_out_us: 1,
      x: ramp, y: stat(0), scale_x: stat(1), scale_y: stat(1), opacity: ramp,
      speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0,
    };
    expect(resolveVideoClipView(raw, 500_000).x).toBeCloseTo(0.5, 9);
    expect(resolveVideoClipView(raw, 500_000).opacity).toBeCloseTo(0.5, 9);
  });
  it("text color resolves statically until the Rgba engine twin exists", () => {
    const raw: TextView = {
      content: "hi", font_family: "Arial", font_size_px: 16,
      weight: 400, italic: false, align: "Left",
      anchor_x: 0, anchor_y: 0,
      color: { mode: "Static", value: white },
      x: stat(0), y: stat(0), opacity: stat(1),
      outline: null, shadow: null,
    };
    expect(resolveTextView(raw, 0).color).toEqual(white);
  });
  it("passes weight/italic/align/anchor/outline/shadow through", () => {
    const v = resolveTextView(
      {
        content: "x",
        font_family: "Liberation Sans",
        font_size_px: 54,
        weight: 700,
        italic: true,
        align: "Center",
        anchor_x: 0.5,
        anchor_y: 1.0,
        color: { mode: "Static", value: { r: 255, g: 255, b: 255, a: 255 } },
        x: { mode: "Static", value: 100 },
        y: { mode: "Static", value: 200 },
        opacity: { mode: "Static", value: 1 },
        outline: { color: { r: 0, g: 0, b: 0, a: 255 }, width: 3 },
        shadow: { color: { r: 0, g: 0, b: 0, a: 255 }, offset_x: 2, offset_y: 2, blur: 2 },
      },
      0,
    );
    expect(v.weight).toBe(700);
    expect(v.italic).toBe(true);
    expect(v.anchor_y).toBe(1.0);
    expect(v.outline?.width).toBe(3);
    expect(v.shadow?.blur).toBe(2);
  });
});
