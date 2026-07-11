import { describe, expect, it, vi } from "vitest";
import { FfmpegSource } from "./FfmpegSource";
import type { DecodeTransport } from "./transports/DecodeTransport";

function fakeTransport() {
  let frameCb: ((b: ImageBitmap, p: number, d: number) => void) | null = null;
  let errorCb: ((r: string) => void) | null = null;
  let eofCb: (() => void) | null = null;
  return {
    t: {
      open: vi.fn(async () => {}),
      requestFrameAt: vi.fn(),
      onFrame: (cb) => { frameCb = cb; },
      onError: (cb) => { errorCb = cb; },
      onEof: (cb) => { eofCb = cb; },
      dispose: vi.fn(),
    } as DecodeTransport,
    emitFrame: (p: number) => frameCb?.({ close() {} } as unknown as ImageBitmap, p, 33),
    fail: (r: string) => errorCb?.(r),
    finishEof: () => eofCb?.(),
  };
}

describe("FfmpegSource — internal HW→SW fallback", () => {
  it("starts on hardware, and on HW error swaps to software in place keeping the ring", async () => {
    const gpu = fakeTransport();
    const sw = fakeTransport();
    const onFatal = vi.fn();
    const src = new FfmpegSource(
      { layerId: "L", mediaId: "m", sourcePath: "C:/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true },
      { makeGpu: () => gpu.t, makeSw: () => sw.t, pickLane: async () => "hardware" },
    );
    src.onFatalError(onFatal);
    await src.ensureReady();
    expect(src.currentLane()).toBe("hardware");
    gpu.emitFrame(1000);
    expect(src.ring.size()).toBe(1);

    gpu.fail("gpu-device-lost");                // HW dies mid-playback
    await new Promise((r) => setTimeout(r, 0));  // allow the in-place swap
    expect(gpu.t.dispose).toHaveBeenCalled();
    expect(sw.t.open).toHaveBeenCalled();
    expect(src.currentLane()).toBe("software");
    expect(src.isDowngraded()).toBe(true);
    expect(onFatal).not.toHaveBeenCalled();      // fully internal — no external signal
    sw.emitFrame(1033);
    expect(src.ring.size()).toBe(2);             // SAME ring kept its earlier frame
  });

  it("fires onFatalError only when SW also fails (total failure)", async () => {
    const gpu = fakeTransport();
    const sw = fakeTransport();
    const onFatal = vi.fn();
    const src = new FfmpegSource(
      { layerId: "L", mediaId: "m", sourcePath: "C:/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true },
      { makeGpu: () => gpu.t, makeSw: () => sw.t, pickLane: async () => "hardware" },
    );
    src.onFatalError(onFatal);
    await src.ensureReady();
    gpu.fail("gpu-error");
    await new Promise((r) => setTimeout(r, 0));
    sw.fail("sw-decode-error");                  // SW dies too
    await new Promise((r) => setTimeout(r, 0));
    expect(onFatal).toHaveBeenCalledWith(expect.stringContaining("sw-decode-error"));
  });

  it("stops nudging the transport once eof fires (mod B)", async () => {
    const gpu = fakeTransport();
    const sw = fakeTransport();
    const src = new FfmpegSource(
      { layerId: "L", mediaId: "m", sourcePath: "C:/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true },
      { makeGpu: () => gpu.t, makeSw: () => sw.t, pickLane: async () => "hardware" },
    );
    await src.ensureReady();

    await src.requestFrameAt(1000);
    expect(gpu.t.requestFrameAt).toHaveBeenCalledTimes(1);

    gpu.finishEof();                             // transport signals end-of-stream
    await src.requestFrameAt(2000);
    // No further IPC nudge past eof — the old handle used to gate on eof;
    // the transports no longer do, so FfmpegSource must gate it itself.
    expect(gpu.t.requestFrameAt).toHaveBeenCalledTimes(1);
  });

  it("threads media width/height into pickInitialLane for classKey correctness (mod C)", async () => {
    const gpu = fakeTransport();
    const sw = fakeTransport();
    const pickLane = vi.fn(async () => "hardware" as const);
    const src = new FfmpegSource(
      {
        layerId: "L",
        mediaId: "m",
        sourcePath: "C:/x.mp4",
        codec: "h264",
        pixFmt: "yuv420p",
        width: 3840,
        height: 2160,
        componentAvailable: true,
      },
      { makeGpu: () => gpu.t, makeSw: () => sw.t, pickLane },
    );
    await src.ensureReady();
    expect(pickLane).toHaveBeenCalledWith(
      expect.objectContaining({ width: 3840, height: 2160 }),
      undefined,
      "C:/x.mp4",
    );
  });
});
