import { describe, expect, it, vi } from "vitest";
import { rasterizeSvgVia } from "./svgRaster";
import type { RasterPool } from "./rasterPool";

function makeBmp(tag: string): ImageBitmap {
  return { tag, close() {} } as unknown as ImageBitmap;
}

describe("rasterizeSvgVia", () => {
  it("uses the pool when it resolves", async () => {
    const poolBmp = makeBmp("pool");
    const pool = { rasterize: vi.fn(async () => poolBmp) } as unknown as RasterPool;
    const inline = vi.fn(async () => makeBmp("inline"));
    const out = await rasterizeSvgVia(pool, inline, "<svg/>");
    expect(out).toBe(poolBmp);
    expect(inline).not.toHaveBeenCalled();
  });

  it("falls back to inline when the pool rejects", async () => {
    const inlineBmp = makeBmp("inline");
    const pool = {
      rasterize: vi.fn(async () => {
        throw new Error("pool down");
      }),
    } as unknown as RasterPool;
    const inline = vi.fn(async () => inlineBmp);
    const out = await rasterizeSvgVia(pool, inline, "<svg/>");
    expect(out).toBe(inlineBmp);
    expect(inline).toHaveBeenCalledWith("<svg/>");
  });

  it("uses inline when there is no pool", async () => {
    const inlineBmp = makeBmp("inline");
    const inline = vi.fn(async () => inlineBmp);
    const out = await rasterizeSvgVia(null, inline, "<svg/>");
    expect(out).toBe(inlineBmp);
  });
});
