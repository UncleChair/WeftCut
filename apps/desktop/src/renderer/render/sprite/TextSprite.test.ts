// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { TextSprite } from "./TextSprite";

const base = {
  kind: "Text" as const, content: "x", font_family: "Liberation Sans", font_size_px: 54,
  weight: 700, italic: true, align: "Center" as const, anchor_x: 0.5, anchor_y: 1.0,
  color: { r: 255, g: 255, b: 255, a: 255 }, x: 0, y: 0,
  scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1,
  outline: { color: { r: 0, g: 0, b: 0, a: 255 }, width: 3 },
  shadow: { color: { r: 0, g: 0, b: 0, a: 255 }, offset_x: 2, offset_y: 2, blur: 2 },
};

describe("TextSprite", () => {
  it("applies weight, italic, stroke, dropShadow and anchor", () => {
    const s = new TextSprite({ layerId: "L" });
    s.update(base);
    expect(s.text.style.fontWeight).toBe("700");
    expect(s.text.style.fontStyle).toBe("italic");
    expect(s.text.style.stroke).toBeTruthy();
    expect(s.text.style.dropShadow).toBeTruthy();
    expect(s.text.style.align).toBe("center");
    expect(s.text.anchor.y).toBe(1.0);
  });

  it("applies scale and rotation without rebuilding text style", () => {
    const s = new TextSprite({ layerId: "L" });
    s.update({ ...base, scale_x: 1.5, scale_y: 0.75, rotation_deg: 30 });

    expect(s.text.scale.x).toBe(1.5);
    expect(s.text.scale.y).toBe(0.75);
    expect(s.text.angle).toBeCloseTo(30);
  });
});
