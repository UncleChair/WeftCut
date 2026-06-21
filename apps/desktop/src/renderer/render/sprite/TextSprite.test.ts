// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { TextSprite } from "./TextSprite";

const base = {
  kind: "Text" as const, content: "x", font_family: "Liberation Sans", font_size_px: 54,
  weight: 700, italic: true, align: "Center" as const, anchor_x: 0.5, anchor_y: 1.0,
  color: { r: 255, g: 255, b: 255, a: 255 }, x: 0, y: 0, opacity: 1,
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

  it("does not throw when Phase-2 fields are absent (stale backend view)", () => {
    const minimal = {
      kind: "Text" as const,
      content: "hello",
      font_family: "Arial",
      font_size_px: 32,
      color: { r: 255, g: 255, b: 255, a: 255 },
      x: 0,
      y: 0,
      opacity: 1,
    } as unknown as import("../resolveView").ResolvedTextView;

    const s = new TextSprite({ layerId: "L2" });
    expect(() => s.update(minimal)).not.toThrow();
    expect(s.text.style.align).toBe("center");
    expect(s.text.anchor.x).toBe(0.5);
  });
});
