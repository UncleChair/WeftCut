import { describe, expect, it } from "vitest";
import type { MediaSummary } from "../ipc";
import type { DecodeRoute } from "../render/decodeRoute";
import { mediaReadiness, type ProxyState } from "./mediaReadiness";

const baseVideo = (over: Partial<MediaSummary> = {}): MediaSummary => ({
  id: "m1",
  label: "clip.mp4",
  path: "C:/m/clip.mp4",
  kind: "Video",
  duration_us: 5_000_000,
  width: 1920,
  height: 1080,
  size_bytes: 10_000_000,
  available: true,
  decode_route: { route: "proxied", quick_proxy: null, full_proxy: null, format_version: 0 },
  codec: "h264",
  pix_fmt: "yuv420p",
  ...over,
});

// Route helpers, named for the preview readiness they encode.
const proxied = (over: Partial<{ quick_proxy: string | null; full_proxy: string | null }> = {}): DecodeRoute => ({
  route: "proxied", quick_proxy: over.quick_proxy ?? null, full_proxy: over.full_proxy ?? null, format_version: 1,
});
const bypass: DecodeRoute = { route: "bypass" };

const baseAudio = (over: Partial<MediaSummary> = {}): MediaSummary => ({
  ...baseVideo({ kind: "Audio", width: null, height: null, decode_route: bypass }),
  ...over,
});

const emptyImporting = new Set<string>();
const emptyProxyState = new Map<string, ProxyState>();

describe("mediaReadiness", () => {
  it("video is ready when the quick proxy on the route is set", () => {
    const r = mediaReadiness(
      baseVideo({ decode_route: proxied({ quick_proxy: "C:/m/clip.quick.mp4", full_proxy: "C:/m/clip.proxy.mp4" }) }),
      emptyImporting,
      emptyProxyState,
    );
    expect(r).toEqual({ ready: true });
  });

  it("video waits when only the full export master is on disk (preview needs the quick proxy)", () => {
    // resolveDecode previews from the quick proxy, never the heavy full master,
    // so a Proxied source with only a full proxy is not preview-ready yet.
    const r = mediaReadiness(
      baseVideo({ decode_route: proxied({ full_proxy: "C:/m/clip.proxy.mp4" }) }),
      emptyImporting,
      emptyProxyState,
    );
    expect(r).toEqual({ ready: false, reason: "proxy_pending" });
  });

  it("video is ready when proxy state map says ready, even without a route path", () => {
    const r = mediaReadiness(
      baseVideo(),
      emptyImporting,
      new Map([["m1", "ready"]]),
    );
    expect(r).toEqual({ ready: true });
  });

  it("video is ready when the route's quick proxy is set", () => {
    const r = mediaReadiness(
      baseVideo({ decode_route: proxied({ quick_proxy: "C:/m/clip.quick.mp4" }) }),
      emptyImporting,
      emptyProxyState,
    );
    expect(r).toEqual({ ready: true });
  });

  it("video is ready when the route is bypass (original decodes directly)", () => {
    const r = mediaReadiness(
      baseVideo({ decode_route: bypass }),
      emptyImporting,
      emptyProxyState,
    );
    expect(r).toEqual({ ready: true });
  });

  it("video waits when a DirectExport route has no quick proxy yet", () => {
    const r = mediaReadiness(
      baseVideo({ decode_route: { route: "direct-export", quick_proxy: null } }),
      emptyImporting,
      emptyProxyState,
    );
    expect(r).toEqual({ ready: false, reason: "proxy_pending" });
  });

  it("video is ready when the preview bridge probe succeeded", () => {
    const r = mediaReadiness(
      baseVideo({ decode_route: { route: "direct-export", quick_proxy: null } }),
      emptyImporting,
      emptyProxyState,
      { previewDecodable: true },
    );
    expect(r).toEqual({ ready: true });
  });

  it("video falls back to proxy_pending when no path and no map entry", () => {
    const r = mediaReadiness(baseVideo(), emptyImporting, emptyProxyState);
    expect(r).toEqual({ ready: false, reason: "proxy_pending" });
  });

  it("video is proxy_pending when explicitly pending in map", () => {
    const r = mediaReadiness(
      baseVideo(),
      emptyImporting,
      new Map([["m1", "pending"]]),
    );
    expect(r).toEqual({ ready: false, reason: "proxy_pending" });
  });

  it("video is proxy_failed when map says failed", () => {
    const r = mediaReadiness(
      baseVideo(),
      emptyImporting,
      new Map([["m1", "failed"]]),
    );
    expect(r).toEqual({ ready: false, reason: "proxy_failed" });
  });

  it("importing takes precedence over proxy state", () => {
    const r = mediaReadiness(
      baseVideo({ decode_route: proxied({ quick_proxy: "C:/m/clip.quick.mp4" }) }),
      new Set(["m1"]),
      new Map([["m1", "ready"]]),
    );
    expect(r).toEqual({ ready: false, reason: "importing" });
  });

  it("missing takes precedence over proxy state but not importing", () => {
    const r = mediaReadiness(
      baseVideo({ available: false }),
      emptyImporting,
      new Map([["m1", "ready"]]),
    );
    expect(r).toEqual({ ready: false, reason: "missing" });
  });

  it("importing beats missing", () => {
    const r = mediaReadiness(
      baseVideo({ available: false }),
      new Set(["m1"]),
      emptyProxyState,
    );
    expect(r).toEqual({ ready: false, reason: "importing" });
  });

  it("audio is ready once copy is done (no proxy needed)", () => {
    const r = mediaReadiness(baseAudio(), emptyImporting, emptyProxyState);
    expect(r).toEqual({ ready: true });
  });

  it("audio respects importing", () => {
    const r = mediaReadiness(
      baseAudio(),
      new Set(["m1"]),
      emptyProxyState,
    );
    expect(r).toEqual({ ready: false, reason: "importing" });
  });

  it("image is ready once copy is done", () => {
    const r = mediaReadiness(
      baseVideo({ kind: "Image", duration_us: null, decode_route: bypass }),
      emptyImporting,
      emptyProxyState,
    );
    expect(r).toEqual({ ready: true });
  });

  it("subtitle is ready once copy is done", () => {
    const r = mediaReadiness(
      baseVideo({ kind: "Subtitle", duration_us: null, decode_route: bypass }),
      emptyImporting,
      emptyProxyState,
    );
    expect(r).toEqual({ ready: true });
  });
});
