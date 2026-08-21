// Mode derivation and the patch each mode writes. The pair matters more than
// either half: the control has no stored mode to fall back on, so a derivation
// that disagrees with the patch would leave a button that never lights up.
import { describe, expect, it } from "vitest";
import { TEXT_BOX_MIN_PX } from "../render/textBox";
import { textBoxModeOf, textBoxPatchFor } from "./textBoxMode";

describe("textBoxModeOf", () => {
  it("reads the three modes off the box nullability", () => {
    expect(textBoxModeOf(null, null)).toBe("auto_width");
    expect(textBoxModeOf(600, null)).toBe("auto_height");
    expect(textBoxModeOf(600, 200)).toBe("fixed");
  });

  it("reads the illegal (null, set) pair as auto width, like the sprite does", () => {
    expect(textBoxModeOf(null, 200)).toBe("auto_width");
  });

  it("treats a non-positive or non-finite extent as no box", () => {
    expect(textBoxModeOf(0, 200)).toBe("auto_width");
    expect(textBoxModeOf(-10, null)).toBe("auto_width");
    expect(textBoxModeOf(Number.NaN, null)).toBe("auto_width");
    // A width with a broken height is auto height, not fixed — matching the
    // layout the renderer would actually produce.
    expect(textBoxModeOf(600, 0)).toBe("auto_height");
  });
});

describe("textBoxPatchFor", () => {
  const measured = { w: 420.4, h: 96.6 };

  it("nulls BOTH axes for auto width, in one patch", () => {
    // The mutation layer refuses `{ box_w: null }` alone on a Fixed layer, so
    // the pair is the contract, not a convenience.
    expect(textBoxPatchFor("auto_width", { boxW: 600, boxH: 200 }, measured)).toEqual({
      box_w: null,
      box_h: null,
    });
  });

  it("needs no measurement for auto width", () => {
    expect(textBoxPatchFor("auto_width", { boxW: 600, boxH: 200 }, null)).toEqual({
      box_w: null,
      box_h: null,
    });
  });

  it("keeps an existing width verbatim rather than re-rounding it", () => {
    expect(textBoxPatchFor("auto_height", { boxW: 600.5, boxH: 200 }, measured)).toEqual({
      box_w: 600.5,
      box_h: null,
    });
    expect(textBoxPatchFor("fixed", { boxW: 600.5, boxH: null }, measured)).toEqual({
      box_w: 600.5,
      box_h: 97,
    });
  });

  it("derives an absent axis from the measured size, rounded", () => {
    expect(textBoxPatchFor("auto_height", { boxW: null, boxH: null }, measured)).toEqual({
      box_w: 420,
      box_h: null,
    });
    expect(textBoxPatchFor("fixed", { boxW: null, boxH: null }, measured)).toEqual({
      box_w: 420,
      box_h: 97,
    });
  });

  it("floors a derived axis at the drag floor", () => {
    expect(textBoxPatchFor("fixed", { boxW: null, boxH: null }, { w: 3, h: 2 })).toEqual({
      box_w: TEXT_BOX_MIN_PX,
      box_h: TEXT_BOX_MIN_PX,
    });
  });

  it("refuses a mode it cannot measure instead of proposing 0 or NaN", () => {
    // Both are values `mutations/params.ts` rejects outright, so guessing one
    // would turn a mode switch into a status-bar refusal.
    expect(textBoxPatchFor("auto_height", { boxW: null, boxH: null }, null)).toBeNull();
    expect(textBoxPatchFor("fixed", { boxW: null, boxH: null }, null)).toBeNull();
    expect(textBoxPatchFor("fixed", { boxW: 600, boxH: null }, null)).toBeNull();
    expect(textBoxPatchFor("fixed", { boxW: null, boxH: null }, { w: 0, h: 0 })).toBeNull();
  });

  it("still reaches fixed from auto height with only a height to measure", () => {
    expect(textBoxPatchFor("fixed", { boxW: 600, boxH: null }, { w: 600, h: 120 })).toEqual({
      box_w: 600,
      box_h: 120,
    });
  });
});
