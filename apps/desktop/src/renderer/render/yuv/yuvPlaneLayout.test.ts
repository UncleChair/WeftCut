import { describe, expect, it } from "vitest";
import { yuvPlaneLayout } from "./yuvPlaneLayout";

describe("yuvPlaneLayout", () => {
  it("yuv420p10le 1920x1080 matches the frozen PackYuv420p10 geometry", () => {
    const l = yuvPlaneLayout("yuv420p10le", 1920, 1080);
    expect(l).toEqual({
      bytesPerSample: 2, samplesPerTexel: 2,
      y: { passW: 960, passH: 1080, rowBytes: 3840, planeBytes: 3840 * 1080 },
      c: { passW: 480, passH: 540, rowBytes: 1920, planeBytes: 1920 * 540 },
      frameBytes: 3840 * 1080 + 2 * 1920 * 540,
    });
  });

  it("yuv420p 1920x1080 — dense 4-samples-per-texel", () => {
    const l = yuvPlaneLayout("yuv420p", 1920, 1080);
    expect(l.bytesPerSample).toBe(1);
    expect(l.samplesPerTexel).toBe(4);
    expect(l.y).toEqual({ passW: 480, passH: 1080, rowBytes: 1920, planeBytes: 1920 * 1080 });
    expect(l.c).toEqual({ passW: 240, passH: 540, rowBytes: 960, planeBytes: 960 * 540 });
    expect(l.frameBytes).toBe(1920 * 1080 * 1.5);
  });

  it("yuv420p 1366x768 — W%4==2 pads the pass row, plane rows stay exact", () => {
    const l = yuvPlaneLayout("yuv420p", 1366, 768);
    // Y row = 1366 samples = 1366 bytes; pass row = ceil(1366/4)=342 texels = 1368 bytes.
    expect(l.y.passW).toBe(342);
    expect(l.y.rowBytes).toBe(1366);
    // C row = 683 samples; pass = ceil(683/4)=171 texels = 684 bytes vs 683 valid.
    expect(l.c.passW).toBe(171);
    expect(l.c.rowBytes).toBe(683);
    expect(l.c.passH).toBe(384);
    expect(l.frameBytes).toBe(1366 * 768 + 2 * 683 * 384);
  });

  it("yuv422p keeps full-height chroma", () => {
    const l = yuvPlaneLayout("yuv422p", 1920, 1080);
    expect(l.c).toEqual({ passW: 240, passH: 1080, rowBytes: 960, planeBytes: 960 * 1080 });
    expect(l.frameBytes).toBe(1920 * 1080 * 2);
  });

  it("yuv422p10le — ProRes shape", () => {
    const l = yuvPlaneLayout("yuv422p10le", 1920, 1080);
    expect(l.y).toEqual({ passW: 960, passH: 1080, rowBytes: 3840, planeBytes: 3840 * 1080 });
    expect(l.c).toEqual({ passW: 480, passH: 1080, rowBytes: 1920, planeBytes: 1920 * 1080 });
  });

  it("rejects odd dimensions", () => {
    expect(() => yuvPlaneLayout("yuv420p", 1921, 1080)).toThrow(/even/);
    expect(() => yuvPlaneLayout("yuv420p", 1920, 1081)).toThrow(/even/);
  });
});
