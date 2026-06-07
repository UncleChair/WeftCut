import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../host", () => ({
  captureMotifFrame: vi.fn(async () => ({ width: 480, height: 480 }) as unknown as ImageBitmap),
}));
import { captureMotifFrame } from "../host";
import { rasterMotifFrame } from "../motifRaster";

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
