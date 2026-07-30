// @vitest-environment jsdom
//
// SwTransport.test.ts — frame-message wrapping (NV12 → NativeNv12Frame,
// I420P10 → TenBitFrame) + streamId filter, `window.api.previewSw` faked. The
// transport must NOT reconstruct a `VideoFrame` (Chromium converts
// buffer-defined NV12 as BT.601 regardless of the stamped colorSpace — see
// nv12Frame.ts); frames wrap zero-copy and the Compositor converts them in
// its own ingest passes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isNativeNv12Frame, type NativeNv12Frame } from "../nv12Frame";
import { isTenBitFrame, type TenBitFrame } from "../tenBitFrame";
import { SwTransport } from "./SwTransport";

interface FakePreviewSwApi {
  open: ReturnType<typeof vi.fn>;
  requestFrameAt: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onFrame: ReturnType<typeof vi.fn>;
}

function installApi(): { api: FakePreviewSwApi; emit: (f: unknown) => void } {
  let onFrameCb: ((f: unknown) => void) | null = null;
  const api: FakePreviewSwApi = {
    open: vi.fn(async () => {}),
    requestFrameAt: vi.fn(() => {}),
    close: vi.fn(() => {}),
    onFrame: vi.fn((cb: (f: unknown) => void) => { onFrameCb = cb; return () => {}; }),
  };
  (window as unknown as { api: { previewSw: FakePreviewSwApi } }).api = { previewSw: api };
  return { api, emit: (f) => onFrameCb!(f) };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe("SwTransport", () => {
  it("wraps NV12 frames zero-copy as NativeNv12Frame for its stream and ignores foreign ones", async () => {
    const { emit } = installApi();
    const t = new SwTransport();
    const got: Array<{ frame: unknown; ptsUs: number; durUs: number }> = [];
    t.onFrame((frame, ptsUs, durUs) => got.push({ frame, ptsUs, durUs }));
    await t.open({ streamId: "s1", path: "C:/x.mov" });
    const nv12 = new Uint8Array(2 * 2 + 2); // 2x2 NV12 = 4 Y + 2 UV
    emit({ streamId: "s2", data: nv12, width: 2, height: 2, ptsUs: 5, durUs: 33 });
    emit({ streamId: "s1", data: nv12, width: 2, height: 2, ptsUs: 15, durUs: 33 });
    expect(got).toHaveLength(1);
    expect(got[0]!.ptsUs).toBe(15);
    const f = got[0]!.frame as NativeNv12Frame;
    expect(isNativeNv12Frame(f)).toBe(true);
    expect(f.data).toBe(nv12); // zero-copy adoption, no plane copy
    expect(f.width).toBe(2);
    expect(f.height).toBe(2);
    expect(f.uvOffset).toBe(4);
    expect(f.timestamp).toBe(15);
    expect(f.duration).toBe(33);
    t.dispose();
  });

  it("stamps the open-time sourceColor on frames, defaulting bt709/limited", async () => {
    const { emit } = installApi();
    const t = new SwTransport();
    const frames: NativeNv12Frame[] = [];
    t.onFrame((frame) => frames.push(frame as NativeNv12Frame));
    await t.open({ streamId: "s1", path: "C:/x.mov" });
    emit({ streamId: "s1", data: new Uint8Array(6), width: 2, height: 2, ptsUs: 0, durUs: 33 });
    expect(frames[0]!.colorSpace).toEqual({
      primaries: "bt709",
      transfer: "bt709",
      matrix: "bt709",
      fullRange: false,
    });
    t.dispose();

    // A 601-tagged source keeps its matrix — the ingest must not over-correct.
    const second = installApi();
    const t601 = new SwTransport();
    const frames601: NativeNv12Frame[] = [];
    t601.onFrame((frame) => frames601.push(frame as NativeNv12Frame));
    await t601.open({
      streamId: "s1",
      path: "C:/y.mov",
      sourceColor: { primaries: "smpte170m", transfer: "smpte170m", matrix: "smpte170m", fullRange: false },
    });
    second.emit({ streamId: "s1", data: new Uint8Array(6), width: 2, height: 2, ptsUs: 0, durUs: 33 });
    expect(frames601[0]!.colorSpace?.matrix).toBe("smpte170m");
    t601.dispose();
  });

  // Ticket 03 (issue #10): I420P10 frames — the 10-bit VideoToolbox-lane
  // sessions — dispatch on the MESSAGE's format tag into the existing ten-bit
  // adapter (`tenBitFrameFromBytes`), zero-copy, so both producers (WebCodecs
  // copyToTenBit and this transport) feed one consumer path (TenBitIngest).
  it("wraps I420P10 frames zero-copy as TenBitFrame via the existing ten-bit adapter", async () => {
    const { emit } = installApi();
    const t = new SwTransport({ lane: "videotoolbox", device: null }, undefined, undefined, "I420P10");
    const got: TenBitFrame[] = [];
    t.onFrame((frame) => got.push(frame as TenBitFrame));
    await t.open({ streamId: "s1", path: "/tmp/x.mov" });
    // 2x2 I420P10 = u16LE Y (4 samples) + U + V (1 sample each) = 12 bytes.
    const p10 = new Uint8Array(2 * 2 * 3);
    emit({ streamId: "s1", format: "I420P10", data: p10, width: 2, height: 2, ptsUs: 42, durUs: 33 });
    expect(got).toHaveLength(1);
    const f = got[0]!;
    expect(isTenBitFrame(f)).toBe(true);
    expect(f.data).toBe(p10); // zero-copy adoption, no plane copy
    expect(f.yOffset).toBe(0);
    expect(f.uOffset).toBe(8);
    expect(f.vOffset).toBe(10);
    expect(f.timestamp).toBe(42);
    // Open-time sourceColor default rides p10 frames too (bt709/limited).
    expect(f.colorSpace?.matrix).toBe("bt709");
    t.dispose();
  });

  it("an NV12-tagged frame on a p10 session still wraps as NativeNv12Frame (per-frame dispatch)", async () => {
    const { emit } = installApi();
    const t = new SwTransport({ lane: "videotoolbox", device: null }, undefined, undefined, "I420P10");
    const got: unknown[] = [];
    t.onFrame((frame) => got.push(frame));
    await t.open({ streamId: "s1", path: "/tmp/x.mov" });
    emit({ streamId: "s1", format: "NV12", data: new Uint8Array(6), width: 2, height: 2, ptsUs: 0, durUs: 33 });
    expect(got).toHaveLength(1);
    expect(isNativeNv12Frame(got[0])).toBe(true);
    t.dispose();
  });

  it("drops a layout-drifted I420P10 frame with a warning (the adapter THROWS, never truncates)", async () => {
    const { emit } = installApi();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = new SwTransport({ lane: "videotoolbox", device: null }, undefined, undefined, "I420P10");
    const got: number[] = [];
    t.onFrame((_f, ptsUs) => got.push(ptsUs));
    await t.open({ streamId: "s1", path: "/tmp/x.mov" });
    // 2x2 expects 12 bytes; 11 is a Rust-emitter/adapter layout drift.
    emit({ streamId: "s1", format: "I420P10", data: new Uint8Array(11), width: 2, height: 2, ptsUs: 0, durUs: 33 });
    expect(got).toEqual([]);
    expect(warn).toHaveBeenCalled();
    t.dispose();
  });

  it("drops a layout-drifted frame with a warning instead of crashing the stream", async () => {
    const { emit } = installApi();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = new SwTransport();
    const got: number[] = [];
    t.onFrame((_f, ptsUs) => got.push(ptsUs));
    await t.open({ streamId: "s1", path: "C:/x.mov" });
    emit({ streamId: "s1", data: new Uint8Array(5), width: 2, height: 2, ptsUs: 0, durUs: 33 }); // 6 expected
    expect(got).toEqual([]);
    expect(warn).toHaveBeenCalled();
    t.dispose();
  });

  it("forwards a hardware copy-back accel (lane + device) into the native open call", async () => {
    const { api } = installApi();
    // Linux VAAPI copy-back: decode on the GPU, frames still ship NV12 over this
    // same transport — the accel rides through on open().
    const t = new SwTransport({ lane: "vaapi", device: "/dev/dri/renderD128" });
    await t.open({ streamId: "s1", path: "/tmp/x.mov" });
    expect(api.open).toHaveBeenCalledWith({
      streamId: "s1",
      path: "/tmp/x.mov",
      lane: "vaapi",
      device: "/dev/dri/renderD128",
    });
    t.dispose();
  });

  it("forwards an NVDEC accel with a null device", async () => {
    const { api } = installApi();
    const t = new SwTransport({ lane: "nvdec", device: null });
    await t.open({ streamId: "s1", path: "/tmp/x.mov" });
    expect(api.open).toHaveBeenCalledWith({
      streamId: "s1",
      path: "/tmp/x.mov",
      lane: "nvdec",
      device: null,
    });
    t.dispose();
  });

  it("forwards a VideoToolbox accel with a null device (macOS, issue #10)", async () => {
    const { api } = installApi();
    const t = new SwTransport({ lane: "videotoolbox", device: null });
    await t.open({ streamId: "s1", path: "/tmp/x.mov" });
    expect(api.open).toHaveBeenCalledWith({
      streamId: "s1",
      path: "/tmp/x.mov",
      lane: "videotoolbox",
      device: null,
    });
    t.dispose();
  });

  it("forwards no lane/device on the software path (no accel)", async () => {
    const { api } = installApi();
    const t = new SwTransport();
    await t.open({ streamId: "s1", path: "C:/x.mov" });
    // Exact-match: the conditional spread must leave no lane/device keys behind.
    expect(api.open).toHaveBeenCalledWith({ streamId: "s1", path: "C:/x.mov" });
    t.dispose();
  });

  it("forwards outFormat only for an I420P10 session; NV12/absent stays today's payload", async () => {
    const { api } = installApi();
    const t = new SwTransport({ lane: "videotoolbox", device: null }, undefined, undefined, "I420P10");
    await t.open({ streamId: "s1", path: "/tmp/x.mov" });
    expect(api.open).toHaveBeenCalledWith({
      streamId: "s1",
      path: "/tmp/x.mov",
      lane: "videotoolbox",
      device: null,
      outFormat: "I420P10",
    });
    t.dispose();

    // An explicit NV12 and an absent format both leave the key off the wire —
    // the 8-bit open must stay byte-identical to today's.
    const second = installApi();
    const t8 = new SwTransport({ lane: "videotoolbox", device: null }, undefined, undefined, "NV12");
    await t8.open({ streamId: "s2", path: "/tmp/y.mp4" });
    expect(second.api.open).toHaveBeenCalledWith({
      streamId: "s2",
      path: "/tmp/y.mp4",
      lane: "videotoolbox",
      device: null,
    });
    t8.dispose();
  });

  it("forwards a playback-resolution divisor into the native open call", async () => {
    const { api } = installApi();
    const t = new SwTransport(undefined, 2);
    await t.open({ streamId: "s1", path: "C:/x.mov" });
    expect(api.open).toHaveBeenCalledWith({ streamId: "s1", path: "C:/x.mov", scaleDiv: 2 });
    t.dispose();

    // …and alongside a copy-back accel, which ships the same bytes over the
    // same IPC and wants the divisor just as much.
    const hw = installApi();
    const t4 = new SwTransport({ lane: "nvdec", device: null }, 4);
    await t4.open({ streamId: "s2", path: "/tmp/x.mov" });
    expect(hw.api.open).toHaveBeenCalledWith({
      streamId: "s2",
      path: "/tmp/x.mov",
      lane: "nvdec",
      device: null,
      scaleDiv: 4,
    });
    t4.dispose();
  });

  it("sends no divisor at full resolution, so an unscaled open is unchanged", async () => {
    // Absent AND an explicit 1 must both produce today's exact payload — 1 is
    // the wire default, and full resolution has to stay the untouched path.
    const { api } = installApi();
    const t = new SwTransport(undefined, 1);
    await t.open({ streamId: "s1", path: "C:/x.mov" });
    expect(api.open).toHaveBeenCalledWith({ streamId: "s1", path: "C:/x.mov" });
    t.dispose();
  });

  it("forwards a reduced output cadence only for an explicit spill profile", async () => {
    const { api } = installApi();
    const spilled = new SwTransport(undefined, 4, 2);
    await spilled.open({ streamId: "spill", path: "C:/4k.mp4" });
    expect(api.open).toHaveBeenCalledWith({
      streamId: "spill",
      path: "C:/4k.mp4",
      scaleDiv: 4,
      cadenceDiv: 2,
    });
    spilled.dispose();

    const ordinary = installApi();
    const fullCadence = new SwTransport(undefined, 4, 1);
    await fullCadence.open({ streamId: "ordinary", path: "C:/4k.mp4" });
    expect(ordinary.api.open).toHaveBeenCalledWith({
      streamId: "ordinary",
      path: "C:/4k.mp4",
      scaleDiv: 4,
    });
    fullCadence.dispose();
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
