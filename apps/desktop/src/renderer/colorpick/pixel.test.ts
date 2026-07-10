import { describe, expect, it } from "vitest";
import { containMap, hexToRgb01, rgbToHex, sampleHex, samplePatch } from "./pixel";

const buf2x2 = {
  // (0,0)=red (1,0)=green (0,1)=blue (1,1)=white
  pixels: new Uint8Array([
    255, 0, 0, 255,   0, 255, 0, 255,
    0, 0, 255, 255,   255, 255, 255, 255,
  ]),
  width: 2,
  height: 2,
};

describe("hex conversion", () => {
  it("rgbToHex zero-pads and lowercases", () => {
    expect(rgbToHex(255, 0, 10)).toBe("#ff000a");
  });
  it("hexToRgb01 round-trips", () => {
    expect(hexToRgb01("#ff0000")).toEqual([1, 0, 0]);
    const [r, g, b] = hexToRgb01("#336699");
    expect(r).toBeCloseTo(0x33 / 255);
    expect(g).toBeCloseTo(0x66 / 255);
    expect(b).toBeCloseTo(0x99 / 255);
  });
});

describe("sampleHex", () => {
  it("reads the addressed pixel", () => {
    expect(sampleHex(buf2x2, 0, 0)).toBe("#ff0000");
    expect(sampleHex(buf2x2, 1, 1)).toBe("#ffffff");
  });
  it("clamps out-of-range coordinates", () => {
    expect(sampleHex(buf2x2, -5, 0)).toBe("#ff0000");
    expect(sampleHex(buf2x2, 99, 99)).toBe("#ffffff");
  });
});

describe("samplePatch", () => {
  it("returns a (2r+1)² patch with edge clamping", () => {
    const p = samplePatch(buf2x2, 0, 0, 1);
    expect(p.width).toBe(3);
    expect(p.height).toBe(3);
    // Center = (0,0) red; corner (-1,-1) clamps to (0,0) red too.
    expect(sampleHex(p, 1, 1)).toBe("#ff0000");
    expect(sampleHex(p, 0, 0)).toBe("#ff0000");
    // (2,2) of the patch = source (1,1) white.
    expect(sampleHex(p, 2, 2)).toBe("#ffffff");
  });
});

describe("containMap", () => {
  // 16:9 content (1920×1080) inside a 1000×1000 rect at (0,0):
  // scale=1000/1920, content displays 1000×562.5, top offset 218.75.
  const rect = { left: 0, top: 0, width: 1000, height: 1000 };
  it("maps the rect center to the content center", () => {
    expect(containMap(500, 500, rect, 1920, 1080)).toEqual({ x: 960, y: 540 });
  });
  it("returns null in the letterbox bars", () => {
    expect(containMap(500, 100, rect, 1920, 1080)).toBeNull();
    expect(containMap(500, 950, rect, 1920, 1080)).toBeNull();
  });
  it("returns null for degenerate rects", () => {
    expect(containMap(0, 0, { left: 0, top: 0, width: 0, height: 0 }, 1920, 1080)).toBeNull();
  });
  it("returns null for non-finite client coordinates", () => {
    expect(containMap(NaN, 500, rect, 1920, 1080)).toBeNull();
    expect(containMap(500, NaN, rect, 1920, 1080)).toBeNull();
  });
});
