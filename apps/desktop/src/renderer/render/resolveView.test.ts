import { describe, expect, it } from "vitest";
import type { AnimTrack, ColorView, Rgba, TextView, VideoClipView } from "../ipc";
import { DEFAULT_ANCHOR } from "./anchorPivot";
import { resolveColorView, resolveTextView, resolveVideoClipView } from "./resolveView";

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
      x: stat(10), y: stat(20), scale_x: stat(1), scale_y: stat(2),
      scale_linked: true,
      rotation_deg: stat(15), opacity: stat(0.5),
      anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
      speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0,
    };
    const r = resolveVideoClipView(raw, 123_456);
    expect(r).toMatchObject({
      x: 10, y: 20, scale_x: 1, scale_y: 2,
      rotation_deg: 15, opacity: 0.5, speed: 1,
    });
  });
  it("keyframed numeric tracks resolve time-aware (value_at semantics)", () => {
    const raw: VideoClipView = {
      media_id: "m", media_label: "m", src_in_us: 0, src_out_us: 1,
      x: ramp, y: stat(0), scale_x: stat(1), scale_y: stat(1),
      scale_linked: true,
      rotation_deg: stat(0), opacity: ramp,
      anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
      speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0,
    };
    expect(resolveVideoClipView(raw, 500_000).x).toBeCloseTo(0.5, 9);
    expect(resolveVideoClipView(raw, 500_000).opacity).toBeCloseTo(0.5, 9);
  });
  it("text color Static track resolves to its value (resolveAnimatedColor short-circuit)", () => {
    const raw: TextView = {
      content: "hi", font_family: "Arial", font_size_px: 16,
      weight: 400, italic: false, align: "Left",
      anchor_x: { mode: "Static", value: 0 }, anchor_y: { mode: "Static", value: 0 },
      color: { mode: "Static", value: white },
      x: stat(0), y: stat(0), scale_x: stat(1), scale_y: stat(1),
      scale_linked: true,
      rotation_deg: stat(0), opacity: stat(1),
      outline: null, shadow: null,
      box_w: null, box_h: null, valign: "Middle", line_height: 0, letter_spacing: 0,
    };
    expect(resolveTextView(raw, 0).color).toEqual(white);
  });
  it("keyframed color-fill interpolates via OkLab wasm (not first-keyframe only)", () => {
    const red: Rgba = { r: 255, g: 0, b: 0, a: 255 };
    const green: Rgba = { r: 0, g: 255, b: 0, a: 255 };
    const colorTrack: AnimTrack<Rgba> = {
      mode: "Keyframed",
      value: [
        { id: "k0", t_us: 0, value: red, interp: { kind: "Linear" } },
        { id: "k1", t_us: 1_000_000, value: green, interp: { kind: "Linear" } },
      ],
    };
    const v: ColorView = { color: colorTrack, width: 1920, height: 1080 };
    const resolved = resolveColorView(v, 500_000);
    // OkLab midpoint red→green: anchored {208,168,0,255}, ±1 per channel.
    // Crucially, it must NOT be the first keyframe red {255,0,0,255}.
    expect(resolved.color.r).not.toBe(255);
    expect(resolved.color.r).toBeGreaterThanOrEqual(207);
    expect(resolved.color.r).toBeLessThanOrEqual(209);
    expect(resolved.color.g).toBeGreaterThanOrEqual(167);
    expect(resolved.color.g).toBeLessThanOrEqual(169);
    expect(resolved.color.b).toBeGreaterThanOrEqual(0);
    expect(resolved.color.b).toBeLessThanOrEqual(1);
    expect(resolved.color.a).toBe(255);
  });
  it("passes weight/italic/align/anchor/outline/shadow and the layout box through", () => {
    const v = resolveTextView(
      {
        content: "x",
        font_family: "Liberation Sans",
        font_size_px: 54,
        weight: 700,
        italic: true,
        align: "Center",
        anchor_x: { mode: "Static", value: 0.5 },
        anchor_y: { mode: "Static", value: 1.0 },
        color: { mode: "Static", value: { r: 255, g: 255, b: 255, a: 255 } },
        x: { mode: "Static", value: 100 },
        y: { mode: "Static", value: 200 },
        scale_x: { mode: "Static", value: 1 },
        scale_y: { mode: "Static", value: 1 },
        scale_linked: true,
        rotation_deg: { mode: "Static", value: 0 },
        opacity: { mode: "Static", value: 1 },
        outline: { color: { r: 0, g: 0, b: 0, a: 255 }, width: 3 },
        shadow: { color: { r: 0, g: 0, b: 0, a: 255 }, offset_x: 2, offset_y: 2, blur: 2 },
        box_w: 640,
        box_h: 300,
        valign: "Bottom",
        line_height: 72,
        letter_spacing: 4,
      },
      0,
    );
    expect(v.weight).toBe(700);
    expect(v.italic).toBe(true);
    expect(v.anchor_y).toBe(1.0);
    expect(v.outline?.width).toBe(3);
    expect(v.shadow?.blur).toBe(2);
    // The box fields are plain scalars, so `ResolvedTextView` inherits them and
    // the `...v` spread carries them — this asserts that, so nobody adds a
    // pass-through branch that already exists.
    expect(v.box_w).toBe(640);
    expect(v.box_h).toBe(300);
    expect(v.valign).toBe("Bottom");
    expect(v.line_height).toBe(72);
    expect(v.letter_spacing).toBe(4);
  });
  it("resolves the anchor pair over time, and coalesces an absent track to DEFAULT_ANCHOR", () => {
    // The anchor is keyframeable, so this IS the one place it becomes a scalar —
    // the sprites and the on-canvas box both read it from here. A 0 fallback
    // (the natural default for a missing number) would pivot the picture at its
    // top-left while the gizmo's box pivoted at its centre, and neither would
    // look broken alone.
    const raw: VideoClipView = {
      media_id: "m", media_label: "m", src_in_us: 0, src_out_us: 1,
      x: stat(0), y: stat(0), scale_x: stat(1), scale_y: stat(1),
      scale_linked: true,
      rotation_deg: stat(0), opacity: stat(1),
      anchor_x: ramp, anchor_y: stat(0.25),
      speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0,
    };
    expect(resolveVideoClipView(raw, 500_000).anchor_x).toBeCloseTo(0.5, 9);
    expect(resolveVideoClipView(raw, 500_000).anchor_y).toBe(0.25);
    // A version-skewed summary omitting the pair entirely (older main process).
    const { anchor_x: _x, anchor_y: _y, ...skewed } = raw;
    const r = resolveVideoClipView(skewed as VideoClipView, 0);
    expect([r.anchor_x, r.anchor_y]).toEqual([DEFAULT_ANCHOR, DEFAULT_ANCHOR]);
  });
});
