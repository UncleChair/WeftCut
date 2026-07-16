// Unit tests for the native export-decode handle. They observe the handle at
// the `ExportDecodeSession` seam (the surface the export Worker drives) through
// a FAKE relay — no native component, no real VideoFrame pool. The point is to
// pin the two things unique to this handle:
//   1. the CREDIT-WINDOW accounting is exact (never a deficit that starves the
//      producer, never over-credit that unbounds memory), across every path a
//      frame can leave the ring (evict + the ring's own freeBehindWaiters); and
//   2. `decodeRange` is dispatch-then-return (awaiting frames would deadlock the
//      window), plus EOS clamp + error propagation reach the ring.
import { describe, expect, it } from "vitest";
import { NativeExportSourceHandle } from "./nativeExportSource";
import type { NativeDecodeRelayClient, NativeDecodeSink } from "./nativeDecodeRelay";
import type { NativeDecodeFrameMsg } from "./protocol";
import type { SourceHandleInit } from "../decoder/session";
import { isNativeNv12Frame, nv12FrameFromBytes, type NativeNv12Frame } from "../decoder/nv12Frame";
import { isTenBitFrame, tenBitFrameFromBytes, type TenBitFrame } from "../decoder/tenBitFrame";

// No VideoFrame stub: the handle wraps BOTH lanes' bytes in CPU frame objects
// (NativeNv12Frame / TenBitFrame) — deliberately, because Chromium converts a
// buffer-defined NV12 `VideoFrame` as BT.601 regardless of its stamped
// colorSpace. A test that reintroduces `new VideoFrame` here is a regression.

/// A fake relay that captures the registered sink (so the test can inject
/// frames / control signals) and records every credit returned.
class FakeRelay {
  sink: NativeDecodeSink | null = null;
  decodeRanges: Array<{ sessionId: string; aUs: number; bUs: number }> = [];
  credits: number[] = [];
  closed: string[] = [];
  unregistered: string[] = [];
  openCalls: Array<{ sessionId: string; path: string }> = [];

  open(sessionId: string, path: string): Promise<{
    width: number;
    height: number;
    startPtsUs: number;
  }> {
    this.openCalls.push({ sessionId, path });
    return Promise.resolve({ width: 4, height: 2, startPtsUs: 0 });
  }
  decodeRange(sessionId: string, aUs: number, bUs: number): void {
    this.decodeRanges.push({ sessionId, aUs, bUs });
  }
  returnCredit(_sessionId: string, credits: number): void {
    this.credits.push(credits);
  }
  close(sessionId: string): void {
    this.closed.push(sessionId);
  }
  register(_sessionId: string, sink: NativeDecodeSink): void {
    this.sink = sink;
  }
  unregister(sessionId: string): void {
    this.unregistered.push(sessionId);
  }

  totalCredits(): number {
    return this.credits.reduce((a, b) => a + b, 0);
  }
}

const W = 4;
const H = 2;
const DUR = 33_333;

function makeHandle(
  sourceColor?: VideoColorSpaceInit,
  outFormat: "NV12" | "I420P10" = "NV12",
): {
  handle: NativeExportSourceHandle;
  relay: FakeRelay;
} {
  const relay = new FakeRelay();
  const init: SourceHandleInit = {
    layerId: "L0",
    mediaId: "m0",
    handleKey: "m0#0",
    proxyAssetUrl: "weftcut-media://ignored",
    nativeExport: { sourcePath: "C:/orig/tiny.mov", outFormat, creditWindow: 6 },
    ...(sourceColor ? { sourceColor } : {}),
  };
  const handle = new NativeExportSourceHandle(init, relay as unknown as NativeDecodeRelayClient);
  return { handle, relay };
}

function frameMsg(ptsUs: number): NativeDecodeFrameMsg {
  return {
    sessionId: "s",
    ptsUs,
    durUs: DUR,
    width: W,
    height: H,
    format: "NV12",
    data: new ArrayBuffer((W * H * 3) / 2),
  };
}

// Tightly-packed I420P10 (u16LE): Y (w*h*2) + U + V ((w>>1)*(h>>1)*2 each).
const P10_BYTES = W * H * 2 + 2 * ((W >> 1) * (H >> 1) * 2);

function p10Msg(ptsUs: number, data = new ArrayBuffer(P10_BYTES)): NativeDecodeFrameMsg {
  return { ...frameMsg(ptsUs), format: "I420P10", data };
}

describe("NativeExportSourceHandle", () => {
  it("opens the ORIGINAL path once on ensureReady", async () => {
    const { handle, relay } = makeHandle();
    await handle.ensureReady();
    await handle.ensureReady(); // memoized — no second open
    expect(relay.openCalls).toHaveLength(1);
    expect(relay.openCalls[0]!.path).toBe("C:/orig/tiny.mov");
  });

  it("decodeRange dispatches and resolves without awaiting frames (no window deadlock)", async () => {
    const { handle, relay } = makeHandle();
    // Never inject a frame or rangeEnd; the promise must still resolve.
    await handle.decodeRange(0, 100_000);
    expect(relay.decodeRanges).toEqual([{ sessionId: expect.any(String), aUs: 0, bUs: 100_000 }]);
  });

  it("holds frames with no credit while resident, credits them on evict", async () => {
    const { handle, relay } = makeHandle();
    await handle.ensureReady();
    const sink = relay.sink!;
    for (let i = 0; i < 4; i++) sink.onFrame(frameMsg(i * DUR));
    // All 4 resident ⇒ nothing departed ⇒ no credit yet.
    expect(handle.ring.size()).toBe(4);
    expect(relay.totalCredits()).toBe(0);
    // Evict past the first two intervals ([0,DUR) and [DUR,2·DUR)).
    handle.evictBefore(2 * DUR);
    expect(handle.ring.size()).toBe(2);
    expect(relay.totalCredits()).toBe(2); // exactly the departed count
  });

  it("keeps credits exact across the ring's freeBehindWaiters path (no deficit)", async () => {
    const { handle, relay } = makeHandle();
    await handle.ensureReady();
    const sink = relay.sink!;
    sink.onFrame(frameMsg(0));
    sink.onFrame(frameMsg(DUR));
    // Park a waiter far ahead: freeBehindWaiters drops frame 0 (below the
    // waiter, keeping its lower neighbour) WITHOUT going through evictBefore.
    const waiting = handle.ring.waitForPts(100 * DUR);
    // A later frame satisfies the waiter (strictly-later PTS) and the next
    // onFrame reconcile credits the frame freeBehindWaiters removed.
    sink.onFrame(frameMsg(101 * DUR));
    await waiting;
    // Invariant: credits returned == frames that have left the ring. Never a
    // deficit (starves the producer) nor an over-credit (unbounds memory).
    expect(relay.totalCredits()).toBe(handle["framesPushed"] - handle.ring.size());
    // In-flight (pushed − credited) equals what is still resident.
    const inFlight = handle["framesPushed"] - relay.totalCredits();
    expect(inFlight).toBe(handle.ring.size());
  });

  it("stamps frames with the mapped sourceColor, never the raw ffmpeg tag names", async () => {
    // Per-frame tags are raw FFmpeg `.name()` strings (bt2020nc/smpte2084/…),
    // NOT WebCodecs enum members — the ingest shaders' coefForMatrix matches
    // WebCodecs enums only. The handle must stamp the already-mapped
    // `init.sourceColor` with the bt709/limited fallback, mirroring the
    // preview native path (SwTransport.colorSpaceFor).
    const { handle, relay } = makeHandle({ matrix: "bt470bg", fullRange: true });
    await handle.ensureReady();
    relay.sink!.onFrame({
      ...frameMsg(0),
      colorMatrix: "bt2020nc",
      colorPrimaries: "bt2020",
      colorTransfer: "smpte2084",
      colorRange: "tv",
    });
    expect(handle.firstFrameDiag?.configColor).toEqual({
      matrix: "bt470bg",
      primaries: "bt709",
      transfer: "bt709",
      fullRange: true,
    });
  });

  it("falls back to bt709/limited when the source has no mapped color", async () => {
    const { handle, relay } = makeHandle();
    await handle.ensureReady();
    relay.sink!.onFrame(frameMsg(0));
    expect(handle.firstFrameDiag?.configColor).toEqual({
      matrix: "bt709",
      primaries: "bt709",
      transfer: "bt709",
      fullRange: false,
    });
  });

  it("a backward decodeRange deactivates the ring's EOS clamp", async () => {
    // After EOS the ring clamps any wait target to the last held frame. A
    // backward clip-reuse jump re-arms the Rust session (frames WILL arrive
    // again), so the clamp must deactivate — else waitForPts hands a stale
    // frame to the consumer while the re-decoded one is still in flight.
    const { handle, relay } = makeHandle();
    await handle.decodeRange(1_000_000, 2_000_000);
    const sink = relay.sink!;
    sink.onFrame(frameMsg(1_000_000));
    sink.onEnded();
    // Clamp active: an overrun target resolves against the held frame.
    await expect(handle.ring.waitForPts(5_000_000)).resolves.toBeUndefined();
    // Backward jump: the clamp must deactivate…
    await handle.decodeRange(0, 500_000);
    let resolved = false;
    const wait = handle.ring.waitForPts(5_000_000).then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false); // …so the wait parks instead of clamping…
    sink.onFrame(frameMsg(6_000_000)); // …until a real frame satisfies it.
    await wait;
    expect(resolved).toBe(true);
  });

  it("clamps grid-overrun waiters to the last held frame on EOS", async () => {
    const { handle, relay } = makeHandle();
    await handle.ensureReady();
    const sink = relay.sink!;
    sink.onFrame(frameMsg(0));
    sink.onEnded();
    // A target far past the last frame's interval still resolves (clamp), so a
    // composition grid overrunning the video track's end can't hang the export.
    await expect(handle.ring.waitForPts(1_000_000)).resolves.toBeUndefined();
  });

  it("propagates a native error by failing the ring", async () => {
    const { handle, relay } = makeHandle();
    await handle.ensureReady();
    relay.sink!.onError("decoder exploded");
    await expect(handle.ring.waitForPts(0)).rejects.toThrow("decoder exploded");
  });

  it("dispose tears down the session and stops crediting", async () => {
    const { handle, relay } = makeHandle();
    await handle.ensureReady();
    const sink = relay.sink!;
    sink.onFrame(frameMsg(0));
    handle.dispose();
    expect(relay.closed).toContain(handle["sessionId"]);
    expect(relay.unregistered).toContain(handle["sessionId"]);
    expect(handle.disposed).toBe(true);
    const before = relay.totalCredits();
    handle.evictBefore(10 * DUR); // reconcile must no-op after dispose
    expect(relay.totalCredits()).toBe(before);
    handle.dispose(); // idempotent
    expect(relay.closed).toHaveLength(1);
  });
});

describe("tenBitFrameFromBytes", () => {
  it("wraps the SAME bytes with copyToTenBit's plane offsets (zero-copy)", () => {
    const data = new Uint8Array(P10_BYTES);
    const f = tenBitFrameFromBytes({
      data,
      width: W,
      height: H,
      timestamp: 5,
      duration: 10,
      colorSpace: { matrix: "bt709" },
    });
    expect(f.kind).toBe("p10");
    expect(isTenBitFrame(f)).toBe(true);
    expect(f.width).toBe(W);
    expect(f.height).toBe(H);
    expect(f.yOffset).toBe(0);
    expect(f.uOffset).toBe(W * H * 2);
    expect(f.vOffset).toBe(W * H * 2 + (W >> 1) * (H >> 1) * 2);
    // Zero-copy: the frame views the caller's bytes, not a duplicate.
    expect(f.data).toBe(data);
    expect(f.timestamp).toBe(5);
    expect(f.duration).toBe(10);
    expect(f.colorSpace).toEqual({ matrix: "bt709" });
    expect(() => f.close()).not.toThrow(); // uniform-shape no-op, like copyToTenBit
  });

  it("throws loudly on a byteLength that doesn't match the layout (Rust/TS drift)", () => {
    expect(() =>
      tenBitFrameFromBytes({
        data: new Uint8Array(P10_BYTES - 2),
        width: W,
        height: H,
        timestamp: 0,
        duration: null,
        colorSpace: null,
      }),
    ).toThrow(/I420P10/);
  });
});

describe("NativeExportSourceHandle — I420P10 lane", () => {
  it("pushes a zero-copy TenBitFrame (no VideoFrame round-trip) with the stamped color", async () => {
    const { handle, relay } = makeHandle({ matrix: "bt470bg", fullRange: true }, "I420P10");
    await handle.ensureReady();
    const bytes = new ArrayBuffer(P10_BYTES);
    relay.sink!.onFrame(p10Msg(0, bytes));
    expect(handle.ring.size()).toBe(1);
    const f = handle.ring.frameAt(0);
    expect(isTenBitFrame(f)).toBe(true);
    const tb = f as TenBitFrame;
    expect(tb.width).toBe(W);
    expect(tb.height).toBe(H);
    expect(tb.yOffset).toBe(0);
    expect(tb.uOffset).toBe(W * H * 2);
    expect(tb.vOffset).toBe(W * H * 2 + (W >> 1) * (H >> 1) * 2);
    // Zero-copy: the ring's frame views the TRANSFERRED buffer itself.
    expect(tb.data.buffer).toBe(bytes);
    expect(tb.timestamp).toBe(0);
    expect(tb.duration).toBe(DUR);
    // Same mapped-sourceColor stamp as the NV12 branch (bt709/limited fallback).
    expect(tb.colorSpace).toEqual({
      matrix: "bt470bg",
      primaries: "bt709",
      transfer: "bt709",
      fullRange: true,
    });
    expect(handle.firstFrameDiag?.frameFormat).toBe("I420P10");
  });

  it("returns credits for 10-bit frames on evict exactly like NV12", async () => {
    const { handle, relay } = makeHandle(undefined, "I420P10");
    await handle.ensureReady();
    const sink = relay.sink!;
    for (let i = 0; i < 4; i++) sink.onFrame(p10Msg(i * DUR));
    expect(relay.totalCredits()).toBe(0);
    handle.evictBefore(2 * DUR);
    expect(handle.ring.size()).toBe(2);
    expect(relay.totalCredits()).toBe(2);
  });

  it("fails the ring loudly on a byteLength that doesn't match the layout", async () => {
    const { handle, relay } = makeHandle(undefined, "I420P10");
    await handle.ensureReady();
    relay.sink!.onFrame(p10Msg(0, new ArrayBuffer(P10_BYTES - 2)));
    await expect(handle.ring.waitForPts(0)).rejects.toThrow(/I420P10/);
  });

  it("fails the ring when a frame's format contradicts the session's outFormat", async () => {
    const { handle, relay } = makeHandle(undefined, "NV12");
    await handle.ensureReady();
    relay.sink!.onFrame(p10Msg(0)); // I420P10 frame into an NV12 session
    await expect(handle.ring.waitForPts(0)).rejects.toThrow(/I420P10/);
  });
});

// Tightly-packed NV12: Y (w*h) + interleaved CbCr (w*(h>>1)).
const NV12_BYTES = W * H + W * (H >> 1);

describe("nv12FrameFromBytes", () => {
  it("wraps the SAME bytes zero-copy with the interleaved-UV offset", () => {
    const data = new Uint8Array(NV12_BYTES);
    const f = nv12FrameFromBytes({
      data,
      width: W,
      height: H,
      timestamp: 5,
      duration: 10,
      colorSpace: { matrix: "bt709" },
    });
    expect(f.kind).toBe("nv12");
    expect(isNativeNv12Frame(f)).toBe(true);
    expect(f.width).toBe(W);
    expect(f.height).toBe(H);
    expect(f.uvOffset).toBe(W * H);
    // Zero-copy: the frame views the caller's bytes, not a duplicate.
    expect(f.data).toBe(data);
    expect(f.timestamp).toBe(5);
    expect(f.duration).toBe(10);
    expect(f.colorSpace).toEqual({ matrix: "bt709" });
    expect(() => f.close()).not.toThrow(); // uniform-shape no-op, like TenBitFrame
  });

  it("throws loudly on a byteLength that doesn't match the layout (Rust/TS drift)", () => {
    expect(() =>
      nv12FrameFromBytes({
        data: new Uint8Array(NV12_BYTES - 1),
        width: W,
        height: H,
        timestamp: 0,
        duration: null,
        colorSpace: null,
      }),
    ).toThrow(/NV12/);
  });
});

describe("NativeExportSourceHandle — NV12 lane", () => {
  it("pushes a zero-copy NativeNv12Frame (NO VideoFrame) stamped bt709/limited by default", async () => {
    const { handle, relay } = makeHandle();
    await handle.ensureReady();
    const bytes = new ArrayBuffer(NV12_BYTES);
    relay.sink!.onFrame({ ...frameMsg(0), data: bytes });
    expect(handle.ring.size()).toBe(1);
    const f = handle.ring.frameAt(0);
    // The crux of the 601-tint fix: the ring holds OUR CPU frame kind, which
    // the Compositor routes to Nv12Ingest — never a buffer-defined VideoFrame
    // (whose Chromium software conversion runs BT.601 regardless of the tag).
    expect(isNativeNv12Frame(f)).toBe(true);
    const nv = f as NativeNv12Frame;
    expect(nv.width).toBe(W);
    expect(nv.height).toBe(H);
    expect(nv.uvOffset).toBe(W * H);
    // Zero-copy: the ring's frame views the TRANSFERRED buffer itself.
    expect(nv.data.buffer).toBe(bytes);
    expect(nv.timestamp).toBe(0);
    expect(nv.duration).toBe(DUR);
    expect(nv.colorSpace).toEqual({
      matrix: "bt709",
      primaries: "bt709",
      transfer: "bt709",
      fullRange: false,
    });
    expect(handle.firstFrameDiag?.frameFormat).toBe("NV12");
    expect(handle.firstFrameDiag?.frameColor).toEqual(nv.colorSpace);
  });

  it("carries a 601-tagged source's matrix so the ingest selects BT.601", async () => {
    const { handle, relay } = makeHandle({
      matrix: "smpte170m",
      primaries: "smpte170m",
      transfer: "smpte170m",
      fullRange: false,
    });
    await handle.ensureReady();
    relay.sink!.onFrame(frameMsg(0));
    const nv = handle.ring.frameAt(0) as NativeNv12Frame;
    expect(nv.colorSpace?.matrix).toBe("smpte170m");
    expect(nv.colorSpace?.fullRange).toBe(false);
  });

  it("fails the ring loudly on a byteLength that doesn't match the layout", async () => {
    const { handle, relay } = makeHandle();
    await handle.ensureReady();
    relay.sink!.onFrame({ ...frameMsg(0), data: new ArrayBuffer(NV12_BYTES - 1) });
    await expect(handle.ring.waitForPts(0)).rejects.toThrow(/NV12/);
  });
});
