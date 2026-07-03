// @vitest-environment jsdom
//
// Task 8: the E2E-only `forceStrategy` gate in `SourceDecoderPool.acquire()`.
// `forceStrategy: 'native'` (under `VITE_WEFTCUT_E2E === "1"`) must route to a
// `NativeGpuSourceHandle` instead of the default WebCodecs `SourceHandle`, and
// the gate must be INERT outside the E2E build so it can never affect real
// playback. This suite tests the gate itself, not `NativeGpuSourceHandle`'s
// decode behavior (see NativeGpuSourceHandle.test.ts for that) — `ensureReady`
// is never called here, so `window.api.previewGpu` only needs to exist enough
// that `dispose()` (which unconditionally calls `previewGpu.close`) doesn't
// throw.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceDecoderPool, SourceHandle } from "./SourceDecoderPool";
import { NativeGpuSourceHandle } from "./NativeGpuSourceHandle";

function installFakePreviewGpu(): void {
  (window as unknown as { api: unknown }).api = {
    previewGpu: {
      open: vi.fn().mockResolvedValue(undefined),
      requestFrameAt: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      requestPort: vi.fn(),
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete (window as unknown as { api?: unknown }).api;
});

describe("SourceDecoderPool.acquire forceStrategy gate", () => {
  it("returns a NativeGpuSourceHandle when E2E is on and forceStrategy is 'native'", () => {
    installFakePreviewGpu();
    vi.stubEnv("VITE_WEFTCUT_E2E", "1");
    const pool = new SourceDecoderPool();

    const h = pool.acquire({
      layerId: "layer-native",
      mediaId: "media-native",
      proxyAssetUrl: "weftcut-media://unused",
      forceStrategy: "native",
      sourcePath: "/fake/original.mp4",
    });

    expect(h).toBeInstanceOf(NativeGpuSourceHandle);

    pool.dispose();
  });

  it("returns a SourceHandle when E2E is on but forceStrategy is unset", () => {
    installFakePreviewGpu();
    vi.stubEnv("VITE_WEFTCUT_E2E", "1");
    const pool = new SourceDecoderPool();

    const h = pool.acquire({
      layerId: "layer-default",
      mediaId: "media-default",
      proxyAssetUrl: "weftcut-media://unused",
    });

    expect(h).toBeInstanceOf(SourceHandle);
    expect(h).not.toBeInstanceOf(NativeGpuSourceHandle);

    pool.dispose();
  });

  it("is inert (still returns a SourceHandle) when E2E is off, even with forceStrategy: 'native'", () => {
    installFakePreviewGpu();
    vi.stubEnv("VITE_WEFTCUT_E2E", undefined);
    const pool = new SourceDecoderPool();

    const h = pool.acquire({
      layerId: "layer-inert",
      mediaId: "media-inert",
      proxyAssetUrl: "weftcut-media://unused",
      forceStrategy: "native",
      sourcePath: "/fake/original.mp4",
    });

    expect(h).toBeInstanceOf(SourceHandle);
    expect(h).not.toBeInstanceOf(NativeGpuSourceHandle);

    pool.dispose();
  });

  it("caches the native handle across a repeat acquire for the same layerId", () => {
    installFakePreviewGpu();
    vi.stubEnv("VITE_WEFTCUT_E2E", "1");
    const pool = new SourceDecoderPool();
    const init = {
      layerId: "layer-cache",
      mediaId: "media-cache",
      proxyAssetUrl: "weftcut-media://unused",
      forceStrategy: "native" as const,
      sourcePath: "/fake/original.mp4",
    };

    const first = pool.acquire(init);
    const second = pool.acquire(init);

    expect(second).toBe(first);

    pool.dispose();
  });
});
