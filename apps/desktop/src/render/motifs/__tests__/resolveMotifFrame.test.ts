import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../motifRaster", () => ({ rasterMotifFrame: vi.fn(async () => ({ id: "cdp" }) as unknown as ImageBitmap) }));
import { rasterMotifFrame } from "../motifRaster";
import { resolveMotifFrame, sharedBakedKeyIndex } from "../motifRasterCache";

const template = { manifest: { id: "countdown", size: [480, 480], settle_rafs: 2 } } as unknown as Parameters<typeof resolveMotifFrame>[0];

describe("resolveMotifFrame → Motif CDP", () => {
  beforeEach(() => (rasterMotifFrame as unknown as ReturnType<typeof vi.fn>).mockClear());

  it("on a non-baked key, produces the frame via rasterMotifFrame with id, manifest size + settle_rafs", async () => {
    expect(sharedBakedKeyIndex.has("k-not-baked")).toBe(false);
    const bmp = await resolveMotifFrame(template, "k-not-baked", 7, 2.5, 5, { seconds: 5 });
    expect(rasterMotifFrame).toHaveBeenCalledWith("countdown", 2.5, { seconds: 5 }, 480, 480, 2, undefined);
    expect(bmp).toEqual({ id: "cdp" });
  });
});
