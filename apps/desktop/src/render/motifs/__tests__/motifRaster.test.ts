import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../host", () => ({
  captureMotifFrame: vi.fn(async () => ({ width: 480, height: 480 }) as unknown as ImageBitmap),
}));
import { captureMotifFrame } from "../host";
import { rasterMotifFrame } from "../motifRaster";
import { bakeMotifFrame } from "../motifRaster";

describe("rasterMotifFrame", () => {
  beforeEach(() => {
    (captureMotifFrame as unknown as ReturnType<typeof vi.fn>).mockClear();
    delete (globalThis as Record<string, unknown>).window;
  });

  it("delegates to captureMotifFrame with id, tSec, props, dims", async () => {
    const bmp = await rasterMotifFrame("countdown", 2.5, { seconds: 5 }, 480, 480);
    expect(captureMotifFrame).toHaveBeenCalledWith("countdown", 2.5, { seconds: 5 }, 480, 480);
    expect(bmp).toEqual({ width: 480, height: 480 });
  });

  it("bumps window.__weftcutTemplatePerf.renders when present", async () => {
    (globalThis as Record<string, unknown>).window = { __weftcutTemplatePerf: { renders: 0 } };
    await rasterMotifFrame("countdown", 0, {}, 480, 480);
    expect(((globalThis as Record<string, unknown>).window as { __weftcutTemplatePerf: { renders: number } }).__weftcutTemplatePerf.renders).toBe(1);
  });
});

describe("bakeMotifFrame", () => {
  it("captures an arbitrary content frame at the manifest size, no disk read", async () => {
    const template = { manifest: { id: "countdown", size: [480, 480] } } as unknown as Parameters<
      typeof bakeMotifFrame
    >[0];
    // frame 9 at 30fps → tSec = 9 * 1/30 = 0.3
    await bakeMotifFrame(template, 9, 30, 1, { seconds: 5 });
    expect(captureMotifFrame).toHaveBeenCalledWith("countdown", 0.3, { seconds: 5 }, 480, 480);
  });
});
