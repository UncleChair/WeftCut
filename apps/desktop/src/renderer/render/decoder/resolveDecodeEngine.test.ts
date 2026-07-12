import { describe, expect, it } from "vitest";
import { resolveDecodeEngine, type DecodeResolveInputs } from "./decodeEngine";

function base(over: Partial<DecodeResolveInputs>): DecodeResolveInputs {
  return {
    setting: "auto",
    componentAvailable: true,
    useProxySource: false,
    proxyReady: false,
    proxyUrl: null,
    originalPath: "C:/src/a.mov",
    originalUrl: "weftcut-media://a.mov",
    webcodecsCanDecodeOriginal: "untested",
    ffmpegUsable: true,
    ...over,
  };
}

describe("resolveDecodeEngine — engine selection", () => {
  it("auto with component present → ffmpeg on the original", () => {
    expect(resolveDecodeEngine(base({}))).toMatchObject({
      engine: "ffmpeg", source: "original", status: "ok", target: "C:/src/a.mov",
      key: "ffmpeg:original:C:/src/a.mov",
    });
  });
  it("auto with no component → webcodecs", () => {
    const r = resolveDecodeEngine(base({ componentAvailable: false, webcodecsCanDecodeOriginal: "ok" }));
    expect(r).toMatchObject({ engine: "webcodecs", source: "original", status: "ok", target: "weftcut-media://a.mov" });
  });
  it("setting=ffmpeg pins ffmpeg even without component check on the codec", () => {
    expect(resolveDecodeEngine(base({ setting: "ffmpeg" })).engine).toBe("ffmpeg");
  });
  it("setting=webcodecs pins webcodecs", () => {
    expect(resolveDecodeEngine(base({ setting: "webcodecs", webcodecsCanDecodeOriginal: "ok" })).engine).toBe("webcodecs");
  });
  it("pinned ffmpeg with no component → unsupported (not optimistic ok)", () => {
    const r = resolveDecodeEngine(base({ setting: "ffmpeg", componentAvailable: false }));
    expect(r).toMatchObject({ engine: "ffmpeg", status: "unsupported", target: null, key: null });
  });
});

describe("resolveDecodeEngine — ffmpegUsable (runtime session signal)", () => {
  it("auto + component available but ffmpeg unusable this session → falls back to webcodecs (ok)", () => {
    const r = resolveDecodeEngine(base({ ffmpegUsable: false, webcodecsCanDecodeOriginal: "ok" }));
    expect(r).toMatchObject({ engine: "webcodecs", status: "ok" });
  });
  it("auto + ffmpeg unusable + webcodecs also fails → unsupported", () => {
    const r = resolveDecodeEngine(base({ ffmpegUsable: false, webcodecsCanDecodeOriginal: "fail" }));
    expect(r).toMatchObject({ engine: "webcodecs", status: "unsupported" });
  });
  it("setting=ffmpeg pinned + component available but ffmpeg unusable this session → unsupported", () => {
    const r = resolveDecodeEngine(base({ setting: "ffmpeg", ffmpegUsable: false }));
    expect(r.status).toBe("unsupported");
    expect(r.reason).toMatch(/failed/i);
  });
});

describe("resolveDecodeEngine — webcodecs × original verdict", () => {
  it("fail → unsupported, null target", () => {
    const r = resolveDecodeEngine(base({ setting: "webcodecs", webcodecsCanDecodeOriginal: "fail" }));
    expect(r).toMatchObject({ status: "unsupported", target: null, key: null });
  });
  it("untested → pending", () => {
    const r = resolveDecodeEngine(base({ setting: "webcodecs", webcodecsCanDecodeOriginal: "untested" }));
    expect(r).toMatchObject({ status: "pending", target: null });
  });
  it("auto+no-component+unsupported original → unsupported (NO auto-proxy)", () => {
    const r = resolveDecodeEngine(base({ componentAvailable: false, webcodecsCanDecodeOriginal: "fail", proxyReady: true, proxyUrl: "weftcut-media://p.mp4" }));
    expect(r.status).toBe("unsupported"); // proxy exists but is NOT auto-routed
  });
});

describe("resolveDecodeEngine — source axis", () => {
  it("useProxySource + proxyReady → decodes the proxy on webcodecs (quick proxy is always WebCodecs-decodable)", () => {
    const r = resolveDecodeEngine(base({ useProxySource: true, proxyReady: true, proxyUrl: "weftcut-media://p.mp4" }));
    expect(r).toMatchObject({ engine: "webcodecs", source: "proxy", status: "ok", target: "weftcut-media://p.mp4" });
  });
  it("useProxySource but proxy not built → pending", () => {
    expect(resolveDecodeEngine(base({ useProxySource: true, proxyReady: false })).status).toBe("pending");
  });
  it("proxy source resolves to webcodecs even when setting is ffmpeg", () => {
    expect(resolveDecodeEngine(base({
      setting: "ffmpeg", useProxySource: true, proxyReady: true,
      proxyUrl: "weftcut-media://p.mp4",
    }))).toMatchObject({
      engine: "webcodecs", source: "proxy", status: "ok", target: "weftcut-media://p.mp4",
      key: "webcodecs:proxy:weftcut-media://p.mp4",
    });
  });
  it("proxy source with no component still resolves to webcodecs (rescue path)", () => {
    expect(resolveDecodeEngine(base({
      setting: "ffmpeg", componentAvailable: false, useProxySource: true,
      proxyReady: true, proxyUrl: "weftcut-media://p.mp4",
    }))).toMatchObject({ engine: "webcodecs", source: "proxy", status: "ok" });
  });
  it("proxy requested but not ready → pending on webcodecs", () => {
    expect(resolveDecodeEngine(base({
      useProxySource: true, proxyReady: false, proxyUrl: null,
    }))).toMatchObject({ engine: "webcodecs", source: "proxy", status: "pending", target: null });
  });
});
