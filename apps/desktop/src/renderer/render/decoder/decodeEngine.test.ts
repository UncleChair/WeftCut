import { describe, expect, it } from "vitest";
import { resolveEngineTier, type EngineInputs } from "./decodeEngine";

const bypassRoute = { route: "bypass" } as never;
const nativeSwRoute = {
  route: "native-sw", quick_proxy: null, full_proxy: null, format_version: 1,
} as never;

function base(over: Partial<EngineInputs>): EngineInputs {
  return {
    setting: "auto",
    componentAvailable: true,
    media: { path: "C:/src/a.mov", decode_route: bypassRoute },
    webcodecsOriginal: "untested",
    nativeHw: "unavailable",
    nativeSw: "untested",
    proxyPreviewPath: null,
    ...over,
  };
}

describe("resolveEngineTier — auto", () => {
  it("tier 1: native HW wins when its probe passed", () => {
    const r = resolveEngineTier(base({ nativeHw: "ok", webcodecsOriginal: "ok" }));
    expect(r).toMatchObject({ tier: "native-hw", forceStrategy: "native", sourcePath: "C:/src/a.mov", url: null });
    expect(r.key).toBe("native-hw:C:/src/a.mov");
  });
  it("tier 2: WebCodecs decodes the original when HW is out", () => {
    const r = resolveEngineTier(base({ webcodecsOriginal: "ok" }));
    expect(r).toMatchObject({ tier: "webcodecs-original", url: "C:/src/a.mov" });
    expect(r.forceStrategy).toBeUndefined();
  });
  it("tier 3: native SW when 1-2 are out", () => {
    const r = resolveEngineTier(base({ nativeSw: "ok" }));
    expect(r).toMatchObject({ tier: "native-sw", forceStrategy: "software", sourcePath: "C:/src/a.mov" });
  });
  it("tier 4: proxy fallback carries the proxy path (or null while building)", () => {
    expect(resolveEngineTier(base({ proxyPreviewPath: "C:/cache/p.mp4" }))).toMatchObject({
      tier: "proxy", url: "C:/cache/p.mp4", key: "proxy:C:/cache/p.mp4",
    });
    expect(resolveEngineTier(base({}))).toMatchObject({ tier: "proxy", url: null, key: null });
  });
  it("tier 0: component missing skips BOTH native tiers", () => {
    const r = resolveEngineTier(base({ componentAvailable: false, nativeHw: "ok", nativeSw: "ok" }));
    expect(r.tier).toBe("proxy");
    expect(r.reason).toContain("component");
  });
});

describe("resolveEngineTier — forced engines", () => {
  it("native: HW → SW → only then the WebCodecs machinery", () => {
    expect(resolveEngineTier(base({ setting: "native", nativeHw: "ok" })).tier).toBe("native-hw");
    expect(resolveEngineTier(base({ setting: "native", nativeSw: "ok" })).tier).toBe("native-sw");
    // both native lanes out → falls to WebCodecs-original, then proxy
    expect(resolveEngineTier(base({ setting: "native", webcodecsOriginal: "ok" })).tier).toBe("webcodecs-original");
    expect(resolveEngineTier(base({ setting: "native" })).tier).toBe("proxy");
  });
  it("webcodecs: skips tiers 1 and 3 even when they'd pass", () => {
    const r = resolveEngineTier(base({ setting: "webcodecs", nativeHw: "ok", nativeSw: "ok", webcodecsOriginal: "ok" }));
    expect(r.tier).toBe("webcodecs-original");
    expect(resolveEngineTier(base({ setting: "webcodecs", nativeHw: "ok", nativeSw: "ok" })).tier).toBe("proxy");
  });
});

describe("resolveEngineTier — sticky downgrade", () => {
  it("skips a downgraded tier for the rest of the session", () => {
    const r = resolveEngineTier(base({
      nativeHw: "ok", webcodecsOriginal: "ok",
      downgraded: new Set(["native-hw"] as const),
    }));
    expect(r.tier).toBe("webcodecs-original");
    expect(r.reason).toContain("downgraded");
  });
});

describe("resolveEngineTier — native-sw never auto-swaps to a landed proxy", () => {
  it("keeps tier native-sw when a quick proxy exists (feedback_native_nle_conventions)", () => {
    const r = resolveEngineTier(base({
      media: { path: "C:/src/p.mov", decode_route: nativeSwRoute },
      nativeSw: "ok", proxyPreviewPath: "C:/cache/quick.mp4",
    }));
    expect(r.tier).toBe("native-sw");
  });
});
