// @vitest-environment jsdom
//
// Mocks `window.api.previewSw` (Task 5's transport) end to end. Unlike the
// GPU path (`NativeGpuSourceHandle.test.ts`), there's no MessagePort handoff
// to synthesize — `onFrame` is a plain subscribe/unsubscribe pair and frames
// arrive as `PreviewSwFrameMsg` values straight from the mock. jsdom has
// neither `VideoFrame` nor `createImageBitmap`, so both are stubbed on
// `globalThis`; `handleFrame` is async (it awaits the stubbed
// `createImageBitmap`), so every test that emits a frame must flush
// microtasks before asserting on the ring.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewSwFrameMsg, WeftcutApi } from "../../../shared/ipc";
import { SwSourceHandle } from "./SwSourceHandle";

class FakeVideoFrame {
  close = vi.fn();
  constructor(
    public data: unknown,
    public init: unknown,
  ) {
    lastVf = this;
  }
}

/// The most recently constructed `FakeVideoFrame`, captured so tests can
/// assert on the `init` (e.g. `colorSpace`) `handleFrame` passed to `new
/// VideoFrame` — mirrors `lastBmp` below for the bitmap side.
let lastVf: FakeVideoFrame | null = null;

/// The most recently manufactured stub bitmap, captured so tests can assert
/// on its `close()` — `createImageBitmap` otherwise returns an opaque
/// promise with no test-visible handle to the resolved value.
let lastBmp: { width: number; height: number; close: ReturnType<typeof vi.fn> } | null = null;

function installFakeCodecGlobals(): void {
  (globalThis as unknown as { VideoFrame: unknown }).VideoFrame = FakeVideoFrame;
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = vi.fn(async () => {
    lastBmp = { width: 4, height: 4, close: vi.fn() };
    return lastBmp as unknown as ImageBitmap;
  });
}

/// Flush pending microtasks (and the current macrotask queue) so an awaited
/// `handleFrame` — `new VideoFrame` (sync) -> `await createImageBitmap` ->
/// `ring.push` — has settled before assertions run.
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeFrameMsg(streamId: string, overrides: Partial<PreviewSwFrameMsg> = {}): PreviewSwFrameMsg {
  return {
    streamId,
    ptsUs: 33_367,
    durUs: 33_367,
    width: 4,
    height: 4,
    format: "NV12",
    data: new Uint8Array(4 * 4 + (4 * 4) / 2),
    ...overrides,
  };
}

/// Builds a mocked `window.api.previewSw`. `onFrame` captures the callback
/// so tests can push frames via the returned `emit`; `emit` calls the
/// captured callback directly (not gated on whether `unsub` was called) —
/// this mirrors the GPU test's "capture the handler before dispose" pattern
/// for the late-frame-after-dispose case, and keeps the mock simple: the
/// handle's OWN disposed-guard is what's under test, not the transport's.
function mockPreviewSw() {
  const open = vi.fn().mockResolvedValue({ width: 4, height: 4 });
  const requestFrameAt = vi.fn();
  const close = vi.fn();
  const unsub = vi.fn();
  let capturedCb: ((f: PreviewSwFrameMsg) => void) | null = null;
  const onFrame = vi.fn((cb: (f: PreviewSwFrameMsg) => void) => {
    capturedCb = cb;
    return unsub;
  });
  return {
    previewSw: { open, requestFrameAt, close, onFrame },
    unsub,
    emit: (f: PreviewSwFrameMsg) => capturedCb?.(f),
  };
}

function installApi(previewSw: ReturnType<typeof mockPreviewSw>["previewSw"]): void {
  (window as unknown as { api: WeftcutApi }).api = { previewSw } as unknown as WeftcutApi;
}

beforeEach(() => {
  delete (window as unknown as { api?: unknown }).api;
  lastBmp = null;
  lastVf = null;
  installFakeCodecGlobals();
});

describe("SwSourceHandle.ensureReady", () => {
  it("opens a session once and subscribes to onFrame", async () => {
    const mock = mockPreviewSw();
    installApi(mock.previewSw);
    const h = new SwSourceHandle("layer-1", "media-1", "C:/fake/a.mov");

    await h.ensureReady();

    expect(mock.previewSw.onFrame).toHaveBeenCalledOnce();
    expect(mock.previewSw.open).toHaveBeenCalledOnce();
    expect(mock.previewSw.open).toHaveBeenCalledWith({ streamId: h.streamId, path: "C:/fake/a.mov" });

    h.dispose();
  });

  it("is idempotent across concurrent callers (one open call)", async () => {
    const mock = mockPreviewSw();
    installApi(mock.previewSw);
    const h = new SwSourceHandle("layer-1b", "media-1b", "C:/fake/b.mov");

    await Promise.all([h.ensureReady(), h.ensureReady(), h.ensureReady()]);

    expect(mock.previewSw.open).toHaveBeenCalledOnce();
    expect(mock.previewSw.onFrame).toHaveBeenCalledOnce();

    h.dispose();
  });
});

describe("SwSourceHandle frame handling", () => {
  it("converts an NV12 frame message to a ring bitmap", async () => {
    const mock = mockPreviewSw();
    installApi(mock.previewSw);
    const h = new SwSourceHandle("L1", "M1", "C:/clip.mov");
    await h.ensureReady();

    mock.emit(makeFrameMsg(h.streamId, { ptsUs: 33_367, durUs: 33_367 }));
    await flushMicrotasks();

    expect(h.ring.pushCount).toBe(1);
    expect(h.ring.lastPtsUs()).toBe(33_367);

    h.dispose();
  });

  it("derives colorSpace from the mapped sourceColor, not raw per-frame tags", async () => {
    const mock = mockPreviewSw();
    installApi(mock.previewSw);
    const h = new SwSourceHandle("L-color", "M-color", "C:/clip.mov", {
      primaries: "bt709",
      transfer: "bt709",
      matrix: "smpte170m",
      fullRange: true,
    });
    await h.ensureReady();

    // The frame carries an exotic raw-ffmpeg tag (`bt2020nc` is not a valid
    // WebCodecs `VideoMatrixCoefficients`) — it must NOT leak into
    // `new VideoFrame`'s colorSpace; only the mapped `sourceColor` should.
    mock.emit(
      makeFrameMsg(h.streamId, {
        colorMatrix: "bt2020nc",
        colorPrimaries: "bt2020",
        colorTransfer: "smpte2084",
        colorRange: "pc",
      }),
    );
    await flushMicrotasks();

    expect(h.ring.pushCount).toBe(1);
    const vf = lastVf;
    expect(vf?.init).toMatchObject({
      colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "smpte170m", fullRange: true },
    });

    h.dispose();
  });

  it("falls back to bt709/limited when the handle has no sourceColor, ignoring frame tags", async () => {
    const mock = mockPreviewSw();
    installApi(mock.previewSw);
    const h = new SwSourceHandle("L-color-2", "M-color-2", "C:/clip2.mov");
    await h.ensureReady();

    mock.emit(makeFrameMsg(h.streamId, { colorMatrix: "bt2020nc", colorRange: "pc" }));
    await flushMicrotasks();

    const vf = lastVf;
    expect(vf?.init).toMatchObject({
      colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
    });

    h.dispose();
  });

  it("ignores a frame message for a different streamId", async () => {
    const mock = mockPreviewSw();
    installApi(mock.previewSw);
    const h = new SwSourceHandle("layer-2", "media-2", "C:/fake/c.mov");
    await h.ensureReady();

    mock.emit(makeFrameMsg("some-other-stream"));
    await flushMicrotasks();

    expect(h.ring.pushCount).toBe(0);

    h.dispose();
  });

  it("drops a late frame delivered after dispose (closes the bitmap, does not push)", async () => {
    const mock = mockPreviewSw();
    installApi(mock.previewSw);
    const h = new SwSourceHandle("layer-3", "media-3", "C:/fake/d.mov");
    await h.ensureReady();
    const streamId = h.streamId;

    // Start the conversion (createImageBitmap runs, `_disposed` still
    // false) then dispose while that already-resolved promise is still
    // in-flight — mirrors "disposed during the await" in `handleFrame`'s
    // post-conversion guard, which is the codepath that must close rather
    // than leak the bitmap. (Disposing BEFORE emit instead would hit the
    // earlier `if (this._disposed) return` guard, which returns before
    // `createImageBitmap` is ever called — nothing to close in that case.)
    mock.emit(makeFrameMsg(streamId));
    h.dispose();
    await flushMicrotasks();

    expect(h.ring.pushCount).toBe(0);
    // The disposed-guard must close the bitmap it just finished converting
    // rather than leak it — `lastBmp` is the stub instance handleFrame
    // created internally for this frame.
    expect(lastBmp?.close).toHaveBeenCalledOnce();
  });

  it("does not crash and logs a warning when frame conversion fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = vi.fn(
      async () => {
        throw new Error("bad NV12 buffer");
      },
    );
    const mock = mockPreviewSw();
    installApi(mock.previewSw);
    const h = new SwSourceHandle("layer-3b", "media-3b", "C:/fake/e.mov");
    await h.ensureReady();

    expect(() => mock.emit(makeFrameMsg(h.streamId))).not.toThrow();
    await flushMicrotasks();

    expect(h.ring.pushCount).toBe(0);
    expect(warn).toHaveBeenCalled();

    h.dispose();
    warn.mockRestore();
  });

  it("fires onFirstFrame exactly once, on the first pushed frame", async () => {
    const mock = mockPreviewSw();
    installApi(mock.previewSw);
    const h = new SwSourceHandle("layer-4", "media-4", "C:/fake/f.mov");
    await h.ensureReady();

    const cb = vi.fn();
    h.onFirstFrame(cb);
    mock.emit(makeFrameMsg(h.streamId, { ptsUs: 0, durUs: 16_667 }));
    await flushMicrotasks();
    mock.emit(makeFrameMsg(h.streamId, { ptsUs: 16_667, durUs: 16_667 }));
    await flushMicrotasks();

    expect(cb).toHaveBeenCalledOnce();

    // Late subscriber after the first frame already landed fires synchronously.
    const late = vi.fn();
    h.onFirstFrame(late);
    expect(late).toHaveBeenCalledOnce();

    h.dispose();
  });
});

describe("SwSourceHandle.requestFrameAt", () => {
  it("sends once per new target and dedups a repeated target", async () => {
    const mock = mockPreviewSw();
    installApi(mock.previewSw);
    const h = new SwSourceHandle("layer-5", "media-5", "C:/fake/g.mov");
    await h.ensureReady();

    await h.requestFrameAt(1_000);
    await h.requestFrameAt(1_000);
    await h.requestFrameAt(2_000);

    expect(mock.previewSw.requestFrameAt).toHaveBeenCalledTimes(2);
    expect(mock.previewSw.requestFrameAt).toHaveBeenNthCalledWith(1, { streamId: h.streamId, targetUs: 1_000 });
    expect(mock.previewSw.requestFrameAt).toHaveBeenNthCalledWith(2, { streamId: h.streamId, targetUs: 2_000 });

    h.dispose();
  });

  it("calls ring.setAnchor on every call, including a deduped repeat target", async () => {
    const mock = mockPreviewSw();
    installApi(mock.previewSw);
    const h = new SwSourceHandle("layer-5c", "media-5c", "C:/fake/g2.mov");
    await h.ensureReady();
    const spy = vi.spyOn(h.ring, "setAnchor");

    await h.requestFrameAt(1_000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenNthCalledWith(1, 1_000);

    // Repeated same-target call: the native-side send is deduped (still only
    // 1 requestFrameAt call to the transport), but setAnchor must still be
    // called a SECOND time — it sits BEFORE the dedup return so the ring's
    // eviction anchor tracks the playhead on every call, not just new
    // targets. If setAnchor were ever moved after the dedup return, this
    // second call would vanish while every other assertion here stayed green.
    await h.requestFrameAt(1_000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(2, 1_000);
    expect(mock.previewSw.requestFrameAt).toHaveBeenCalledTimes(1);

    h.dispose();
  });

  it("stops issuing requestFrameAt after dispose", async () => {
    const mock = mockPreviewSw();
    installApi(mock.previewSw);
    const h = new SwSourceHandle("layer-5b", "media-5b", "C:/fake/h.mov");
    await h.ensureReady();
    h.dispose();

    await h.requestFrameAt(1_000);

    expect(mock.previewSw.requestFrameAt).not.toHaveBeenCalled();
  });
});

describe("SwSourceHandle.dispose", () => {
  it("closes the native session and unsubscribes from onFrame", async () => {
    const mock = mockPreviewSw();
    installApi(mock.previewSw);
    const h = new SwSourceHandle("layer-6", "media-6", "C:/fake/i.mov");
    await h.ensureReady();
    const streamId = h.streamId;

    h.dispose();

    expect(h.disposed).toBe(true);
    expect(mock.previewSw.close).toHaveBeenCalledWith({ streamId });
    expect(mock.unsub).toHaveBeenCalledOnce();
  });

  it("is idempotent (second dispose is a no-op)", async () => {
    const mock = mockPreviewSw();
    installApi(mock.previewSw);
    const h = new SwSourceHandle("layer-6b", "media-6b", "C:/fake/j.mov");
    await h.ensureReady();

    h.dispose();
    h.dispose();

    expect(mock.previewSw.close).toHaveBeenCalledOnce();
    expect(mock.unsub).toHaveBeenCalledOnce();
  });

  it("is safe when ensureReady never completed", async () => {
    const open = vi.fn(() => new Promise<{ width: number; height: number }>(() => undefined));
    const requestFrameAt = vi.fn();
    const close = vi.fn();
    const onFrame = vi.fn(() => vi.fn());
    installApi({ open, requestFrameAt, close, onFrame });
    const h = new SwSourceHandle("layer-6c", "media-6c", "C:/fake/k.mov");

    void h.ensureReady();
    expect(() => h.dispose()).not.toThrow();
    expect(h.disposed).toBe(true);
  });
});

describe("SwSourceHandle.isIdle", () => {
  it("is false before any use, and true once lastUseMs is stale", async () => {
    const mock = mockPreviewSw();
    installApi(mock.previewSw);
    const h = new SwSourceHandle("layer-7", "media-7", "C:/fake/l.mov");

    expect(h.isIdle(performance.now())).toBe(false);

    await h.ensureReady();
    expect(h.isIdle(performance.now())).toBe(false);
    expect(h.isIdle(performance.now() + 10_000)).toBe(true);

    h.dispose();
  });
});
