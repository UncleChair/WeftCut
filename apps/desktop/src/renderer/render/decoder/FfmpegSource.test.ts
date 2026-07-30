import { beforeEach, describe, expect, it, vi } from "vitest";

// The lane trail is the only thing in this graph that reaches the LogBus, and
// it does so through `../../ipc`'s `window.api` bridge — absent in the node env.
const bus = vi.hoisted(() => ({ rows: [] as { message: string }[] }));
vi.mock("../../ipc", () => ({
  logEmit: async (input: { message: string }) => { bus.rows.push(input); },
}));
// Every spec injects its transport adapter. Mock the production WebGPU
// adapter so this module-level test does not load renderer-fence machinery.
vi.mock("./transports/GpuTransport", () => ({
  GpuTransport: class {},
}));

import { FfmpegSource } from "./FfmpegSource";
import { pickInitialLane, resetFfmpegCapabilitySession } from "./ffmpegCapability";
import { resetFfmpegLaneTrail } from "./ffmpegLaneTrail";
import {
  HW_BUDGET_EXCEEDED,
  HW_BUDGET_RESERVATION_MISMATCH,
} from "../../../shared/ipc";
import type { DecodeTransport } from "./transports/DecodeTransport";

function fakeTransport(opts?: { openRejects?: string; disposeRejects?: string }) {
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
      dispose: opts?.disposeRejects
        ? vi.fn(async () => { throw new Error(opts.disposeRejects); })
        : vi.fn(),
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

  it("stops nudging while the ring's lookahead is full, and resumes as it drains", async () => {
    // The lane's brake. Before this, `isLookaheadFull` was computed on every
    // ffmpeg source and consulted by nobody, so nothing bounded what the decoder
    // PRODUCED — only what the ring kept.
    const gpu = fakeTransport();
    const sw = fakeTransport();
    const src = new FfmpegSource(
      { layerId: "L", mediaId: "m", sourcePath: "C:/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true },
      { makeGpu: () => gpu.t, makeSw: () => sw.t, pickLane: async () => ({ lane: "hardware" as const, hwLane: null, device: null }) },
    );
    await src.ensureReady();

    gpu.emitFrame(0);
    gpu.emitFrame(1_500_000);          // a full second of lookahead past the anchor below
    await src.requestFrameAt(100_000); // target inside the ring, so no stranded-flush
    expect(src.isLookaheadFull()).toBe(true);
    expect(gpu.t.requestFrameAt).toHaveBeenCalledTimes(0);

    // Playhead advances; the same cached tail is no longer a full window ahead.
    await src.requestFrameAt(600_000);
    expect(gpu.t.requestFrameAt).toHaveBeenCalledWith(600_000);
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
  it("retries hardware before spilling when the pool reclaims retained capacity", async () => {
    const blocked = fakeTransport({ openRejects: HW_BUDGET_EXCEEDED });
    const admitted = fakeTransport();
    const sw = fakeTransport();
    const reclaimRetainedCapacity = vi.fn(() => true);
    const gpuAttempts = [blocked, admitted];
    const src = new FfmpegSource(
      {
        layerId: "upcoming",
        mediaId: "m",
        sourcePath: "C:/x.mp4",
        codec: "h264",
        pixFmt: "yuv420p",
        componentAvailable: true,
      },
      {
        makeGpu: () => gpuAttempts.shift()!.t,
        makeSw: () => sw.t,
        pickLane: async () => ({ lane: "hardware" as const, hwLane: null, device: null }),
        reclaimRetainedCapacity,
      },
    );

    await src.ensureReady();

    expect(reclaimRetainedCapacity).toHaveBeenCalledOnce();
    expect(blocked.t.dispose).toHaveBeenCalledOnce();
    expect(admitted.t.open).toHaveBeenCalledOnce();
    expect(sw.t.open).not.toHaveBeenCalled();
    expect(src.currentLane()).toBe("hardware");
    expect(src.isDowngraded()).toBe(false);
  });

  it("waits for the retained session's lease release before retrying hardware", async () => {
    const blocked = fakeTransport({ openRejects: HW_BUDGET_EXCEEDED });
    const admitted = fakeTransport();
    const sw = fakeTransport();
    const gpuAttempts = [blocked, admitted];
    let finishLeaseRelease!: (released: boolean) => void;
    const leaseReleased = new Promise<boolean>((resolve) => {
      finishLeaseRelease = resolve;
    });
    const src = new FfmpegSource(
      {
        layerId: "upcoming",
        mediaId: "m",
        sourcePath: "C:/x.mp4",
        codec: "h264",
        pixFmt: "yuv420p",
        componentAvailable: true,
      },
      {
        makeGpu: () => gpuAttempts.shift()!.t,
        makeSw: () => sw.t,
        pickLane: async () => ({ lane: "hardware" as const, hwLane: null, device: null }),
        reclaimRetainedCapacity: () => leaseReleased,
      },
    );

    const ready = src.ensureReady();
    await vi.waitFor(() => {
      expect(blocked.t.dispose).toHaveBeenCalledOnce();
    });
    expect(admitted.t.open).not.toHaveBeenCalled();

    finishLeaseRelease(true);
    await ready;

    expect(admitted.t.open).toHaveBeenCalledOnce();
    expect(src.currentLane()).toBe("hardware");
  });

  it("still opens the software spill when rejected-HW cleanup and reclaim fail", async () => {
    const blocked = fakeTransport({
      openRejects: HW_BUDGET_EXCEEDED,
      disposeRejects: "close failed",
    });
    const sw = fakeTransport();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const src = new FfmpegSource(
      {
        layerId: "upcoming",
        mediaId: "m",
        sourcePath: "C:/x.mp4",
        codec: "h264",
        pixFmt: "yuv420p",
        componentAvailable: true,
      },
      {
        makeGpu: () => blocked.t,
        makeSw: () => sw.t,
        pickLane: async () => ({ lane: "hardware" as const, hwLane: null, device: null }),
        reclaimRetainedCapacity: async () => {
          throw new Error("reclaim failed");
        },
      },
    );

    await expect(src.ensureReady()).resolves.toBeUndefined();

    expect(src.currentLane()).toBe("software");
    expect(sw.t.open).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("hardware transport close failed"),
      expect.any(Error),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("capacity reclaim failed"),
      expect.any(Error),
    );
  });

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

  it("routes a resolved VideoToolbox copy-back lane through the SW transport (macOS, issue #10)", async () => {
    const gpu = fakeTransport();
    const sw = fakeTransport();
    const src = new FfmpegSource(
      { layerId: "L", mediaId: "m", sourcePath: "/tmp/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true },
      {
        makeGpu: () => gpu.t,
        makeSw: () => sw.t,
        pickLane: async () => ({ lane: "hardware" as const, hwLane: "videotoolbox", device: null }),
      },
    );
    await src.ensureReady();
    // Same posture as nvdec/vaapi: decode on the OS media engine, frames ship
    // NV12 over the SAME previewSw transport (ADR 0029/0034).
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

describe("FfmpegSource — HW open failure: capacity vs capability", () => {
  // `markHwUnusable` is a sticky per-MEDIA, session-lifetime verdict. The
  // concurrent-HW-session budget is a transient CAPACITY limit, so recording it
  // pinned a source to the software lane for the rest of the app session the
  // moment its concurrent load exceeded admission — and kept it
  // there after the extra clips were deleted. Symptom: a single 4K clip that had
  // been fine suddenly stutters through the SW lane with nothing on the timeline
  // to explain it.
  const openFails = (
    reason: string,
    options: { width?: number | null; height?: number | null; playbackScaleDiv?: number } = {},
  ) => {
    const gpu = fakeTransport({ openRejects: reason });
    const sw = fakeTransport();
    const makeSw = vi.fn(() => sw.t);
    const src = new FfmpegSource(
      {
        layerId: "L",
        mediaId: "m-cap",
        sourcePath: "C:/x.mp4",
        codec: "h264",
        pixFmt: "yuv420p",
        componentAvailable: true,
        width: options.width ?? 3840,
        height: options.height ?? 2160,
        ...(options.playbackScaleDiv !== undefined
          ? { playbackScaleDiv: options.playbackScaleDiv }
          : {}),
      },
      {
        makeGpu: () => gpu.t,
        makeSw,
        pickLane: async () => ({ lane: "hardware" as const, hwLane: "d3d11va", device: null }),
      },
    );
    return { src, gpu, sw, makeSw };
  };

  /// Ask the REAL resolver what the next open for this media would pick, with a
  /// probe stub that always reports hardware available. A marked media short-
  /// circuits to software WITHOUT probing, so `probed` distinguishes the two
  /// states without needing the marker set exported.
  const nextOpenLane = async (mediaId: string) => {
    let probed = false;
    const res = await pickInitialLane(
      { mediaId, codec: "h264", pixFmt: "yuv420p", width: 3840, height: 2160, componentAvailable: true },
      async () => { probed = true; return { ok: true, lane: "d3d11va", device: null }; },
      "C:/x.mp4",
    );
    return { lane: res.lane, probed };
  };

  beforeEach(() => resetFfmpegCapabilitySession());

  it("falls back to software for a budget failure WITHOUT marking the media", async () => {
    const { src, sw, makeSw } = openFails(HW_BUDGET_EXCEEDED);
    await src.ensureReady();
    expect(src.currentLane()).toBe("software"); // this open degrades…
    expect(sw.t.open).toHaveBeenCalled();
    expect(makeSw).toHaveBeenCalledWith({
      scaleDiv: 4,
      cadenceDiv: 2,
    });
    // …but the media's verdict is untouched, so the NEXT open re-probes and takes
    // hardware again once a session frees up.
    expect(await nextOpenLane("m-cap")).toEqual({ lane: "hardware", probed: true });
  });

  it("treats native dimension drift as transient without applying the budget spill profile", async () => {
    const { src, makeSw } = openFails(
      `${HW_BUDGET_RESERVATION_MISMATCH}: reserved 3840x2160, native opened 1920x1080`,
      { playbackScaleDiv: 2 },
    );
    await src.ensureReady();

    expect(src.currentLane()).toBe("software");
    expect(makeSw).toHaveBeenCalledWith({
      scaleDiv: 2,
      cadenceDiv: 1,
    });
    expect(await nextOpenLane("m-cap")).toEqual({ lane: "hardware", probed: true });
  });

  it("still records a genuine capability failure (device lost at open)", async () => {
    const { src } = openFails("d3d11 device creation failed");
    await src.ensureReady();
    expect(src.currentLane()).toBe("software");
    // Sticky, as intended: the next open skips hardware without even probing.
    expect(await nextOpenLane("m-cap")).toEqual({ lane: "software", probed: false });
  });
});

describe("FfmpegSource — live playback-resolution change", () => {
  /// The streamId this transport was opened with. A fresh one per open is what
  /// stops late frames from a swapped-out transport landing in the ring.
  const streamIdOf = (t: ReturnType<typeof fakeTransport>): string =>
    vi.mocked(t.t.open).mock.calls[0]![0].streamId;

  /// A source on a lane that SHIPS BYTES (software here; the Linux copy-back
  /// lanes ride the same transport), with `makeSw` handing out a FRESH fake per
  /// open so the re-open is distinguishable from the original.
  const swSource = () => {
    const opened: ReturnType<typeof fakeTransport>[] = [];
    const src = new FfmpegSource(
      { layerId: "L", mediaId: "m", sourcePath: "C:/x.mov", codec: "prores", pixFmt: "yuv422p10le", componentAvailable: true },
      {
        makeGpu: () => fakeTransport().t,
        makeSw: () => { const t = fakeTransport(); opened.push(t); return t.t; },
        pickLane: async () => ({ lane: "software" as const, hwLane: null, device: null }),
      },
    );
    return { src, opened };
  };

  it("does nothing when the divisor is unchanged", async () => {
    const { src, opened } = swSource();
    await src.ensureReady();
    expect(opened).toHaveLength(1);

    src.setPlaybackScaleDiv(1); // already 1 (the init default)
    await new Promise((r) => setTimeout(r, 0));

    expect(opened).toHaveLength(1);
    expect(opened[0]!.t.dispose).not.toHaveBeenCalled();
  });

  it("re-opens in place on the SAME lane with a fresh streamId, keeping the ring", async () => {
    const { src, opened } = swSource();
    await src.ensureReady();
    await src.requestFrameAt(1_000_000);
    opened[0]!.emitFrame(1_000_000);
    expect(src.ring.size()).toBe(1);

    src.setPlaybackScaleDiv(2);
    await new Promise((r) => setTimeout(r, 0));

    expect(opened).toHaveLength(2);
    expect(opened[0]!.t.dispose).toHaveBeenCalled();     // old transport torn down
    expect(src.currentLane()).toBe("software");          // NOT a lane change
    expect(streamIdOf(opened[1]!)).not.toBe(streamIdOf(opened[0]!));
    expect(src.ring.size()).toBe(1);                     // SAME ring — no black frame
    // The new transport resumes at the last target without the caller asking.
    expect(opened[1]!.t.requestFrameAt).toHaveBeenCalledWith(1_000_000);
    opened[1]!.emitFrame(1_033_333);
    expect(src.ring.size()).toBe(2);                     // frames land in that same ring
  });

  it("leaves the Windows shared-texture lane alone (no IPC pixels to shrink)", async () => {
    // d3d11va frames never cross IPC, so the divisor cannot help there — and a
    // pointless close+re-open would gamble a scarce HW session slot.
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

    src.setPlaybackScaleDiv(4);
    await new Promise((r) => setTimeout(r, 0));

    expect(gpu.t.dispose).not.toHaveBeenCalled();
    expect(gpu.t.open).toHaveBeenCalledTimes(1);
    expect(sw.t.open).not.toHaveBeenCalled();
  });

  it("carries a divisor set while on hardware into a later software fallback", async () => {
    // The value is recorded even when the current lane can't use it, so the
    // fallback transport opens at the user's setting rather than full res.
    const gpu = fakeTransport();
    const opened: ReturnType<typeof fakeTransport>[] = [];
    const src = new FfmpegSource(
      { layerId: "L", mediaId: "m-carry", sourcePath: "C:/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true },
      {
        makeGpu: () => gpu.t,
        makeSw: () => { const t = fakeTransport(); opened.push(t); return t.t; },
        pickLane: async () => ({ lane: "hardware" as const, hwLane: "d3d11va", device: null }),
      },
    );
    await src.ensureReady();
    src.setPlaybackScaleDiv(4);
    expect(opened).toHaveLength(0); // recorded only — no HW churn

    gpu.fail("gpu-device-lost");
    await new Promise((r) => setTimeout(r, 0));
    expect(src.currentLane()).toBe("software");
    expect(opened).toHaveLength(1); // opened by the fallback, reading the live divisor
  });
});

describe("FfmpegSource — lane transitions leave a trail", () => {
  // The lane is deliberately absent from the resolved decode key (ADR 0030), so
  // the resolution trail cannot see it move; `ffmpegLaneTrail` is the channel
  // that can. What matters here is the COUNT — once per transition, never per
  // open and never per frame.
  beforeEach(() => {
    bus.rows.length = 0;
    resetFfmpegLaneTrail();
    resetFfmpegCapabilitySession();
  });

  const hwSource = (
    layerId: string,
    mediaId: string,
    gpu: ReturnType<typeof fakeTransport>,
    sw: ReturnType<typeof fakeTransport>,
  ) =>
    new FfmpegSource(
      { layerId, mediaId, sourcePath: "C:/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true },
      { makeGpu: () => gpu.t, makeSw: () => sw.t, pickLane: async () => ({ lane: "hardware" as const, hwLane: "d3d11va", device: null }) },
    );

  it("emits exactly one row, naming the reason, when the hardware open overflows the budget", async () => {
    // The hardware open THREW, so nothing ever recorded "hardware" — the row
    // exists only because the fallback tells the trail what it left.
    const src = hwSource("L-of", "m-of", fakeTransport({ openRejects: HW_BUDGET_EXCEEDED }), fakeTransport());
    await src.ensureReady();

    expect(src.currentLane()).toBe("software");
    expect(bus.rows).toHaveLength(1);
    expect(bus.rows[0]!.message).toContain("layer L-of");
    expect(bus.rows[0]!.message).toContain("media m-of");
    expect(bus.rows[0]!.message).toContain("hardware → software");
    expect(bus.rows[0]!.message).toContain(HW_BUDGET_EXCEEDED);
  });

  it("emits a second row for the return trip once a hardware session frees up", async () => {
    // The budget is per-open and never sticky, so the same clip re-promotes on
    // its next open. Silence there would read as "still on software".
    const overflowed = hwSource("L-rt", "m-rt", fakeTransport({ openRejects: HW_BUDGET_EXCEEDED }), fakeTransport());
    await overflowed.ensureReady();
    overflowed.dispose();

    const promoted = hwSource("L-rt", "m-rt", fakeTransport(), fakeTransport());
    await promoted.ensureReady();

    expect(promoted.currentLane()).toBe("hardware");
    expect(bus.rows).toHaveLength(2);
    expect(bus.rows[1]!.message).toContain("software → hardware");
  });

  it("emits one row for the runtime HW→SW swap and nothing more as frames flow", async () => {
    const gpu = fakeTransport();
    const sw = fakeTransport();
    const src = hwSource("L-loss", "m-loss", gpu, sw);
    await src.ensureReady();
    expect(bus.rows).toHaveLength(0); // the first open is not a transition

    gpu.fail("gpu-device-lost");
    await new Promise((r) => setTimeout(r, 0));
    expect(bus.rows).toHaveLength(1);
    expect(bus.rows[0]!.message).toContain("hardware → software (gpu-device-lost)");

    for (let i = 0; i < 30; i++) {
      await src.requestFrameAt(i * 33_333);
      sw.emitFrame(i * 33_333);
    }
    expect(bus.rows).toHaveLength(1); // per transition, not per frame
  });

  it("says nothing at all when no transition happens", async () => {
    const gpu = fakeTransport();
    const src = hwSource("L-quiet", "m-quiet", gpu, fakeTransport());
    await src.ensureReady();
    for (let i = 0; i < 30; i++) {
      await src.requestFrameAt(i * 33_333);
      gpu.emitFrame(i * 33_333);
    }
    expect(src.currentLane()).toBe("hardware");
    expect(bus.rows).toEqual([]);
  });

  it("says nothing on the same-lane playback-resolution re-open", async () => {
    // `setPlaybackScaleDiv` reuses the fallback's dispose-and-`openLane`
    // mechanism, so the trail — not the call site — is what keeps it quiet.
    const src = new FfmpegSource(
      { layerId: "L-scale", mediaId: "m-scale", sourcePath: "C:/x.mov", codec: "prores", pixFmt: "yuv422p10le", componentAvailable: true },
      {
        makeGpu: () => fakeTransport().t,
        makeSw: () => fakeTransport().t,
        pickLane: async () => ({ lane: "software" as const, hwLane: null, device: null }),
      },
    );
    await src.ensureReady();
    src.setPlaybackScaleDiv(2);
    await new Promise((r) => setTimeout(r, 0));
    src.setPlaybackScaleDiv(4);
    await new Promise((r) => setTimeout(r, 0));

    expect(src.currentLane()).toBe("software");
    expect(bus.rows).toEqual([]);
  });
});

describe("FfmpegSource — backward seek", () => {
  const makeSrc = (t: ReturnType<typeof fakeTransport>) =>
    new FfmpegSource(
      { layerId: "L", mediaId: "m", sourcePath: "C:/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true },
      { makeGpu: () => t.t, makeSw: () => t.t, pickLane: async () => ({ lane: "hardware" as const, hwLane: "d3d11va", device: null }) },
    );

  it("drops a ring stranded ahead of the new target", async () => {
    // `ring.setAnchor` evicts from the FRONT only, so without this flush the ring
    // keeps every future-dated frame, `frameAt` returns null past the clamp gap,
    // and the painter holds a 12-second-stale frame until playback grinds back up
    // to the cached span. The WebCodecs lane flushes via `PacketPump.decideReset`;
    // this lane had no equivalent.
    const gpu = fakeTransport();
    const src = makeSrc(gpu);
    await src.ensureReady();
    for (const p of [11_700_000, 11_733_333, 11_766_666]) gpu.emitFrame(p);
    expect(src.ring.size()).toBe(3);

    await src.requestFrameAt(0);
    expect(src.ring.size()).toBe(0);
    // The decoder is still asked for the new target — flushing must not swallow it.
    expect(gpu.t.requestFrameAt).toHaveBeenLastCalledWith(0);
  });

  it("keeps the ring on a backward move the clamp can still serve", async () => {
    const gpu = fakeTransport();
    const src = makeSrc(gpu);
    await src.ensureReady();
    for (const p of [1_000_000, 1_033_333]) gpu.emitFrame(p);
    await src.requestFrameAt(990_000); // inside the clamp gap
    expect(src.ring.size()).toBe(2);
  });

  it("clears the eof latch so a post-eof backward seek still reaches the decoder", async () => {
    // EOF is not terminal for a backward seek — the native session re-arms decoding
    // on the seek its `on_request` performs. While the latch held, the early
    // `return` swallowed every later request for the transport's whole life, so a
    // session that ever hit eof could never produce another frame.
    const gpu = fakeTransport();
    const src = makeSrc(gpu);
    await src.ensureReady();
    for (const p of [11_700_000, 11_733_333]) gpu.emitFrame(p);
    gpu.finishEof();

    await src.requestFrameAt(11_733_333); // forward/at eof: still gated, as before
    expect(gpu.t.requestFrameAt).not.toHaveBeenCalledWith(11_733_333);

    await src.requestFrameAt(0); // backward past the ring: must re-arm
    expect(gpu.t.requestFrameAt).toHaveBeenLastCalledWith(0);
  });

  it("re-arms a post-eof source whose ring has fully DRAINED (empty-ring latch escape)", async () => {
    // `strandedAheadOf` is false on an empty ring by construction, and post-eof
    // lookbehind eviction reaches exactly that state (setAnchor keeps running
    // while eof gates requests). With the stranded flush as the latch's ONLY
    // escape, a backward seek then never re-armed the transport — the clip
    // stayed black for the rest of the session, and `lastUseMs` (stamped before
    // the gate) kept the idle sweeper from ever reclaiming it either.
    const gpu = fakeTransport();
    const src = makeSrc(gpu);
    await src.ensureReady();
    gpu.emitFrame(0);
    gpu.finishEof();

    await src.requestFrameAt(2_000_000); // far past lookbehind: evicts pts 0, ring empties
    expect(src.ring.size()).toBe(0);
    expect(gpu.t.requestFrameAt).not.toHaveBeenCalled();

    await src.requestFrameAt(1_000); // backward, nothing cached: must still re-arm
    expect(gpu.t.requestFrameAt).toHaveBeenLastCalledWith(1_000);
  });

  it("resets the transport's same-target dedup whenever the eof latch re-arms", async () => {
    // The SW transport dedups on last-sent target and FfmpegSource latches eof;
    // the two were introduced by different commits with no shared reset point.
    // Frame-grid snapping makes exact-repeat targets routine, so a re-arm that
    // does not clear the dedup can have its very first request swallowed while
    // the ring it should refill sits empty.
    const gpu = fakeTransport();
    const reset = vi.fn();
    (gpu.t as DecodeTransport).resetRequestDedup = reset;
    const src = makeSrc(gpu);
    await src.ensureReady();
    for (const p of [11_700_000, 11_733_333]) gpu.emitFrame(p);

    await src.requestFrameAt(0); // stranded flush arm
    expect(reset).toHaveBeenCalledTimes(1);

    gpu.emitFrame(100_000);
    gpu.finishEof();
    await src.requestFrameAt(2_000_000); // drain the ring past lookbehind
    await src.requestFrameAt(1_000); // empty-ring backward arm
    expect(reset).toHaveBeenCalledTimes(2);
  });
});

describe("FfmpegSource — dispose racing the recovery path", () => {
  it("does not resurrect a software transport on a source disposed mid-fallback", async () => {
    // The HW→SW fallback awaits the failed transport's dispose before opening
    // software. `disposeAndWait` landing in that window sees `transport ===
    // null` and resolves instantly — so an openLane past it would open a
    // native session on a disposed source that NOTHING can ever close (the
    // dispose latch is already spent). The recovery path must re-check
    // `_disposed` after every await, this one included.
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((r) => { releaseDispose = r; });
    const gpu = fakeTransport({ openRejects: HW_BUDGET_EXCEEDED });
    vi.mocked(gpu.t.dispose).mockImplementation(() => disposeGate);
    const sw = fakeTransport();
    const src = new FfmpegSource(
      { layerId: "L", mediaId: "m", sourcePath: "C:/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true },
      { makeGpu: () => gpu.t, makeSw: () => sw.t, pickLane: async () => ({ lane: "hardware" as const, hwLane: "d3d11va", device: null }) },
    );
    const ready = src.ensureReady();
    // Let the rejected hardware open reach the fallback's dispose await.
    await new Promise((r) => setTimeout(r, 0));
    const disposed = src.disposeAndWait(); // transport already null → resolves at once
    releaseDispose();
    await ready;
    await disposed;
    expect(sw.t.open).not.toHaveBeenCalled();
  });

  it("swallows per-tick nudges after a total open failure instead of re-rejecting each one", async () => {
    // `ensureReady` caches the rejection and `fireFatal` already reported it;
    // before the guard, every subsequent `void requestFrameAt(...)` from the
    // Compositor's tick minted a fresh unhandled rejection for the same
    // failure, forever.
    const sw = fakeTransport({ openRejects: "sw-open-boom" });
    const onFatal = vi.fn();
    const src = new FfmpegSource(
      { layerId: "L", mediaId: "m", sourcePath: "C:/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true },
      { makeGpu: () => sw.t, makeSw: () => sw.t, pickLane: async () => ({ lane: "software" as const, hwLane: null, device: null }) },
    );
    src.onFatalError(onFatal);
    await expect(src.ensureReady()).rejects.toThrow("sw-open-boom");
    expect(onFatal).toHaveBeenCalledWith(expect.stringContaining("sw-open-boom"));
    await expect(src.requestFrameAt(500)).resolves.toBeUndefined();
  });

  it("reports a hardware lease only while a live shared-texture transport holds one", async () => {
    // The pool's reclaim victim predicate keys on this. `lane === "hardware"`
    // alone over-approximates: it is assigned before open settles and survives
    // the fallback nulling the transport — reclaiming such a source tears down
    // a live clip and frees no lease at all.
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((r) => { releaseDispose = r; });
    const gpu = fakeTransport({ openRejects: HW_BUDGET_EXCEEDED });
    vi.mocked(gpu.t.dispose).mockImplementation(() => disposeGate);
    const sw = fakeTransport();
    const src = new FfmpegSource(
      { layerId: "L", mediaId: "m", sourcePath: "C:/x.mp4", codec: "h264", pixFmt: "yuv420p", componentAvailable: true },
      { makeGpu: () => gpu.t, makeSw: () => sw.t, pickLane: async () => ({ lane: "hardware" as const, hwLane: "d3d11va", device: null }) },
    );
    const ready = src.ensureReady();
    await new Promise((r) => setTimeout(r, 0));
    // Mid-fallback: lane still reads "hardware" but the transport is gone.
    expect(src.currentLane()).toBe("hardware");
    expect(src.holdsHwSessionLease()).toBe(false);
    releaseDispose();
    await ready;
    // Settled on the software spill: no lease either.
    expect(src.currentLane()).toBe("software");
    expect(src.holdsHwSessionLease()).toBe(false);
  });
});
