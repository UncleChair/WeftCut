import { describe, it, expect } from "vitest";
import {
  decideReset,
  PacketPump,
  type PumpDecoder,
  type PumpPacket,
  type PumpPacketSink,
  type PumpRing,
} from "./PacketPump";

// ADR 0003, re-keyed to microseconds. The decision is purely a function
// of the playhead target, the pump's decoded frontier, and the ring's
// oldest cached PTS. All times are µs.
describe("decideReset", () => {
  it("continuous forward play: no reset (frontier ahead of playhead)", () => {
    // playhead 500ms, decoded frontier 900ms, ring from 0.
    expect(
      decideReset({ targetUs: 500_000, lastDecodedPtsUs: 900_000, ringFirstPtsUs: 0 }),
    ).toBe(false);
  });

  it("forward GOP-crossing: no reset (the new GOP flows in-stream)", () => {
    // playhead 1.1s just past a 1s-GOP boundary; frontier 1.4s; ring from 600ms.
    expect(
      decideReset({ targetUs: 1_100_000, lastDecodedPtsUs: 1_400_000, ringFirstPtsUs: 600_000 }),
    ).toBe(false);
  });

  it("far-forward seek: reset (target > one lookahead window past frontier)", () => {
    // jump to 5s while the frontier is at 1s → 4s gap > 1s window.
    expect(
      decideReset({ targetUs: 5_000_000, lastDecodedPtsUs: 1_000_000, ringFirstPtsUs: 500_000 }),
    ).toBe(true);
  });

  it("backward beyond ring: reset (target older than oldest cached frame)", () => {
    // seek back to 100ms; lookbehind only still holds from 600ms.
    expect(
      decideReset({ targetUs: 100_000, lastDecodedPtsUs: 1_500_000, ringFirstPtsUs: 600_000 }),
    ).toBe(true);
  });

  it("paused lookahead-fill: no reset (the regression the comments warn about)", () => {
    // playhead HELD at 500ms; the pump advanced the frontier to 1.4s
    // filling lookahead; ring from 0. target - frontier is NEGATIVE.
    expect(
      decideReset({ targetUs: 500_000, lastDecodedPtsUs: 1_400_000, ringFirstPtsUs: 0 }),
    ).toBe(false);
  });

  it("backward check is skipped when the ring is empty", () => {
    // ringFirstPtsUs null → only the far-forward arm can fire.
    expect(
      decideReset({ targetUs: 100_000, lastDecodedPtsUs: 200_000, ringFirstPtsUs: null }),
    ).toBe(false);
  });
});

// --- Test harness: fully synchronous fakes with manual await control ---

/// Drains the microtask queue (a real-timer macrotask flushes all pending
/// microtasks). One `await tick()` advances the pump past exactly one
/// `await` hop, since each hop resolves via microtasks.
const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

function makePacket(tsSeconds: number): PumpPacket {
  return {
    timestamp: tsSeconds,
    // The pump only passes this through to the (fake) decoder; the chunk
    // is never inspected, so a tagged stub stands in for EncodedVideoChunk.
    toEncodedVideoChunk: () => ({ _ts: tsSeconds } as unknown as EncodedVideoChunk),
  };
}

function makeFakeDecoder(): PumpDecoder & { decoded: PumpPacket[]; resets: number; configures: number } {
  let queue = 0;
  return {
    decoded: [] as PumpPacket[],
    resets: 0,
    configures: 0,
    state: "configured",
    decode(chunk: EncodedVideoChunk) {
      // Record the original packet via its tag for assertions.
      this.decoded.push(makePacket((chunk as unknown as { _ts: number })._ts));
      queue += 1;
    },
    reset() {
      this.resets += 1;
      queue = 0;
    },
    configure() {
      this.configures += 1;
    },
    flush() {
      queue = 0;
      return Promise.resolve();
    },
    get decodeQueueSize() {
      return queue;
    },
  };
}

/// A packet sink whose `getNextPacket` HANGS until the test releases it,
/// giving deterministic control over each await hop. `getKeyPacket`
/// resolves immediately to the single key at t=0.
class GatedSink implements PumpPacketSink {
  getKeyCalls: number[] = [];
  private pending: Array<(p: PumpPacket | null) => void> = [];
  private key = makePacket(0);

  async getKeyPacket(tsSeconds: number): Promise<PumpPacket | null> {
    this.getKeyCalls.push(tsSeconds);
    return this.key;
  }

  getNextPacket(_pkt: PumpPacket): Promise<PumpPacket | null> {
    return new Promise<PumpPacket | null>((resolve) => {
      this.pending.push(resolve);
    });
  }

  /// Number of getNextPacket calls currently awaiting resolution.
  inFlight(): number {
    return this.pending.length;
  }

  /// Resolve the oldest in-flight getNextPacket with the given packet
  /// (or null for end-of-stream).
  release(pkt: PumpPacket | null): void {
    const r = this.pending.shift();
    if (r) r(pkt);
  }
}

class FakeRing implements PumpRing {
  anchorUs = 0;
  full = false;
  flushes = 0;
  first: number | null = null;
  setAnchor(tUs: number): void {
    this.anchorUs = tUs;
  }
  isLookaheadFull(): boolean {
    return this.full;
  }
  flush(): void {
    this.flushes += 1;
    this.first = null;
  }
  firstPtsUs(): number | null {
    return this.first;
  }
}

describe("PacketPump", () => {
  it("is single-flight: re-entrant requestFrameAt never starts a 2nd loop", async () => {
    const sink = new GatedSink();
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({ decoder: dec, packetSink: sink, ring });

    pump.requestFrameAt(0); // cold start: getKeyPacket → decode key → await getNextPacket
    await tick();
    expect(sink.inFlight()).toBe(1);

    // Two more ticks while the single pump is parked on getNextPacket.
    pump.requestFrameAt(33_000);
    pump.requestFrameAt(66_000);
    await tick();
    expect(sink.inFlight()).toBe(1); // still ONE — proves single-flight
  });

  it("cold start seeks to the key and decodes it without a reset", async () => {
    const sink = new GatedSink();
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({ decoder: dec, packetSink: sink, ring });

    pump.requestFrameAt(0);
    await tick();
    expect(dec.decoded.length).toBe(1); // the key packet
    expect(dec.resets).toBe(0); // cold start ≠ reset
    expect(ring.flushes).toBe(0);
    expect(sink.getKeyCalls).toEqual([0]);
  });

  it("far-forward seek resets exactly once and re-seeks the key", async () => {
    const sink = new GatedSink();
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({ decoder: dec, packetSink: sink, ring });

    pump.requestFrameAt(0);
    await tick(); // key decoded, frontier 0, awaiting getNextPacket
    sink.release(makePacket(0.5));
    await tick(); // delta @0.5s decoded, frontier 500ms, awaiting next
    expect(dec.resets).toBe(0);

    pump.requestFrameAt(5_000_000); // far-forward (5s)
    sink.release(makePacket(0.6)); // in-flight resolves → loop top sees the seek
    await tick();

    expect(dec.resets).toBe(1);
    expect(ring.flushes).toBe(1);
    expect(sink.getKeyCalls).toContain(5); // sought to 5s
  });

  it("backward seek beyond the ring resets", async () => {
    const sink = new GatedSink();
    const ring = new FakeRing();
    ring.first = 600_000; // ring only holds from 600ms
    const dec = makeFakeDecoder();
    const pump = new PacketPump({ decoder: dec, packetSink: sink, ring });

    pump.requestFrameAt(1_000_000); // cold start near 1s
    await tick();
    expect(dec.resets).toBe(0);

    pump.requestFrameAt(100_000); // backward to 100ms < ring.first(600ms)
    sink.release(makePacket(1.1)); // resolve in-flight; loop top sees the seek
    await tick();
    expect(dec.resets).toBe(1);
  });

  it("paused lookahead-fill never resets despite frontier >> playhead", async () => {
    const sink = new GatedSink();
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({ decoder: dec, packetSink: sink, ring });

    pump.requestFrameAt(500_000); // playhead held at 500ms
    await tick();
    sink.release(makePacket(0.7));
    await tick();
    sink.release(makePacket(1.0));
    await tick();
    sink.release(makePacket(1.4)); // frontier now 1.4s, far ahead of 500ms
    await tick();

    pump.requestFrameAt(500_000); // still 500ms (paused)
    sink.release(makePacket(1.5));
    await tick();

    expect(dec.resets).toBe(0);
    expect(ring.flushes).toBe(0);
  });

  it("dispose during an await drops further decodes", async () => {
    const sink = new GatedSink();
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({ decoder: dec, packetSink: sink, ring });

    pump.requestFrameAt(0);
    await tick(); // key decoded, awaiting getNextPacket
    const before = dec.decoded.length;

    pump.dispose();
    sink.release(makePacket(0.1)); // resolve the in-flight await AFTER dispose
    await tick();

    expect(dec.decoded.length).toBe(before); // post-await `_disposed` guard bailed
  });

  it("rebuild (invalidateCursor) during an await does not resurrect the cursor", async () => {
    // The WebCodecs error callback fires mid-await and calls
    // invalidateCursor (decoder rebuild). The in-flight getNextPacket
    // continuation MUST NOT write the resolved packet back into `cursor`,
    // or the next pass feeds a delta into the fresh decoder instead of
    // cold-starting at a key — the bug that breaks software-downgrade
    // recovery. The generation guard makes the continuation bail.
    const sink = new GatedSink();
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({ decoder: dec, packetSink: sink, ring });

    pump.requestFrameAt(0);
    await tick(); // cold start: getKeyPacket(0), key decoded, awaiting getNextPacket
    sink.release(makePacket(0.1)); // cursor advances; re-park on getNextPacket
    await tick();
    expect(sink.getKeyCalls.length).toBe(1);

    pump.invalidateCursor(); // simulate the error-callback rebuild mid-await
    sink.release(makePacket(0.2)); // in-flight getNextPacket resolves AFTER invalidate
    await tick();

    // cursor must be null → the next request cold-starts (re-seeks a key).
    pump.requestFrameAt(0);
    await tick();
    expect(sink.getKeyCalls.length).toBe(2); // re-sought a key; cursor was NOT resurrected
  });
});
