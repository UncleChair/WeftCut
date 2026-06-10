import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../host", () => ({
  captureMotifFrame: vi.fn(async () => ({ width: 480, height: 480 }) as unknown as ImageBitmap),
}));
import { captureMotifFrame } from "../host";
import { rasterMotifFrame, bakeMotifFrame } from "../motifRaster";

describe("rasterMotifFrame", () => {
  beforeEach(() => {
    (captureMotifFrame as unknown as ReturnType<typeof vi.fn>).mockClear();
    delete (globalThis as Record<string, unknown>).window;
  });

  it("delegates to captureMotifFrame with id, tSec, props, dims", async () => {
    const bmp = await rasterMotifFrame("countdown", 2.5, { seconds: 5 }, 480, 480);
    expect(captureMotifFrame).toHaveBeenCalledWith("countdown", 2.5, { seconds: 5 }, 480, 480, undefined, undefined);
    expect(bmp).toEqual({ width: 480, height: 480 });
  });

  it("bumps window.__weftcutMotifPerf.renders when present", async () => {
    (globalThis as Record<string, unknown>).window = { __weftcutMotifPerf: { renders: 0 } };
    await rasterMotifFrame("countdown", 0, {}, 480, 480);
    expect(((globalThis as Record<string, unknown>).window as { __weftcutMotifPerf: { renders: number } }).__weftcutMotifPerf.renders).toBe(1);
  });
});

describe("bakeMotifFrame", () => {
  beforeEach(() => {
    (captureMotifFrame as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  it("captures a content frame at manifest size and forwards manifest settle_rafs", async () => {
    const motif = { manifest: { id: "countdown", size: [480, 480], settle_rafs: 1 } } as unknown as Parameters<
      typeof bakeMotifFrame
    >[0];
    // frame 9 at 30fps → tSec = 9 * 1/30 = 0.3; settle_rafs:1 must reach the capture.
    await bakeMotifFrame(motif, 9, 30, 1, { seconds: 5 });
    expect(captureMotifFrame).toHaveBeenCalledWith("countdown", 0.3, { seconds: 5 }, 480, 480, 1, undefined);
  });
});
