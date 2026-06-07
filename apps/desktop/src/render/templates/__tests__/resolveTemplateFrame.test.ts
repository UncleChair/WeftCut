import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../motifs/motifRaster", () => ({ rasterMotifFrame: vi.fn(async () => ({ id: "cdp" }) as unknown as ImageBitmap) }));
vi.mock("../svgRaster", () => ({ rasterizeSvg: vi.fn() }));
vi.mock("../harness", () => ({ TemplateHarness: class { load() { return Promise.resolve(); } } }));
import { rasterMotifFrame } from "../../motifs/motifRaster";
import { resolveTemplateFrame, sharedBakedKeyIndex } from "../templateRaster";

const template = { manifest: { id: "countdown", size: [480, 480] } } as unknown as Parameters<typeof resolveTemplateFrame>[0];

describe("resolveTemplateFrame → Motif CDP", () => {
  beforeEach(() => (rasterMotifFrame as unknown as ReturnType<typeof vi.fn>).mockClear());

  it("on a non-baked key, produces the frame via rasterMotifFrame with id + manifest size", async () => {
    expect(sharedBakedKeyIndex.has("k-not-baked")).toBe(false);
    const bmp = await resolveTemplateFrame(template, "k-not-baked", 7, 2.5, 5, { seconds: 5 });
    expect(rasterMotifFrame).toHaveBeenCalledWith("countdown", 2.5, { seconds: 5 }, 480, 480, undefined);
    expect(bmp).toEqual({ id: "cdp" });
  });
});
