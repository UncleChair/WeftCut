// @vitest-environment jsdom
//
// Task 8 + Task 17: `forceStrategy` routing in `SourceDecoderPool.acquire()`.
// `forceStrategy: 'native'` routes to a `NativeGpuSourceHandle` and 'software'
// to a `SwSourceHandle`, instead of the default WebCodecs `SourceHandle`.
// Task 17 REMOVED the old `VITE_WEFTCUT_E2E === "1"` gate on the 'native'
// branch: native is now production-legal (chosen by `resolveEngineTier` tier 1
// behind a passed HW probe), so the flag no longer changes routing. This suite
// tests the routing itself, not `NativeGpuSourceHandle`'s decode behavior (see
// NativeGpuSourceHandle.test.ts) — `ensureReady` is never called here, so
// `window.api.previewGpu` only needs to exist enough that `dispose()` (which
// unconditionally calls `previewGpu.close`) doesn't throw.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceDecoderPool, SourceHandle } from "./SourceDecoderPool";
import { NativeGpuSourceHandle } from "./NativeGpuSourceHandle";
import { SwSourceHandle } from "./SwSourceHandle";

function installFakePreviewGpu(): void {
  (window as unknown as { api: unknown }).api = {
    previewGpu: {
      open: vi.fn().mockResolvedValue(undefined),
      requestFrameAt: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      requestPort: vi.fn(),
    },
    previewSw: {
      open: vi.fn().mockResolvedValue(undefined),
      requestFrameAt: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      onFrame: vi.fn(() => vi.fn()),
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete (window as unknown as { api?: unknown }).api;
});

describe("SourceDecoderPool.acquire forceStrategy routing", () => {
  it("returns a NativeGpuSourceHandle when forceStrategy is 'native'", () => {
    installFakePreviewGpu();
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

  it("returns a SourceHandle when forceStrategy is unset", () => {
    installFakePreviewGpu();
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

  it("routes forceStrategy 'native' to NativeGpuSourceHandle even with E2E off (Task 17: gate removed, native is production-legal)", () => {
    installFakePreviewGpu();
    vi.stubEnv("VITE_WEFTCUT_E2E", undefined);
    const pool = new SourceDecoderPool();

    const h = pool.acquire({
      layerId: "layer-ungated",
      mediaId: "media-ungated",
      proxyAssetUrl: "weftcut-media://unused",
      forceStrategy: "native",
      sourcePath: "/fake/original.mp4",
    });

    expect(h).toBeInstanceOf(NativeGpuSourceHandle);
    expect(h).not.toBeInstanceOf(SourceHandle);

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

  it("returns a SwSourceHandle when forceStrategy is 'software' (NOT E2E-gated)", () => {
    installFakePreviewGpu();
    vi.stubEnv("VITE_WEFTCUT_E2E", undefined);
    const pool = new SourceDecoderPool();

    const h = pool.acquire({
      layerId: "L1",
      mediaId: "M1",
      proxyAssetUrl: "x",
      forceStrategy: "software",
      sourcePath: "C:/clip.mov",
    });

    expect(h).toBeInstanceOf(SwSourceHandle);

    pool.dispose();
  });

  it("caches the software handle across a repeat acquire for the same layerId", () => {
    installFakePreviewGpu();
    vi.stubEnv("VITE_WEFTCUT_E2E", undefined);
    const pool = new SourceDecoderPool();
    const init = {
      layerId: "layer-sw-cache",
      mediaId: "media-sw-cache",
      proxyAssetUrl: "weftcut-media://unused",
      forceStrategy: "software" as const,
      sourcePath: "/fake/original.mov",
    };

    const first = pool.acquire(init);
    const second = pool.acquire(init);

    expect(second).toBe(first);

    pool.dispose();
  });
});

// Task 6 (collapsed decode-engine model): `acquire` branches on the NEW
// `engine` field ON TOP of the legacy `forceStrategy` branches above (which
// stay wired until Task 9 — the Compositor still sets `forceStrategy`).
describe("SourceDecoderPool.acquire engine routing", () => {
  it("acquire(engine:'ffmpeg') builds an FfmpegSource decoding sourcePath", () => {
    const pool = new SourceDecoderPool();
    const h = pool.acquire({
      layerId: "L",
      mediaId: "m",
      proxyAssetUrl: "",
      engine: "ffmpeg",
      sourcePath: "C:/x.mp4",
      codec: "h264",
      pixFmt: "yuv420p",
      componentAvailable: true,
    } as never);

    expect(h.constructor.name).toBe("FfmpegSource");

    pool.dispose();
  });

  it("acquire(engine:'webcodecs') builds the WebCodecs SourceHandle via SourceMedia", () => {
    const pool = new SourceDecoderPool();
    const h = pool.acquire({
      layerId: "L2",
      mediaId: "m2",
      proxyAssetUrl: "weftcut-media://p.mp4",
      engine: "webcodecs",
    } as never);

    expect(h.constructor.name).toBe("SourceHandle");

    pool.dispose();
  });
});
