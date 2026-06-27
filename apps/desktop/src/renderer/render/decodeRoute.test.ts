import { describe, expect, it } from "vitest";
import golden from "./decodeRouteWireGolden.fixture.json";
import type { DecodeRoute } from "./decodeRoute";

describe("DecodeRoute wire shape", () => {
  it("matches the cross-language golden tags", () => {
    expect(golden.tags).toEqual(["bypass", "direct-export", "proxied"]);
  });
  it("type literals construct each sample", () => {
    const bypass: DecodeRoute = { route: "bypass" };
    const de: DecodeRoute = { route: "direct-export", quick_proxy: null };
    const px: DecodeRoute = {
      route: "proxied", quick_proxy: null, full_proxy: null, format_version: 0,
    };
    expect(bypass).toEqual(golden.samples.bypass);
    expect(de).toEqual(golden.samples["direct-export"]);
    expect(px).toEqual(golden.samples.proxied);
  });
});
