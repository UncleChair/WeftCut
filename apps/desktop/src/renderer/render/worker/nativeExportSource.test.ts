// Unit tests for the native export-decode handle. They observe the handle at
// the `ExportDecodeSession` seam (the surface the export Worker drives) through
// a FAKE relay — no native component, no real VideoFrame pool. The point is to
// pin the two things unique to this handle:
//   1. the CREDIT-WINDOW accounting is exact (never a deficit that starves the
//      producer, never over-credit that unbounds memory), across every path a
//      frame can leave the ring (evict + the ring's own freeBehindWaiters); and
//   2. `decodeRange` is dispatch-then-return (awaiting frames would deadlock the
//      window), plus EOS clamp + error propagation reach the ring.
import { beforeAll, describe, expect, it } from "vitest";
import { NativeExportSourceHandle } from "./nativeExportSource";
import type { NativeDecodeRelayClient, NativeDecodeSink } from "./nativeDecodeRelay";
import type { NativeDecodeFrameMsg } from "./protocol";
import type { SourceHandleInit } from "../decoder/session";

// The handle wraps each NV12 buffer in a `VideoFrame`; node/vitest has none, so
// a plain stub stands in. The ring only reads timestamp/duration/close; the
// handle's firstFrameDiag reads colorSpace/format. No `kind` ⇒ 8-bit (not a
// TenBitFrame). We push with an explicit ptsUs, so `timestamp` is unused by the
// ring — kept only for shape fidelity.
beforeAll(() => {
  (globalThis as unknown as { VideoFrame: unknown }).VideoFrame = class {
    timestamp: number;
    duration: number;
    format: string;
    colorSpace: Record<string, unknown>;
    closed = false;
    constructor(_data: unknown, init: Record<string, unknown>) {
      this.timestamp = init.timestamp as number;
      this.duration = init.duration as number;
      this.format = init.format as string;
      this.colorSpace = (init.colorSpace as Record<string, unknown>) ?? {};
    }
    close() {
      this.closed = true;
    }
  };
});

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

function makeHandle(): { handle: NativeExportSourceHandle; relay: FakeRelay } {
  const relay = new FakeRelay();
  const init: SourceHandleInit = {
    layerId: "L0",
    mediaId: "m0",
    handleKey: "m0#0",
    proxyAssetUrl: "weftcut-media://ignored",
    nativeExport: { sourcePath: "C:/orig/tiny.mov", outFormat: "NV12", creditWindow: 6 },
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
    data: new ArrayBuffer((W * H * 3) / 2),
  };
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
