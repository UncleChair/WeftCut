import { describe, expect, it } from "vitest";
import golden from "./decodeRouteWireGolden.fixture.json";
import type { DecodeRoute } from "./decodeRoute";
import { resolveDecode, previewPathLive } from "./decodeRoute";

const M = (kind: string, decode_route: DecodeRoute, path = "orig.mp4") =>
  ({ kind, path, decode_route } as const);

describe("resolveDecode — full route × readiness matrix", () => {
  it.each([
    ["bypass", M("Video", { route: "bypass" }), "orig.mp4", "orig.mp4"],
    ["direct-export, quick pending", M("Video", { route: "direct-export", quick_proxy: null }), null, "orig.mp4"],
    ["direct-export, quick ready", M("Video", { route: "direct-export", quick_proxy: "q.mp4" }), "q.mp4", "orig.mp4"],
    ["proxied, nothing ready", M("Video", { route: "proxied", quick_proxy: null, full_proxy: null, format_version: 0 }), null, null],
    ["proxied, quick ready", M("Video", { route: "proxied", quick_proxy: "q.mp4", full_proxy: null, format_version: 0 }), "q.mp4", null],
    ["proxied, both ready", M("Video", { route: "proxied", quick_proxy: "q.mp4", full_proxy: "f.mp4", format_version: 3 }), "q.mp4", "f.mp4"],
    // Quick proxy gone but full master present (e.g. an older import whose quick
    // was cleaned up): preview must fall back to the full proxy, not go blank.
    ["proxied, quick gone, full ready", M("Video", { route: "proxied", quick_proxy: null, full_proxy: "f.mp4", format_version: 3 }), "f.mp4", "f.mp4"],
    ["image is bypass-like", M("Image", { route: "bypass" }), "orig.mp4", "orig.mp4"],
  ])("%s", (_name, media, previewPath, exportPath) => {
    const r = resolveDecode(media);
    expect(r.previewPath).toBe(previewPath);
    expect(r.exportPath).toBe(exportPath);
  });
});

describe("previewPathLive — session bridge overlay", () => {
  const pending = M("Video", { route: "direct-export", quick_proxy: null });
  it("returns the resolved preview path when ready", () => {
    expect(previewPathLive(M("Video", { route: "direct-export", quick_proxy: "q.mp4" }))).toBe("q.mp4");
  });
  it("bridges to the original when this machine decoded it", () => {
    expect(previewPathLive(pending, { previewDecodable: true })).toBe("orig.mp4");
  });
  it("stays null when not ready and not bridged", () => {
    expect(previewPathLive(pending)).toBeNull();
  });
});

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
