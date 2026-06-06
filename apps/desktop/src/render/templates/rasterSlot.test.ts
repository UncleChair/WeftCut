import { describe, expect, it } from "vitest";
import { getRasterPool, RASTER_FRAME } from "./rasterSlot";

describe("getRasterPool", () => {
  it("returns a stable singleton (same instance / both null)", () => {
    // Real iframe rasterization is verified in WebView2; here we only assert the
    // accessor is a stable singleton. With a DOM it is a RasterPool; without one
    // (node) it is null. Either way the accessor is idempotent.
    expect(getRasterPool()).toBe(getRasterPool());
  });

  it("RASTER_FRAME has no backtick or interpolation (bundle hazard)", () => {
    expect(RASTER_FRAME.includes("`")).toBe(false);
    expect(RASTER_FRAME.includes("${")).toBe(false);
  });
});
