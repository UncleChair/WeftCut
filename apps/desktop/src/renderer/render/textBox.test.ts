import { describe, expect, it } from "vitest";

import { fitFontSize, isShrunk, TEXT_BOX_MIN_PX } from "./textBox";

/// A measurement with the one property the bisection assumes: extent is
/// proportional to the size. Real glyph advances have it; a stub that ignored
/// the size would make every candidate measure the same and no search could
/// converge, so the shape of this stub IS the premise under test.
function proportional(perPx: number): {
  measure: (px: number) => { w: number; h: number };
  probes: number[];
} {
  const probes: number[] = [];
  return {
    measure: (px) => {
      probes.push(px);
      return { w: px * perPx, h: px };
    },
    probes,
  };
}

describe("fitFontSize", () => {
  it("returns the authored size untouched — and unrounded — when it fits", () => {
    const m = proportional(2);
    // 54.5 px is legal state; a search that answered 54 here would silently
    // re-quantize a size the user set.
    expect(fitFontSize({ authoredPx: 54.5, boxW: 1000, boxH: 1000, ...m })).toEqual({
      authoredPx: 54.5,
      effectivePx: 54.5,
      overflowing: false,
    });
    expect(m.probes).toEqual([54.5]);
  });

  it("takes the largest whole pixel that fits, never the next one up", () => {
    const m = proportional(1);
    const fit = fitFontSize({ authoredPx: 54, boxW: 30.4, boxH: 1000, ...m });
    expect(fit.effectivePx).toBe(30);
    expect(fit.overflowing).toBe(false);
    // The result is shrunk without overflowing: the feature working, not the
    // feature out of room.
    expect(isShrunk(fit)).toBe(true);
  });

  it("honours whichever axis binds", () => {
    // Wide and short: the height decides. Same measurement, tall box: the width.
    expect(fitFontSize({ authoredPx: 80, boxW: 1000, boxH: 25, ...proportional(4) }).effectivePx).toBe(25);
    expect(fitFontSize({ authoredPx: 80, boxW: 60, boxH: 1000, ...proportional(4) }).effectivePx).toBe(15);
  });

  it("stops at the floor and reports overflow instead of continuing down", () => {
    const m = proportional(1);
    const fit = fitFontSize({ authoredPx: 54, boxW: 4, boxH: 1000, ...m });
    expect(fit.effectivePx).toBe(TEXT_BOX_MIN_PX);
    expect(fit.overflowing).toBe(true);
    // Overflow and shrink are different questions and this case answers yes to
    // both; nothing below the floor was ever probed.
    expect(isShrunk(fit)).toBe(true);
    expect(Math.min(...m.probes)).toBe(TEXT_BOX_MIN_PX);
  });

  it("never ENLARGES a size already below the floor", () => {
    // A 6 px caption in a box too small for it overflows at 6 px. Growing it to
    // the 8 px floor would make a box drag increase the font size, which is the
    // defect the whole box exists to remove.
    const tight = fitFontSize({ authoredPx: 6, boxW: 4, boxH: 1000, ...proportional(1) });
    expect(tight).toEqual({ authoredPx: 6, effectivePx: 6, overflowing: true });

    const roomy = fitFontSize({ authoredPx: 6, boxW: 400, boxH: 1000, ...proportional(1) });
    expect(roomy).toEqual({ authoredPx: 6, effectivePx: 6, overflowing: false });
    expect(isShrunk(roomy)).toBe(false);
  });

  it("bisects rather than walking: probe count is logarithmic in the range", () => {
    const m = proportional(1);
    const fit = fitFontSize({ authoredPx: 4096, boxW: 100, boxH: 1e9, ...m });
    expect(fit.effectivePx).toBe(100);
    // log2(4096 - 8) ≈ 12, plus the authored probe. A linear walk would be
    // ~4000 measurements and the same assertion would catch it.
    expect(m.probes.length).toBeLessThanOrEqual(14);
    // Whole pixels only, so the probe set stays finite and every entry the
    // measurement cache gains is one a later search can reuse.
    expect(m.probes.slice(1).every(Number.isInteger)).toBe(true);
  });

  it("is monotone in the box: a bigger box never renders smaller text", () => {
    let prev = 0;
    for (let boxW = 1; boxW <= 200; boxW += 3) {
      const px = fitFontSize({ authoredPx: 54, boxW, boxH: 1000, ...proportional(1) }).effectivePx;
      expect(px).toBeGreaterThanOrEqual(prev);
      expect(px).toBeLessThanOrEqual(54);
      prev = px;
    }
    expect(prev).toBe(54);
  });

  it("does not measure at all for a size that is not a positive number", () => {
    // A hand-edited project, not something to bisect toward — and NaN through
    // the comparisons would report a spurious overflow.
    for (const authoredPx of [0, -12, Number.NaN, Number.POSITIVE_INFINITY]) {
      const m = proportional(1);
      const fit = fitFontSize({ authoredPx, boxW: 100, boxH: 100, ...m });
      expect(fit.effectivePx).toBe(authoredPx);
      expect(fit.overflowing).toBe(false);
      expect(m.probes).toEqual([]);
    }
  });

  it("counts an exactly-filled box as fitting", () => {
    // The tolerance exists for summed-advance float error, so a block landing on
    // the edge must not shrink one pixel out of superstition.
    const fit = fitFontSize({ authoredPx: 40, boxW: 40, boxH: 40, ...proportional(1) });
    expect(fit).toEqual({ authoredPx: 40, effectivePx: 40, overflowing: false });
  });
});
