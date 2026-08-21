// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { blockAnchorInBox, TextSprite } from "./TextSprite";

const base = {
  kind: "Text" as const, content: "x", font_family: "Liberation Sans", font_size_px: 54,
  weight: 700, italic: true, align: "Center" as const, anchor_x: 0.5, anchor_y: 1.0,
  color: { r: 255, g: 255, b: 255, a: 255 }, x: 0, y: 0,
  scale_x: 1, scale_y: 1, rotation_deg: 0, opacity: 1,
  outline: { color: { r: 0, g: 0, b: 0, a: 255 }, width: 3 },
  shadow: { color: { r: 0, g: 0, b: 0, a: 255 }, offset_x: 2, offset_y: 2, blur: 2 },
  box_w: null, box_h: null, valign: "Middle" as const, line_height: 0, letter_spacing: 0,
};

/// Stroke and shadow inflate the measured block (`_adjustWidthForStyle`), which
/// would make every expected coordinate a sum of three terms. The box cases
/// drop both so the block's extent is exactly `maxLineWidth`.
const plain = { ...base, outline: null, shadow: null };

/// Every glyph this wide, so the expected geometry is arithmetic instead of a
/// property of whatever font the test machine resolved.
const ADVANCE_PX = 10;

/// A box makes `TextSprite` MEASURE, and jsdom ships no 2D context. Pixi reaches
/// for `OffscreenCanvas` first and only falls back to `document.createElement`,
/// so stubbing the constructor is enough to own the whole measurement path.
/// `CanvasRenderingContext2D` exists only for Pixi's letter-spacing capability
/// probe, which reads its prototype.
beforeAll(() => {
  const ctx = {
    font: "",
    letterSpacing: "0px",
    measureText: (s: string) => {
      const width = [...s].length * ADVANCE_PX;
      return {
        width,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
      };
    },
  };
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        public width = 0,
        public height = 0,
      ) {}
      getContext(): unknown {
        return ctx;
      }
    },
  );
  vi.stubGlobal("CanvasRenderingContext2D", class {});
});

/// The stub's font metrics: ascent + descent, which is also the auto line height.
const LINE_H = 10;

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

  it("wraps only when a box width says so, and never splits a Latin word", () => {
    const s = new TextSprite({ layerId: "L" });
    s.update({ ...plain, content: "aaa bbb" });
    expect(s.text.style.wordWrap).toBe(false);

    s.update({ ...plain, content: "aaa bbb", box_w: 200, line_height: 72, letter_spacing: 4 });
    expect(s.text.style.wordWrap).toBe(true);
    expect(s.text.style.wordWrapWidth).toBe(200);
    expect(s.text.style.lineHeight).toBe(72);
    expect(s.text.style.letterSpacing).toBe(4);
    // The CJK hook is what wraps unspaced text; `breakWords` must stay off or
    // it would chop "wonderful" in half.
    expect(s.text.style.breakWords).toBe(false);
  });

  it("places a single line against the box edge that `align` names", () => {
    const s = new TextSprite({ layerId: "L" });
    // One 70 px line in a 200 px box, anchored at its centre: the box spans
    // [-100, +100] around `position`, so the block's own edges are the assertion.
    const box = { ...plain, content: "aaa bbb", box_w: 200, anchor_x: 0.5, anchor_y: 0.5 };

    s.update({ ...box, align: "Left" });
    expect(s.text.getLocalBounds().minX).toBeCloseTo(-100, 6);

    s.update({ ...box, align: "Right" });
    expect(s.text.getLocalBounds().maxX).toBeCloseTo(100, 6);

    s.update({ ...box, align: "Center" });
    const b = s.text.getLocalBounds();
    expect((b.minX + b.maxX) / 2).toBeCloseTo(0, 6);
  });

  it("moves a short block between the top, middle and bottom of a tall box", () => {
    const s = new TextSprite({ layerId: "L" });
    // 300 px tall box around `position` ⇒ [-150, +150]; the block is one line.
    const box = { ...plain, content: "aaa", box_w: 200, box_h: 300, anchor_x: 0.5, anchor_y: 0.5 };

    s.update({ ...box, valign: "Top" });
    expect(s.text.getLocalBounds().minY).toBeCloseTo(-150, 6);

    s.update({ ...box, valign: "Bottom" });
    expect(s.text.getLocalBounds().maxY).toBeCloseTo(150, 6);

    s.update({ ...box, valign: "Middle" });
    const b = s.text.getLocalBounds();
    expect((b.minY + b.maxY) / 2).toBeCloseTo(0, 6);
  });

  it("leaves Auto width exactly where it was: align and valign move nothing", () => {
    const s = new TextSprite({ layerId: "L" });
    for (const align of ["Left", "Center", "Right"] as const) {
      for (const valign of ["Top", "Middle", "Bottom"] as const) {
        s.update({ ...plain, content: "aaa bbb", align, valign, anchor_x: 0.25, anchor_y: 0.75 });
        // The raw anchor pair, not a renormalized one — this is the identity
        // ADR 0049 promises for the no-box case.
        expect(s.text.anchor.x).toBe(0.25);
        expect(s.text.anchor.y).toBe(0.75);
      }
    }
  });

  it("treats box_h without a box_w as Auto width instead of blanking the frame", () => {
    const s = new TextSprite({ layerId: "L" });
    expect(() =>
      s.update({ ...plain, content: "aaa bbb", box_w: null, box_h: 300, valign: "Bottom" }),
    ).not.toThrow();
    expect(s.text.style.wordWrap).toBe(false);
    expect(s.text.anchor.x).toBe(0.5);
    expect(s.text.anchor.y).toBe(1.0);
    expect(s.naturalSize()).toEqual({ w: 7 * ADVANCE_PX, h: LINE_H });
  });

  it("reports the box as the natural size once one is set, measured bounds until then", () => {
    const s = new TextSprite({ layerId: "L" });
    s.update({ ...plain, content: "aaa bbb" });
    expect(s.naturalSize()).toEqual({ w: 7 * ADVANCE_PX, h: LINE_H });

    // Auto height: the width is the box, the height is still measured.
    s.update({ ...plain, content: "aaa bbb", box_w: 200 });
    expect(s.naturalSize()).toEqual({ w: 200, h: LINE_H });

    s.update({ ...plain, content: "aaa bbb", box_w: 200, box_h: 300 });
    expect(s.naturalSize()).toEqual({ w: 200, h: 300 });
  });

  it("renders a garbage align/valign at the default instead of vanishing", () => {
    const s = new TextSprite({ layerId: "L" });
    const bogus = {
      ...plain,
      content: "aaa",
      box_w: 200,
      box_h: 300,
      anchor_x: 0.5,
      anchor_y: 0.5,
      align: "Centre" as unknown as "Center",
      valign: "Center" as unknown as "Middle",
    };
    expect(() => s.update(bogus)).not.toThrow();
    // NaN is the failure mode: Pixi takes a NaN anchor and the layer disappears
    // rather than looking misplaced.
    expect(Number.isFinite(s.text.anchor.x)).toBe(true);
    expect(Number.isFinite(s.text.anchor.y)).toBe(true);
    expect(s.text.style.align).toBe("center");
    const b = s.text.getLocalBounds();
    expect((b.minX + b.maxX) / 2).toBeCloseTo(0, 6);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(0, 6);
  });
});

describe("blockAnchorInBox", () => {
  const block = { blockW: 137.4, blockH: 61.9 };
  const aligns = ["left", "center", "right"] as const;
  const valigns = ["Top", "Middle", "Bottom"] as const;

  it("is the identity with no box, for every align/valign and any anchor", () => {
    for (const align of aligns) {
      for (const valign of valigns) {
        const anchors: [number, number][] = [
          [0, 0],
          [0.5, 0.5],
          [1, 1],
          [0.1, 0.3],
          [0.7, 0.9],
        ];
        for (const [anchorX, anchorY] of anchors) {
          // Strict equality, not closeness: Auto width has to be bit-for-bit
          // what it rendered before the box existed, and `(a*b)/b` is not.
          expect(
            blockAnchorInBox({ ...block, boxW: null, boxH: null, align, valign, anchorX, anchorY }),
          ).toEqual({ anchorX, anchorY });
        }
      }
    }
  });

  it("is the identity per axis, so Auto height leaves the vertical alone", () => {
    const r = blockAnchorInBox({
      ...block, boxW: 400, boxH: null, align: "left", valign: "Bottom", anchorX: 0.5, anchorY: 0.3,
    });
    expect(r.anchorY).toBe(0.3);
    expect(r.anchorX).not.toBe(0.5);
  });

  it("lands the block's aligned edge on the box's", () => {
    // Block left edge in local space is `-anchorX * blockW`; the box's is
    // `-anchor * boxW`. Left/right/centre must make those coincide.
    const boxW = 200, blockW = 50, anchor = 0.5;
    const at = (align: (typeof aligns)[number]): number =>
      -blockAnchorInBox({
        blockW, blockH: 20, boxW, boxH: null, align, valign: "Top", anchorX: anchor, anchorY: 0,
      }).anchorX * blockW;
    expect(at("left")).toBeCloseTo(-anchor * boxW, 9);
    expect(at("right") + blockW).toBeCloseTo((1 - anchor) * boxW, 9);
    expect(at("center") + blockW / 2).toBeCloseTo(0, 9);
  });

  it("returns the raw anchor rather than NaN when the block measures empty", () => {
    const empties: [number, number][] = [
      [0, 0],
      [0, 40],
      [40, 0],
      [Number.NaN, 40],
    ];
    for (const [blockW, blockH] of empties) {
      const r = blockAnchorInBox({
        blockW, blockH, boxW: 200, boxH: 300, align: "right", valign: "Bottom",
        anchorX: 0.25, anchorY: 0.75,
      });
      expect(Number.isFinite(r.anchorX)).toBe(true);
      expect(Number.isFinite(r.anchorY)).toBe(true);
    }
  });

  it("falls back to centre/Middle on an align or valign it does not know", () => {
    const known = blockAnchorInBox({
      ...block, boxW: 400, boxH: 300, align: "center", valign: "Middle", anchorX: 0.5, anchorY: 0.5,
    });
    const bogus = blockAnchorInBox({
      ...block, boxW: 400, boxH: 300,
      align: "middle" as unknown as "center",
      valign: "Center" as unknown as "Middle",
      anchorX: 0.5, anchorY: 0.5,
    });
    expect(bogus).toEqual(known);
  });
});
