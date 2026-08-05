import { describe, expect, it } from "vitest";

import { anchorOr, anchorPivot, DEFAULT_ANCHOR } from "./anchorPivot";

/// Where the four corners of a `texW×texH` quad land once Pixi applies
/// `world = position + R·S·(local − pivot)`. The assertions below are about
/// RENDERED geometry, not about the intermediate pivot/position pair — that is
/// the only way to state "unchanged for unrotated layers" as a real invariant.
function worldCorners(
  r: { pivotX: number; pivotY: number; posX: number; posY: number },
  texW: number,
  texH: number,
  scaleX: number,
  scaleY: number,
  angleDeg = 0,
): Array<[number, number]> {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const map = (lx: number, ly: number): [number, number] => {
    const dx = (lx - r.pivotX) * scaleX;
    const dy = (ly - r.pivotY) * scaleY;
    return [r.posX + dx * cos - dy * sin, r.posY + dx * sin + dy * cos];
  };
  return [map(0, 0), map(texW, 0), map(texW, texH), map(0, texH)];
}

const base = {
  x: 100,
  y: 50,
  anchorX: 0.5,
  anchorY: 0.5,
  texW: 200,
  texH: 100,
  effScaleX: 1,
  effScaleY: 1,
};

describe("anchorPivot", () => {
  it("puts the pivot on the anchor in local (texture) space", () => {
    const r = anchorPivot(base);
    expect(r.pivotX).toBe(100);
    expect(r.pivotY).toBe(50);
  });

  it("keeps the unrotated top-left on (x, y) at any scale", () => {
    for (const s of [0.25, 1, 2.5]) {
      const r = anchorPivot({ ...base, effScaleX: s, effScaleY: s });
      const [tl] = worldCorners(r, base.texW, base.texH, s, s);
      expect(tl).toEqual([100, 50]);
    }
  });

  it("keeps the unrotated top-left on (x, y) for non-uniform scale", () => {
    const r = anchorPivot({ ...base, effScaleX: 3, effScaleY: 0.5 });
    const [tl] = worldCorners(r, base.texW, base.texH, 3, 0.5);
    expect(tl).toEqual([100, 50]);
  });

  it("mirrors a flip in place instead of moving the box", () => {
    // flip_h ⇒ the sprite renders at negative scale_x. The box must still
    // occupy [x, x+w]; the pre-anchor behaviour put it at [x-w, x].
    const r = anchorPivot({ ...base, effScaleX: -1 });
    const xs = worldCorners(r, base.texW, base.texH, -1, 1).map(([cx]) => cx);
    expect(Math.min(...xs)).toBe(100);
    expect(Math.max(...xs)).toBe(300);
  });

  it("rotates about the anchor, not the top-left", () => {
    const r = anchorPivot(base);
    const corners = worldCorners(r, base.texW, base.texH, 1, 1, 180);
    // 180° about the center swaps opposite corners: the box is unmoved.
    const xs = corners.map(([cx]) => cx);
    const ys = corners.map(([, cy]) => cy);
    expect(Math.min(...xs)).toBeCloseTo(100, 9);
    expect(Math.max(...xs)).toBeCloseTo(300, 9);
    expect(Math.min(...ys)).toBeCloseTo(50, 9);
    expect(Math.max(...ys)).toBeCloseTo(150, 9);
  });

  it("degrades to the old pivot-less transform at anchor (0, 0)", () => {
    const r = anchorPivot({ ...base, anchorX: 0, anchorY: 0, effScaleX: 2, effScaleY: 2 });
    expect(r).toEqual({ pivotX: 0, pivotY: 0, posX: 100, posY: 50 });
  });

  it("lands at (x, y) before the first frame binds (EMPTY texture)", () => {
    for (const tex of [null, 0]) {
      const r = anchorPivot({ ...base, texW: tex, texH: tex });
      expect(r).toEqual({ pivotX: 0, pivotY: 0, posX: 100, posY: 50 });
    }
  });

  // Regression: the renderer used to coalesce an absent anchor to 0 while the
  // on-canvas box coalesced it to 0.5, so a rotated layer spun around its
  // top-left while its box spun around its center. One default, one module.
  it("coalesces an absent anchor to the stored default, not to zero", () => {
    for (const absent of [undefined, Number.NaN]) {
      expect(
        anchorPivot({ ...base, anchorX: absent, anchorY: absent }),
      ).toEqual(anchorPivot({ ...base, anchorX: 0.5, anchorY: 0.5 }));
    }
    expect(anchorOr(undefined)).toBe(DEFAULT_ANCHOR);
    expect(anchorOr(0)).toBe(0);
  });

  it("never emits NaN for a non-finite scale", () => {
    const r = anchorPivot({ ...base, effScaleX: Number.NaN, effScaleY: Number.POSITIVE_INFINITY });
    expect(r.posX).toBe(100);
    expect(r.posY).toBe(50);
  });
});
