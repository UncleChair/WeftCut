// @vitest-environment jsdom
//
// `SourceDecoderPool.acquire()` branches on `engine: 'ffmpeg'` to build a
// `FfmpegSource` (native hardware/software decode, chosen by
// `resolveDecodeEngine`), falling through to the default WebCodecs
// `SourceHandle` otherwise. `FfmpegSource` owns lane selection internally.
import { describe, expect, it, vi } from "vitest";

vi.mock("./transports/GpuTransport", () => ({
  GpuTransport: class {},
}));
vi.mock("../../ipc", () => ({
  logEmit: vi.fn(async () => {}),
}));

import { SourceDecoderPool } from "./SourceDecoderPool";
import { FfmpegSource, type FfmpegSourceInit } from "./FfmpegSource";
import { HW_BUDGET_EXCEEDED } from "../../../shared/ipc";
import type { DecodeTransport } from "./transports/DecodeTransport";

function fakeTransport(opts?: { openRejects?: string; disposeWaits?: Promise<void> }) {
  return {
    open: opts?.openRejects
      ? vi.fn(async () => { throw new Error(opts.openRejects); })
      : vi.fn(async () => {}),
    requestFrameAt: vi.fn(),
    onFrame: vi.fn(),
    onError: vi.fn(),
    onEof: vi.fn(),
    dispose: vi.fn(() => opts?.disposeWaits),
  } as DecodeTransport;
}

function ffmpegInit(layerId: string): FfmpegSourceInit {
  return {
    layerId,
    mediaId: layerId,
    sourcePath: `C:/${layerId}.mp4`,
    codec: "h264",
    pixFmt: "yuv420p",
    width: 3840,
    height: 2160,
    componentAvailable: true,
  };
}

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

describe("SourceDecoderPool media refcounts across engines", () => {
  it("releasing an ffmpeg handle must not decrement a WebCodecs handle's media refcount", () => {
    const pool = new SourceDecoderPool({
      makeFfmpegSource: (init: FfmpegSourceInit) => new FfmpegSource(init, {
        makeGpu: () => fakeTransport(),
        makeSw: () => fakeTransport(),
        pickLane: async () => ({ lane: "software" as const, hwLane: null, device: null }),
      }),
    });
    // Two clips over ONE media, resolved to DIFFERENT engines (an engine flip
    // between the two acquires: component load settling, a capability probe,
    // or markFfmpegUnusable firing in the gap). The ffmpeg branch of acquire
    // never takes a `medias` refcount — so its release must not put one back,
    // or the count the WebCodecs handle paid for hits 0 and its SourceMedia
    // (Input + packetSink the pump captured eagerly) is disposed under it.
    const web = pool.acquire({
      layerId: "L-web",
      mediaId: "shared",
      proxyAssetUrl: "weftcut-media://p.mp4",
      engine: "webcodecs",
    } as never) as { media: { disposed: boolean } };
    pool.acquire({ ...ffmpegInit("L-ff"), mediaId: "shared", engine: "ffmpeg", proxyAssetUrl: "" });

    pool.release("L-ff");
    expect(web.media.disposed).toBe(false);

    pool.release("L-web"); // the real owner's release still frees it
    expect(web.media.disposed).toBe(true);
    pool.dispose();
  });
});

describe("SourceDecoderPool hardware priority", () => {
  it("waits for a retained hardware lease to close before retrying an upcoming clip", async () => {
    let finishRetainedClose!: () => void;
    const retainedClose = new Promise<void>((resolve) => {
      finishRetainedClose = resolve;
    });
    const activeGpu = fakeTransport();
    const retainedGpu = fakeTransport({ disposeWaits: retainedClose });
    const blockedGpu = fakeTransport({ openRejects: HW_BUDGET_EXCEEDED });
    const admittedGpu = fakeTransport();
    const upcomingSw = fakeTransport();
    const upcomingAttempts = [blockedGpu, admittedGpu];
    const pool = new SourceDecoderPool({
      makeFfmpegSource: (
        init: FfmpegSourceInit,
        reclaimRetainedCapacity: () => boolean | Promise<boolean>,
      ) => new FfmpegSource(init, {
        makeGpu: () => init.layerId === "active"
          ? activeGpu
          : init.layerId === "retained"
            ? retainedGpu
            : upcomingAttempts.shift()!,
        makeSw: () => upcomingSw,
        pickLane: async () => ({ lane: "hardware" as const, hwLane: null, device: null }),
        reclaimRetainedCapacity,
      }),
    });

    pool.setPriorityKeys(["active"]);
    const active = pool.acquire({ ...ffmpegInit("active"), engine: "ffmpeg", proxyAssetUrl: "" });
    await active.ensureReady();
    const retained = pool.acquire({ ...ffmpegInit("retained"), engine: "ffmpeg", proxyAssetUrl: "" });
    await retained.ensureReady();

    pool.setPriorityKeys(["active", "upcoming"]);
    const upcoming = pool.acquire({ ...ffmpegInit("upcoming"), engine: "ffmpeg", proxyAssetUrl: "" });
    const ready = upcoming.ensureReady();
    await vi.waitFor(() => {
      expect(retainedGpu.dispose).toHaveBeenCalledOnce();
    });
    expect(admittedGpu.open).not.toHaveBeenCalled();

    finishRetainedClose();
    await ready;

    expect(retained.disposed).toBe(true);
    expect(active.disposed).toBe(false);
    expect(activeGpu.dispose).not.toHaveBeenCalled();
    expect(admittedGpu.open).toHaveBeenCalledOnce();
    expect(upcomingSw.open).not.toHaveBeenCalled();
    expect((upcoming as FfmpegSource).currentLane()).toBe("hardware");
    pool.dispose();
  });

  it("reopens a prewarm spill when the clip becomes active and capacity shifts", async () => {
    const currentGpu = fakeTransport();
    const blockedGpu = fakeTransport({ openRejects: HW_BUDGET_EXCEEDED });
    const admittedGpu = fakeTransport();
    const spillSw = fakeTransport();
    let upcomingGeneration = 0;
    const pool = new SourceDecoderPool({
      makeFfmpegSource: (
        init: FfmpegSourceInit,
        reclaimRetainedCapacity: () => boolean | Promise<boolean>,
      ) => {
        const generation = init.layerId === "upcoming"
          ? upcomingGeneration++
          : 0;
        return new FfmpegSource(init, {
          makeGpu: () => init.layerId === "current"
            ? currentGpu
            : generation === 0
              ? blockedGpu
              : admittedGpu,
          makeSw: () => spillSw,
          pickLane: async () => ({ lane: "hardware" as const, hwLane: null, device: null }),
          reclaimRetainedCapacity,
        });
      },
    });

    pool.setPriorityKeys(["current", "upcoming"]);
    const current = pool.acquire({ ...ffmpegInit("current"), engine: "ffmpeg", proxyAssetUrl: "" });
    await current.ensureReady();
    const prewarmed = pool.acquire({ ...ffmpegInit("upcoming"), engine: "ffmpeg", proxyAssetUrl: "" });
    await prewarmed.ensureReady();
    expect((prewarmed as FfmpegSource).currentLane()).toBe("software");
    expect((prewarmed as FfmpegSource).isBudgetSpill()).toBe(true);

    await pool.setPriorityKeys(["upcoming"]);
    const active = pool.acquire({ ...ffmpegInit("upcoming"), engine: "ffmpeg", proxyAssetUrl: "" });
    await active.ensureReady();

    expect(current.disposed).toBe(true);
    expect(prewarmed.disposed).toBe(true);
    expect(active).not.toBe(prewarmed);
    expect((active as FfmpegSource).currentLane()).toBe("hardware");
    expect(admittedGpu.open).toHaveBeenCalledOnce();
    pool.dispose();
  });
});
