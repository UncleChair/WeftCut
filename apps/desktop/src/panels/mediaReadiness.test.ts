import { describe, expect, it } from "vitest";
import type { MediaSummary } from "../ipc";
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
  proxy_path: null,
  quick_proxy_path: null,
  proxy_bypassed: false,
  ...over,
});

const baseAudio = (over: Partial<MediaSummary> = {}): MediaSummary => ({
  ...baseVideo({ kind: "Audio", width: null, height: null, proxy_path: null }),
  ...over,
});

const emptyImporting = new Set<string>();
const emptyProxyState = new Map<string, ProxyState>();

describe("mediaReadiness", () => {
  it("video is ready when proxy_path is set", () => {
    const r = mediaReadiness(
      baseVideo({ proxy_path: "C:/m/clip.proxy.mp4" }),
      emptyImporting,
      emptyProxyState,
    );
    expect(r).toEqual({ ready: true });
  });

  it("video is ready when proxy state map says ready, even without proxy_path", () => {
    const r = mediaReadiness(
      baseVideo(),
      emptyImporting,
      new Map([["m1", "ready"]]),
    );
    expect(r).toEqual({ ready: true });
  });

  it("video is ready when quick_proxy_path is set", () => {
    const r = mediaReadiness(
      baseVideo({ quick_proxy_path: "C:/m/clip.quick.mp4" }),
      emptyImporting,
      emptyProxyState,
    );
    expect(r).toEqual({ ready: true });
  });

  it("video is ready when proxy is bypassed", () => {
    const r = mediaReadiness(
      baseVideo({ proxy_bypassed: true }),
      emptyImporting,
      emptyProxyState,
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
      baseVideo({ proxy_path: "C:/m/clip.proxy.mp4" }),
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
      baseVideo({ kind: "Image", duration_us: null }),
      emptyImporting,
      emptyProxyState,
    );
    expect(r).toEqual({ ready: true });
  });

  it("subtitle is ready once copy is done", () => {
    const r = mediaReadiness(
      baseVideo({ kind: "Subtitle", duration_us: null }),
      emptyImporting,
      emptyProxyState,
    );
    expect(r).toEqual({ ready: true });
  });
});
