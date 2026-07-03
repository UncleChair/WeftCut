// @vitest-environment jsdom
//
// Mocks `window.api.previewGpu` (Tasks 6/6b's transport) end to end: `open`/
// `requestFrameAt`/`close` are vi.fn()s, and `requestPort()` synthesizes the
// preload's one-time port handoff (`window.postMessage({__weftcutPreviewGpu:
// 'port'}, ..., [port])`) as a real jsdom `MessageEvent` carrying a minimal
// fake `MessagePort` (`{onmessage, postMessage, close}` — jsdom's own
// MessagePort isn't exercised; only `NativeGpuSourceHandle`'s handling of the
// message shape is under test, per the task brief's mock-seam guidance).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WeftcutApi } from "../../../shared/ipc";
import { NativeGpuSourceHandle } from "./NativeGpuSourceHandle";

interface FakePort {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage: (msg: unknown) => void;
  close: () => void;
}

interface FakeBitmap extends ImageBitmap {
  tag: number;
}

function makeFakeBitmap(tag: number): FakeBitmap {
  return { width: 1920, height: 1080, close: vi.fn(), tag } as unknown as FakeBitmap;
}

/// Builds a mocked `window.api.previewGpu` plus a hook to read the fake port
/// `requestPort()` synthesized. `requestPort()` dispatches the port-handoff
/// message SYNCHRONOUSLY (mirroring the preload's real handoff being posted
/// before `open()` is even awaited) so tests don't need fake timers.
function mockPreviewGpu() {
  const open = vi.fn().mockResolvedValue({ width: 1920, height: 1080, poolSize: 3 });
  const requestFrameAt = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  let port: FakePort | null = null;
  const requestPort = vi.fn(() => {
    port = { onmessage: null, postMessage: vi.fn(), close: vi.fn() };
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { __weftcutPreviewGpu: "port" },
        ports: [port as unknown as MessagePort],
      }),
    );
  });
  return {
    previewGpu: { open, requestFrameAt, close, requestPort },
    getPort: () => port,
  };
}

function installApi(previewGpu: ReturnType<typeof mockPreviewGpu>["previewGpu"]): void {
  (window as unknown as { api: WeftcutApi }).api = { previewGpu } as unknown as WeftcutApi;
}

beforeEach(() => {
  delete (window as unknown as { api?: unknown }).api;
});

describe("NativeGpuSourceHandle.ensureReady", () => {
  it("opens a session once with poolSize >= 2 and a colorSpace object carrying a matrix", async () => {
    const mock = mockPreviewGpu();
    installApi(mock.previewGpu);
    const h = new NativeGpuSourceHandle("layer-1", "media-1", "/fake/a.mp4", {
      matrix: "smpte170m",
      fullRange: true,
    });

    await h.ensureReady();

    expect(mock.previewGpu.requestPort).toHaveBeenCalledOnce();
    expect(mock.previewGpu.open).toHaveBeenCalledOnce();
    const arg = mock.previewGpu.open.mock.calls[0]![0] as {
      streamId: string;
      path: string;
      poolSize: number;
      colorSpace: { primaries: string; transfer: string; matrix: string; range: string };
    };
    expect(arg.poolSize).toBeGreaterThanOrEqual(2);
    expect(arg.path).toBe("/fake/a.mp4");
    expect(arg.colorSpace.matrix).toBe("smpte170m");
    expect(arg.colorSpace.range).toBe("full");

    h.dispose();
  });

  it("defaults untagged sources to bt709/limited", async () => {
    const mock = mockPreviewGpu();
    installApi(mock.previewGpu);
    const h = new NativeGpuSourceHandle("layer-1b", "media-1b", "/fake/b.mp4");

    await h.ensureReady();

    const arg = mock.previewGpu.open.mock.calls[0]![0] as {
      colorSpace: { primaries: string; transfer: string; matrix: string; range: string };
    };
    expect(arg.colorSpace).toEqual({
      primaries: "bt709",
      transfer: "bt709",
      matrix: "bt709",
      range: "limited",
    });

    h.dispose();
  });

  it("is idempotent across concurrent callers (one open call)", async () => {
    const mock = mockPreviewGpu();
    installApi(mock.previewGpu);
    const h = new NativeGpuSourceHandle("layer-1c", "media-1c", "/fake/c.mp4");

    await Promise.all([h.ensureReady(), h.ensureReady(), h.ensureReady()]);

    expect(mock.previewGpu.open).toHaveBeenCalledOnce();
    expect(mock.previewGpu.requestPort).toHaveBeenCalledOnce();

    h.dispose();
  });
});

describe("NativeGpuSourceHandle port frame handling", () => {
  it("pushes a delivered frame message into the ring, keyed to this handle's streamId", async () => {
    const mock = mockPreviewGpu();
    installApi(mock.previewGpu);
    const h = new NativeGpuSourceHandle("layer-2", "media-2", "/fake/d.mp4");
    await h.ensureReady();
    const port = mock.getPort();
    expect(port).not.toBeNull();

    const bitmap = makeFakeBitmap(1);
    port!.onmessage!({
      data: { kind: "frame", streamId: h.streamId, slot: 0, ptsUs: 42_000, durUs: 16_667, bitmap },
    });

    expect(h.ring.pushCount).toBe(1);
    expect(h.ring.lastPtsUs()).toBe(42_000);

    h.dispose();
  });

  it("fires onFirstFrame exactly once, on the first pushed frame", async () => {
    const mock = mockPreviewGpu();
    installApi(mock.previewGpu);
    const h = new NativeGpuSourceHandle("layer-2b", "media-2b", "/fake/e.mp4");
    await h.ensureReady();
    const port = mock.getPort()!;

    const cb = vi.fn();
    h.onFirstFrame(cb);
    port.onmessage!({
      data: { kind: "frame", streamId: h.streamId, slot: 0, ptsUs: 0, durUs: 16_667, bitmap: makeFakeBitmap(1) },
    });
    port.onmessage!({
      data: { kind: "frame", streamId: h.streamId, slot: 1, ptsUs: 16_667, durUs: 16_667, bitmap: makeFakeBitmap(2) },
    });

    expect(cb).toHaveBeenCalledOnce();

    // Late subscriber after the first frame already landed fires synchronously.
    const late = vi.fn();
    h.onFirstFrame(late);
    expect(late).toHaveBeenCalledOnce();

    h.dispose();
  });

  it("ignores a frame message for a different streamId", async () => {
    const mock = mockPreviewGpu();
    installApi(mock.previewGpu);
    const h = new NativeGpuSourceHandle("layer-3", "media-3", "/fake/f.mp4");
    await h.ensureReady();
    const port = mock.getPort()!;

    port.onmessage!({
      data: {
        kind: "frame",
        streamId: "some-other-stream",
        slot: 0,
        ptsUs: 1,
        durUs: 1,
        bitmap: makeFakeBitmap(9),
      },
    });

    expect(h.ring.pushCount).toBe(0);

    h.dispose();
  });

  it("drops a late frame delivered after dispose (closes the bitmap, does not push)", async () => {
    const mock = mockPreviewGpu();
    installApi(mock.previewGpu);
    const h = new NativeGpuSourceHandle("layer-3b", "media-3b", "/fake/g.mp4");
    await h.ensureReady();
    const port = mock.getPort()!;
    const streamId = h.streamId;
    // Capture the live handler BEFORE dispose — dispose() nulls
    // `port.onmessage` as part of teardown, so this models a message that
    // was already in flight (e.g. queued by the real transport) landing
    // just after teardown, not a message arriving through the (now-null)
    // port slot itself.
    const handler = port.onmessage!;

    h.dispose();
    const bitmap = makeFakeBitmap(1);
    handler({ data: { kind: "frame", streamId, slot: 0, ptsUs: 0, durUs: 1, bitmap } });

    expect(h.ring.pushCount).toBe(0);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it("logs a warning on an error message without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mock = mockPreviewGpu();
    installApi(mock.previewGpu);
    const h = new NativeGpuSourceHandle("layer-3c", "media-3c", "/fake/h.mp4");
    await h.ensureReady();
    const port = mock.getPort()!;

    expect(() =>
      port.onmessage!({ data: { kind: "error", streamId: h.streamId, message: "boom" } }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalled();

    h.dispose();
    warn.mockRestore();
  });
});

describe("NativeGpuSourceHandle.requestFrameAt coalescing", () => {
  it("issues at most one in-flight previewGpu.requestFrameAt call, sending the latest target on settle", async () => {
    const mock = mockPreviewGpu();
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    mock.previewGpu.requestFrameAt.mockImplementationOnce(() => firstGate);
    installApi(mock.previewGpu);
    const h = new NativeGpuSourceHandle("layer-4", "media-4", "/fake/i.mp4");
    await h.ensureReady();

    const p1 = h.requestFrameAt(1_000);
    const p2 = h.requestFrameAt(2_000);
    const p3 = h.requestFrameAt(3_000);
    const p4 = h.requestFrameAt(4_000);
    const p5 = h.requestFrameAt(5_000);

    // Five rapid calls, but only the first should have gone out synchronously
    // — the rest coalesce behind the in-flight call.
    expect(mock.previewGpu.requestFrameAt).toHaveBeenCalledTimes(1);
    expect(mock.previewGpu.requestFrameAt).toHaveBeenCalledWith({
      streamId: h.streamId,
      targetUs: 1_000,
    });

    resolveFirst();
    await Promise.all([p1, p2, p3, p4, p5]);

    // Settling fires exactly one more call, for the latest coalesced target.
    expect(mock.previewGpu.requestFrameAt).toHaveBeenCalledTimes(2);
    expect(mock.previewGpu.requestFrameAt).toHaveBeenLastCalledWith({
      streamId: h.streamId,
      targetUs: 5_000,
    });

    h.dispose();
  });

  it("stops issuing requestFrameAt after dispose", async () => {
    const mock = mockPreviewGpu();
    installApi(mock.previewGpu);
    const h = new NativeGpuSourceHandle("layer-4b", "media-4b", "/fake/j.mp4");
    await h.ensureReady();
    h.dispose();

    await h.requestFrameAt(1_000);

    expect(mock.previewGpu.requestFrameAt).not.toHaveBeenCalled();
  });
});

describe("NativeGpuSourceHandle.dispose", () => {
  it("closes the native session and disposes the ring", async () => {
    const mock = mockPreviewGpu();
    installApi(mock.previewGpu);
    const h = new NativeGpuSourceHandle("layer-5", "media-5", "/fake/k.mp4");
    await h.ensureReady();
    const streamId = h.streamId;

    h.dispose();

    expect(h.disposed).toBe(true);
    expect(mock.previewGpu.close).toHaveBeenCalledWith({ streamId });
  });

  it("is safe when ensureReady never completed (port handoff never arrives)", () => {
    const open = vi.fn().mockResolvedValue({ width: 0, height: 0, poolSize: 0 });
    const requestFrameAt = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    // requestPort() that never synthesizes the handoff message.
    const requestPort = vi.fn();
    installApi({ open, requestFrameAt, close, requestPort });
    const h = new NativeGpuSourceHandle("layer-5b", "media-5b", "/fake/l.mp4");

    void h.ensureReady().catch(() => undefined);
    expect(() => h.dispose()).not.toThrow();
    expect(h.disposed).toBe(true);
  });

  it("is idempotent (second dispose is a no-op)", async () => {
    const mock = mockPreviewGpu();
    installApi(mock.previewGpu);
    const h = new NativeGpuSourceHandle("layer-5c", "media-5c", "/fake/m.mp4");
    await h.ensureReady();

    h.dispose();
    h.dispose();

    expect(mock.previewGpu.close).toHaveBeenCalledOnce();
  });
});

describe("NativeGpuSourceHandle.isLookaheadFull", () => {
  it("delegates to the ring", async () => {
    const mock = mockPreviewGpu();
    installApi(mock.previewGpu);
    const h = new NativeGpuSourceHandle("layer-6", "media-6", "/fake/n.mp4");
    await h.ensureReady();

    expect(h.isLookaheadFull?.()).toBe(false);

    h.dispose();
  });
});
