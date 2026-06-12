import { describe, expect, it } from "vitest";
import { rgbToYuv10, yuv10ToRgb, BT709, BT601, packTwoSamples } from "./yuv10";

describe("yuv10 (BT.709 limited, gamma-domain)", () => {
  it("maps black/white/grey to canonical codes", () => {
    expect(rgbToYuv10(0, 0, 0, BT709)).toEqual([64, 512, 512]);
    expect(rgbToYuv10(1, 1, 1, BT709)).toEqual([940, 512, 512]);
    expect(rgbToYuv10(0.5, 0.5, 0.5, BT709)).toEqual([502, 512, 512]);
  });
  it("maps pure red per BT.709", () => {
    const [y, u, v] = rgbToYuv10(1, 0, 0, BT709);
    expect(y).toBe(250); // 64 + 876*0.2126 = 250.25 → 250
    expect(u).toBe(409); // 512 + 896*(-0.2126/1.8556)
    expect(v).toBe(960); // 512 + 896*(0.7874/1.5748) = 512+448
  });
  it("round-trips within one 10-bit step", () => {
    const cases: [number, number, number][] = [[0.1, 0.5, 0.9], [0.73, 0.21, 0.02], [1, 1, 0]];
    for (const [r, g, b] of cases) {
      const [y, u, v] = rgbToYuv10(r, g, b, BT709);
      const [r2, g2, b2] = yuv10ToRgb(y, u, v, BT709);
      expect(Math.abs(r2 - r)).toBeLessThan(1.5 / 876);
      expect(Math.abs(g2 - g)).toBeLessThan(1.5 / 876);
      expect(Math.abs(b2 - b)).toBeLessThan(1.5 / 876);
    }
  });
  it("clamps out-of-range input", () => {
    expect(rgbToYuv10(2, 2, 2, BT709)[0]).toBe(940);
    expect(rgbToYuv10(-1, -1, -1, BT709)[0]).toBe(64);
  });
  it("maps pure red per BT.601 (pins the 601 constants)", () => {
    expect(rgbToYuv10(1, 0, 0, BT601)).toEqual([326, 361, 960]);
    // 64 + 876*0.299 = 325.92 → 326; 512 − 896*0.299/1.772 = 360.83 → 361; 512 + 448
  });
  it("packs two 10-bit samples as u16LE byte quads", () => {
    expect(packTwoSamples(0x3ff, 0x040)).toEqual([255, 3, 64, 0]);
    expect(packTwoSamples(0, 1023)).toEqual([0, 0, 255, 3]);
  });
});
