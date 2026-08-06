import { describe, it, expect } from "vitest";
import {
  decideReset,
  MAX_QUEUE,
  PacketPump,
  type PumpDecoder,
  type PumpPacket,
  type PumpPacketSink,
  type PumpRing,
} from "./PacketPump";
import { DecodeClock } from "./decodeClock";

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
  const timestampUs = Math.trunc(tsSeconds * 1e6);
  return {
    timestamp: tsSeconds,
    microsecondTimestamp: timestampUs,
    // The pump only passes this through to the (fake) decoder; the chunk
    // is never inspected, so a tagged stub stands in for EncodedVideoChunk.
    toEncodedVideoChunk: () => ({
      _ts: tsSeconds,
      timestamp: timestampUs,
    }) as unknown as EncodedVideoChunk,
  };
}

function makeFakeDecoder(): PumpDecoder & {
  decoded: PumpPacket[];
  resets: number;
  configures: number;
  /// Simulates the real `VideoDecoder`'s async output callback freeing
  /// queue slots over time. The fake never drains on its own (there's no
  /// output side), so tests that need multiple fill passes past MAX_QUEUE
  /// backpressure call this between kicks.
  drain(n: number): void;
} {
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
    drain(n: number) {
      queue = Math.max(0, queue - n);
    },
    get decodeQueueSize() {
      return queue;
    },
  };
}

/// A synthetic long-GOP source: a single key packet at t=0 followed by
/// delta packets at a fixed cadence out to `maxSeconds`, all resolving
/// immediately (no gating) so the pump's fill loop can race through many
/// packets within a single microtask-draining `await tick()`. Models the
/// decode-bench repro fixture: a keyframe far before a requested target.
class SequentialSink implements PumpPacketSink {
  getKeyCalls: number[] = [];

  constructor(
    private readonly stepSeconds: number,
    private readonly maxSeconds: number,
  ) {}

  async getKeyPacket(tsSeconds: number): Promise<PumpPacket | null> {
    this.getKeyCalls.push(tsSeconds);
    return makePacket(0); // the GOP's single key sits at t=0, regardless of target
  }

  async getFirstPacket(): Promise<PumpPacket | null> {
    return makePacket(0);
  }

  async getNextPacket(pkt: PumpPacket): Promise<PumpPacket | null> {
    const next = pkt.timestamp + this.stepSeconds;
    return next > this.maxSeconds ? null : makePacket(next);
  }
}

/// A source with REAL GOP structure: a key every `gopSeconds`, so
/// `getKeyPacket` returns a *different* key for a target in a different GOP.
/// `SequentialSink` deliberately models the opposite (one key for the whole
/// source), and the two cases take opposite branches of the reset decision —
/// same-GOP far-forward must keep decoding, later-GOP far-forward must jump.
class GopSink implements PumpPacketSink {
  getKeyCalls: number[] = [];

  constructor(private readonly gopSeconds: number) {}

  async getKeyPacket(tsSeconds: number): Promise<PumpPacket | null> {
    this.getKeyCalls.push(tsSeconds);
    return makePacket(Math.floor(tsSeconds / this.gopSeconds) * this.gopSeconds);
  }

  async getFirstPacket(): Promise<PumpPacket | null> {
    return makePacket(0);
  }

  async getNextPacket(pkt: PumpPacket): Promise<PumpPacket | null> {
    return makePacket(pkt.timestamp + 0.033);
  }
}

/// A packet sink whose `getNextPacket` HANGS until the test releases it,
/// giving deterministic control over each await hop. `getKeyPacket`
/// resolves immediately to the single key at t=0.
class GatedSink implements PumpPacketSink {
  getKeyCalls: number[] = [];
  getFirstCalls = 0;
  private pending: Array<(p: PumpPacket | null) => void> = [];

  constructor(private key = makePacket(0)) {}

  async getKeyPacket(tsSeconds: number): Promise<PumpPacket | null> {
    this.getKeyCalls.push(tsSeconds);
    return this.key;
  }

  async getFirstPacket(): Promise<PumpPacket | null> {
    this.getFirstCalls += 1;
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

  it("maps normalized source time to container PTS for non-zero media starts", async () => {
    const sourceStartPtsUs = 299_674;
    const sink = new GatedSink(makePacket(sourceStartPtsUs / 1e6));
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({
      decoder: dec,
      packetSink: sink,
      ring,
      decodeClock: DecodeClock.fromOrigin(sourceStartPtsUs),
    });

    pump.requestFrameAt(0);
    await tick();

    expect(sink.getKeyCalls).toEqual([sourceStartPtsUs / 1e6]);
    expect(dec.decoded.map((p) => p.timestamp)).toEqual([sourceStartPtsUs / 1e6]);
  });

  it("uses the chunk timestamp as the decode frontier at a non-zero origin", async () => {
    // Exact packet time is 2/30 s = 66,666.666… µs. Mediabunny dispatches a
    // chunk timestamp of 66,666, while the old `round(seconds * 1e6)` frontier
    // became source PTS +1. Put the next target exactly across the 1 s reset
    // threshold so that one-microsecond disagreement is externally visible.
    const key = {
      timestamp: 2 / 30,
      microsecondTimestamp: 66_666,
      toEncodedVideoChunk: () => ({
        _ts: 2 / 30,
        timestamp: 66_666,
      }) as unknown as EncodedVideoChunk,
    } as PumpPacket;
    const sink = new GatedSink(key);
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({
      decoder: dec,
      packetSink: sink,
      ring,
      decodeClock: DecodeClock.fromOrigin(66_666),
    });

    pump.requestFrameAt(0);
    await tick(); // key decoded, frontier must be source PTS 0

    pump.requestFrameAt(1_000_001);
    sink.release(null); // end the in-flight fill so the new target is evaluated
    await tick();

    // The observable is the KEY LOOKUP, not a reset: this target is far-forward
    // of the frontier, so the pump asks for its key — and then finds it is the
    // key it is already decoding from and declines to re-seek (see the
    // same-GOP test below). A frontier of +1 instead of 0 would leave the gap at
    // exactly 1_000_000, not past it, and there would be no second lookup at all.
    expect(sink.getKeyCalls).toHaveLength(2);
    expect(dec.resets).toBe(0);
  });

  it("falls back to the first packet when the normalized start precedes the first key", async () => {
    const sourceStartPtsUs = 299_674;
    const key = makePacket(sourceStartPtsUs / 1e6);
    const sink: PumpPacketSink & { getKeyCalls: number[]; getFirstCalls: number } = {
      getKeyCalls: [],
      getFirstCalls: 0,
      async getKeyPacket(tsSeconds: number): Promise<PumpPacket | null> {
        this.getKeyCalls.push(tsSeconds);
        return null;
      },
      async getFirstPacket(): Promise<PumpPacket | null> {
        this.getFirstCalls += 1;
        return key;
      },
      getNextPacket(): Promise<PumpPacket | null> {
        return new Promise(() => undefined);
      },
    };
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({
      decoder: dec,
      packetSink: sink,
      ring,
      decodeClock: DecodeClock.fromOrigin(sourceStartPtsUs),
    });

    pump.requestFrameAt(0);
    await tick();

    expect(sink.getKeyCalls).toEqual([sourceStartPtsUs / 1e6]);
    expect(sink.getFirstCalls).toBe(1);
    expect(dec.decoded.map((p) => p.timestamp)).toEqual([sourceStartPtsUs / 1e6]);
  });

  it("a far-forward seek INSIDE the current GOP keeps decoding forward — no reset, no flush", async () => {
    // The target is 5 s ahead, but its key packet is the one already being
    // decoded from. Resetting there would rewind the frontier to that key and
    // discard the prefix already decoded, to arrive at the same place by a
    // longer route. So the pump asks for the key, recognises it, and presses on.
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

    expect(sink.getKeyCalls).toContain(5); // it DID look the key up
    expect(dec.resets).toBe(0); // …and declined to re-seek to a key it is past
    expect(ring.flushes).toBe(0); // nothing thrown away

    // And it must genuinely press on rather than park: the mid-fill re-check
    // sees the same far-forward condition every pass and must not wedge.
    expect(sink.inFlight()).toBe(1); // parked on a genuine forward getNextPacket
    sink.release(makePacket(0.7));
    await tick();
    expect(dec.resets).toBe(0);
    expect(dec.decoded.at(-1)?.timestamp).toBe(0.7); // frontier still advancing
  });

  it("repeated same-target kicks while far behind never re-seek or flush", async () => {
    // Long-GOP source: one key at t=0, deltas every ~33ms out to 20s.
    const sink = new SequentialSink(0.033, 20);
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({ decoder: dec, packetSink: sink, ring });

    pump.requestFrameAt(0);
    await tick(); // cold start; fill loop runs to MAX_QUEUE from t=0

    const target = 5_000_000;
    pump.requestFrameAt(target); // far-forward, same GOP → keep going forward
    await tick();
    expect(dec.resets).toBe(0);

    const decodedBefore = dec.decoded.length;
    // Repeat the SAME target several times, simulating the Compositor's
    // per-tick nudge plus the decoder's async output callback freeing
    // queue slots. The far-forward condition stays true throughout (the key
    // sits >1 s before the target); the pump must keep filling regardless.
    for (let i = 0; i < 5; i++) {
      dec.drain(MAX_QUEUE);
      pump.requestFrameAt(target);
      await tick();
    }

    expect(dec.resets).toBe(0);
    expect(ring.flushes).toBe(0);
    expect(dec.decoded.length).toBeGreaterThan(decodedBefore); // decode kept progressing
  });

  it("a MOVING target while far behind never re-seeks or flushes — the playback livelock", async () => {
    // THE regression this guards: a target that moves every frame must not
    // re-fire the far-forward arm, reset the decoder and re-seek the SAME key
    // pass after pass. Why the latch is keyed on the key packet rather than the
    // target: `seekedKeyTimestamp` in PacketPump.ts.
    const sink = new SequentialSink(0.033, 60);
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({ decoder: dec, packetSink: sink, ring });

    pump.requestFrameAt(0);
    await tick();

    // Advance the playhead a frame at a time while staying far ahead of the
    // frontier — exactly what a clip that has fallen behind under load sees.
    let target = 5_000_000;
    for (let i = 0; i < 20; i++) {
      dec.drain(MAX_QUEUE);
      target += 33_333;
      pump.requestFrameAt(target);
      await tick();
    }

    expect(dec.resets).toBe(0);
    expect(ring.flushes).toBe(0);
    // Forward progress is the point: a livelocked pump parks on the key.
    expect((dec.decoded.at(-1)?.timestamp ?? 0)).toBeGreaterThan(0.5);
  });

  it("a far-forward seek into a LATER GOP does reset and re-seek — but still does not flush", async () => {
    // The complement of the same-GOP case: here the key really is different, so
    // continuing forward would mean decoding every packet in between. Reset and
    // jump. The ring is still not flushed — `requestFrameAt`'s `setAnchor` has
    // already evicted whatever fell outside the new window, and what remains is
    // either useful or about to age out on its own.
    const sink = new GopSink(8);
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({ decoder: dec, packetSink: sink, ring });

    pump.requestFrameAt(0);
    await tick(); // cold start on the GOP-0 key, then fills forward from it
    expect(dec.decoded[0]?.timestamp).toBe(0);
    const beforeSeek = dec.decoded.length;

    pump.requestFrameAt(20_000_000); // GOP 2 → a DIFFERENT key at 16s
    await tick();

    expect(dec.resets).toBe(1);
    expect(ring.flushes).toBe(0);
    // The first packet dispatched after the reset is the new GOP's key.
    expect(dec.decoded[beforeSeek]?.timestamp).toBe(16);
  });

  it("a BACKWARD reset beyond the ring still flushes — those frames are the wrong region", async () => {
    // The one case where the cached frames must go: the target is older than
    // anything cached, so the ring holds frames from a region the playhead has
    // left. Keeping them would let `frameAt` paint the wrong content while the
    // decoder rebuilds.
    const sink = new GopSink(8);
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({ decoder: dec, packetSink: sink, ring });

    pump.requestFrameAt(20_000_000);
    await tick();
    expect(dec.resets).toBe(0); // cold start is not a reset
    const beforeSeek = dec.decoded.length;

    ring.first = 18_000_000; // the ring caches from 18s onward
    pump.requestFrameAt(2_000_000); // target older than the ring's first entry
    await tick();

    expect(dec.resets).toBe(1);
    expect(ring.flushes).toBe(1);
    // Re-seeked to the GOP-0 key: the pump only moves forward, so a backward
    // target can only be reached from its own GOP's key.
    expect(dec.decoded[beforeSeek]?.timestamp).toBe(0);
  });

  it("cold start to a far target on a long-GOP source reaches the target (no livelock)", async () => {
    // Long-GOP fixture from the decode-bench repro: single key at t=0,
    // deltas every ~33ms out to 8s, target 5s past the 1s reset threshold.
    const sink = new SequentialSink(0.033, 8);
    const ring = new FakeRing();
    const dec = makeFakeDecoder();
    const pump = new PacketPump({ decoder: dec, packetSink: sink, ring });

    const targetUs = 5_000_000;
    pump.requestFrameAt(targetUs);
    await tick();

    // MAX_QUEUE backpressure parks each pass well short of the target;
    // simulate the async decoder draining and the per-tick re-kick (same
    // target) that the Compositor performs in the real app.
    for (
      let i = 0;
      i < 50 && ((dec.decoded.at(-1)?.timestamp ?? 0) * 1e6 < targetUs);
      i++
    ) {
      dec.drain(MAX_QUEUE);
      pump.requestFrameAt(targetUs);
      await tick();
    }

    const lastPtsUs = (dec.decoded.at(-1)?.timestamp ?? 0) * 1e6;
    expect(lastPtsUs).toBeGreaterThanOrEqual(targetUs);
    // This is a cold start (cursor started null), so the very first seek
    // is never counted as a "reset" — and because the target never
    // changed, the latch means it should never become one either.
    expect(dec.resets).toBe(0);
    expect(sink.getKeyCalls.length).toBe(1);
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
