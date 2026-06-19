import { describe, it, expect } from "vitest";
import { ffprobeColorToWebCodecs } from "./ffprobeColorSpace";

describe("ffprobeColorToWebCodecs", () => {
  it("maps 601 limited", () => {
    expect(ffprobeColorToWebCodecs({ color_matrix: "smpte170m", color_range: "tv" }))
      .toEqual({ matrix: "smpte170m", fullRange: false });
  });
  it("maps 709 full + primaries/transfer", () => {
    expect(ffprobeColorToWebCodecs({
      color_matrix: "bt709", color_range: "pc",
      color_primaries: "bt709", color_transfer: "bt709",
    })).toEqual({ matrix: "bt709", fullRange: true, primaries: "bt709", transfer: "bt709" });
  });
  it("omits unmapped/null fields, returns undefined when nothing maps", () => {
    expect(ffprobeColorToWebCodecs({ color_matrix: null, color_range: null })).toBeUndefined();
    expect(ffprobeColorToWebCodecs({ color_matrix: "fcc" })).toBeUndefined();
  });
  it("does not map HDR/wide-gamut values (SDR-only, out of scope)", () => {
    expect(ffprobeColorToWebCodecs({ color_matrix: "bt2020nc", color_transfer: "smpte2084" }))
      .toBeUndefined();
  });
});
