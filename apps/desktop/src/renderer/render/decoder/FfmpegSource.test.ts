import { describe, expect, it, vi } from "vitest";
import { FfmpegSource } from "./FfmpegSource";
import type { DecodeTransport } from "./transports/DecodeTransport";

function fakeTransport(opts?: { openRejects?: string }) {
  let frameCb: ((b: ImageBitmap, p: number, d: number) => void) | null = null;
  let errorCb: ((r: string) => void) | null = null;
  let eofCb: (() => void) | null = null;
  return {
    t: {
      open: opts?.openRejects
        ? vi.fn(async () => { throw new Error(opts.openRejects); })
        : vi.fn(async () => {}),
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
      { makeGpu: () => gpu.t, makeSw: () => sw.t, pickLane: async () => ({ lane: "hardware" as const, hwLane: null, device: null }) },
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
      { makeGpu: () => gpu.t, makeSw: () => sw.t, pickLane: async () => ({ lane: "hardware" as const, hwLane: null, device: null }) },
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
      { makeGpu: () => gpu.t, makeSw: () => sw.t, pickLane: async () => ({ lane: "hardware" as const, hwLane: null, device: null }) },
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

  it("keeps evicting via the ring anchor after eof, even though the transport is no longer nudged", async () => {
    const gpu = fakeTransport();
    const sw = fakeTransport();
    const src = new FfmpegSource(
      { layerId: "L", mediaId: "m", sourcePath: "C:/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true },
      { makeGpu: () => gpu.t, makeSw: () => sw.t, pickLane: async () => ({ lane: "hardware" as const, hwLane: null, device: null }) },
    );
    await src.ensureReady();

    gpu.emitFrame(0);                            // a low-pts frame, still inside the ring
    expect(src.ring.size()).toBe(1);

    gpu.finishEof();                             // transport signals end-of-stream
    // Default lookbehind is 500_000us; a target far past that should evict
    // the frame at pts 0 via setAnchor, even though eof gates the IPC nudge.
    await src.requestFrameAt(2_000_000);

    expect(gpu.t.requestFrameAt).toHaveBeenCalledTimes(0); // still gated post-eof
    expect(src.ring.size()).toBe(0);                       // but the anchor still advanced and evicted
  });

  it("threads media width/height into pickInitialLane for classKey correctness (mod C)", async () => {
    const gpu = fakeTransport();
    const sw = fakeTransport();
    const pickLane = vi.fn(async () => ({ lane: "hardware" as const, hwLane: null, device: null }));
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

describe("FfmpegSource — HW open failure fallback", () => {
  it("falls back to SW in place when the HARDWARE open() rejects (budget/device-loss at open)", async () => {
    const gpu = fakeTransport({ openRejects: "hw-budget-exceeded" });
    const sw = fakeTransport();
    const onFatal = vi.fn();
    const src = new FfmpegSource(
      { layerId: "L", mediaId: "m", sourcePath: "C:/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true },
      { makeGpu: () => gpu.t, makeSw: () => sw.t, pickLane: async () => ({ lane: "hardware" as const, hwLane: null, device: null }) },
    );
    src.onFatalError(onFatal);

    await expect(src.ensureReady()).resolves.toBeUndefined();

    expect(gpu.t.dispose).toHaveBeenCalled();
    expect(src.currentLane()).toBe("software");
    expect(src.isDowngraded()).toBe(true);
    expect(sw.t.open).toHaveBeenCalled();
    expect(onFatal).not.toHaveBeenCalled();

    sw.emitFrame(1000);
    expect(src.ring.size()).toBe(1);
  });

  it("surfaces total failure when both HARDWARE and SOFTWARE open() reject", async () => {
    const gpu = fakeTransport({ openRejects: "hw-budget-exceeded" });
    const sw = fakeTransport({ openRejects: "sw-open-failed" });
    const onFatal = vi.fn();
    const src = new FfmpegSource(
      { layerId: "L", mediaId: "m", sourcePath: "C:/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true },
      { makeGpu: () => gpu.t, makeSw: () => sw.t, pickLane: async () => ({ lane: "hardware" as const, hwLane: null, device: null }) },
    );
    src.onFatalError(onFatal);

    await expect(src.ensureReady()).rejects.toThrow("sw-open-failed");

    expect(onFatal).toHaveBeenCalledWith(expect.stringContaining("sw-open-failed"));
  });

  it("does NOT fall back when the lane is forced (bench) and the forced HARDWARE open() rejects", async () => {
    const gpu = fakeTransport({ openRejects: "hw-budget-exceeded" });
    const sw = fakeTransport();
    const onFatal = vi.fn();
    const src = new FfmpegSource(
      {
        layerId: "L",
        mediaId: "m",
        sourcePath: "C:/x.mp4",
        codec: "h264",
        pixFmt: "yuv420p",
        componentAvailable: true,
        forceLane: "hardware",
      },
      { makeGpu: () => gpu.t, makeSw: () => sw.t },
    );
    src.onFatalError(onFatal);

    await expect(src.ensureReady()).rejects.toThrow("hw-budget-exceeded");

    expect(onFatal).toHaveBeenCalledWith(expect.stringContaining("hw-budget-exceeded"));
    expect(sw.t.open).not.toHaveBeenCalled();
  });
});

describe("FfmpegSource — hardware transport routing by HW lane (C2.2)", () => {
  it("routes a resolved NVDEC copy-back lane through the SW transport (not the GPU one)", async () => {
    const gpu = fakeTransport();
    const sw = fakeTransport();
    const src = new FfmpegSource(
      { layerId: "L", mediaId: "m", sourcePath: "/tmp/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true },
      {
        makeGpu: () => gpu.t,
        makeSw: () => sw.t,
        pickLane: async () => ({ lane: "hardware" as const, hwLane: "nvdec", device: null }),
      },
    );
    await src.ensureReady();
    // Copy-back: decode on the GPU, frames ship over the SAME previewSw transport.
    expect(src.currentLane()).toBe("hardware");
    expect(sw.t.open).toHaveBeenCalled();
    expect(gpu.t.open).not.toHaveBeenCalled();
  });

  it("routes a resolved VAAPI copy-back lane through the SW transport", async () => {
    const gpu = fakeTransport();
    const sw = fakeTransport();
    const src = new FfmpegSource(
      { layerId: "L", mediaId: "m", sourcePath: "/tmp/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true },
      {
        makeGpu: () => gpu.t,
        makeSw: () => sw.t,
        pickLane: async () => ({ lane: "hardware" as const, hwLane: "vaapi", device: "/dev/dri/renderD128" }),
      },
    );
    await src.ensureReady();
    expect(src.currentLane()).toBe("hardware");
    expect(sw.t.open).toHaveBeenCalled();
    expect(gpu.t.open).not.toHaveBeenCalled();
  });

  it("routes the Windows shared-texture lane (d3d11va) through the GPU transport", async () => {
    const gpu = fakeTransport();
    const sw = fakeTransport();
    const src = new FfmpegSource(
      { layerId: "L", mediaId: "m", sourcePath: "C:/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true },
      {
        makeGpu: () => gpu.t,
        makeSw: () => sw.t,
        pickLane: async () => ({ lane: "hardware" as const, hwLane: "d3d11va", device: null }),
      },
    );
    await src.ensureReady();
    expect(src.currentLane()).toBe("hardware");
    expect(gpu.t.open).toHaveBeenCalled();
    expect(sw.t.open).not.toHaveBeenCalled();
  });
});
