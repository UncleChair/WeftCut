// @vitest-environment jsdom
//
// SwTransport.test.ts — NV12 -> ImageBitmap conversion + streamId filter,
// `window.api.previewSw` faked. jsdom (25.0.1, via vitest 4.1.7) implements
// neither `VideoFrame` nor `createImageBitmap` as globals (verified in
// `../SwSourceHandle.test.ts`), so both are stubbed on `globalThis` the same
// way that sibling test does, rather than exercising a real NV12 decode.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwTransport } from "./SwTransport";

class FakeVideoFrame {
  close = vi.fn();
  constructor(
    public data: unknown,
    public init: unknown,
  ) {}
}

function installFakeCodecGlobals(): void {
  (globalThis as unknown as { VideoFrame: unknown }).VideoFrame = FakeVideoFrame;
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = vi.fn(
    async () => ({ width: 2, height: 2, close: vi.fn() }) as unknown as ImageBitmap,
  );
}

beforeEach(() => {
  installFakeCodecGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe("SwTransport", () => {
  it("converts NV12 frames for its stream and ignores foreign ones", async () => {
    let onFrameCb: ((f: unknown) => void) | null = null;
    const api = {
      open: vi.fn(async () => {}),
      requestFrameAt: vi.fn(() => {}),
      close: vi.fn(() => {}),
      onFrame: vi.fn((cb: (f: unknown) => void) => { onFrameCb = cb; return () => {}; }),
    };
    (window as unknown as { api: { previewSw: typeof api } }).api = { previewSw: api };
    const t = new SwTransport();
    const got: number[] = [];
    t.onFrame((_b, ptsUs) => got.push(ptsUs));
    await t.open({ streamId: "s1", path: "C:/x.mov" });
    const nv12 = new Uint8Array(2 * 2 + 2); // 2x2 NV12 = 4 Y + 2 UV
    onFrameCb!({ streamId: "s2", data: nv12, width: 2, height: 2, ptsUs: 5, durUs: 33 });
    onFrameCb!({ streamId: "s1", data: nv12, width: 2, height: 2, ptsUs: 15, durUs: 33 });
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual([15]);
    t.dispose();
  });

  it("does not fire onError when disposed before a failing open() settles", async () => {
    let rejectOpen!: (e: Error) => void;
    const api = {
      open: () => new Promise((_res, rej) => { rejectOpen = rej; }),
      requestFrameAt: () => {},
      close: () => {},
      onFrame: () => () => {},
    };
    (window as unknown as { api: { previewSw: typeof api } }).api = { previewSw: api };
    const t = new SwTransport();
    const errors: string[] = [];
    t.onError((r) => errors.push(r));
    const p = t.open({ streamId: "s1", path: "C:/x.mov" });
    t.dispose();                       // disposed BEFORE open rejects
    rejectOpen(new Error("boom"));
    await expect(p).rejects.toThrow("boom");   // still rethrows
    expect(errors).toEqual([]);                 // but no stale fatal fired
  });
});
