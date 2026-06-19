import { describe, expect, it, vi } from "vitest";
import { ExportFrameStore, tenBitHighWaterFor } from "./ExportDecoderPool";
import type { TenBitFrame } from "./tenBitFrame";

// ExportFrameStore.push reads only `timestamp` + `duration` and calls `close()`
// on eviction, so a plain stub stands in for a real VideoFrame in node/vitest.
function fakeFrame(ptsUs: number, durationUs: number): VideoFrame {
  return {
    timestamp: ptsUs,
    duration: durationUs,
    close: () => {},
  } as unknown as VideoFrame;
}

/// Ten-bit stub: push reads `kind` (type guard) + `data.byteLength` (high-water
/// derivation) on top of the VideoFrame fields above.
function fakeTenBitFrame(ptsUs: number, durationUs: number, byteLength: number): TenBitFrame {
  return {
    kind: "p10",
    data: { byteLength },
    timestamp: ptsUs,
    duration: durationUs,
    close: () => {},
  } as unknown as TenBitFrame;
}

const BYTES_1080P = 1920 * 1080 * 3; // I420P10 ≈ 6.2 MB
const BYTES_4K = 3840 * 2160 * 3; // ≈ 24.9 MB

describe("ExportFrameStore.waitForPts", () => {
  // Regression: the export wedged at frame 0 ("stuck at 0%") whenever a
  // DirectExport source's decoder PTS grid drifted off the integer output grid.
  //
  // Reproduction: the decoder emits frames at 0, 33333, 66666, 100000 … (an
  // occasional 33334 step to average 1e6/30), every frame stamped duration
  // 33333. The export's per-output-frame target is `i × round(1e6/30)` =
  // 0, 33333, 66666, 99999 … . At i=3 the target 99999 lands in the gap
  // [99999, 100000) between two frames' [pts, pts+dur) intervals, AND
  // `evictBefore` has already dropped the lower neighbour. Strict interval
  // containment therefore never matches and the wait hangs forever.
  //
  // With the fix, `waitForPts` resolves once a strictly-later frame is present
  // (the target frame is then final; `frameAt` clamps to the nearest).
  it("resolves when the target falls in a PTS-grid gap after eviction (AV1 export-deadlock regression)", async () => {
    const store = new ExportFrameStore();
    store.push(fakeFrame(0, 33333));
    store.push(fakeFrame(33333, 33333));
    store.push(fakeFrame(66666, 33333));
    store.push(fakeFrame(100000, 33333));

    // Consumer evicts through the lower neighbour after compositing frame i=2
    // (cutoff = the next output target, 99999). Drops 0 / 33333 / 66666.
    store.evictBefore(99999);
    expect(store.firstPtsUs()).toBe(100000);

    // i=3 target (3 × 33333) sits in the [99999, 100000) gap. Pre-fix this never
    // resolves → the test would time out. Post-fix it resolves (frame 100000 is
    // present and strictly later) and frameAt clamps to it.
    await expect(store.waitForPts(99999)).resolves.toBeUndefined();
    expect(store.frameAt(99999)).not.toBeNull();
  });

  it("resolves a pending wait once a strictly-later frame arrives", async () => {
    const store = new ExportFrameStore();
    let resolved = false;
    const waited = store.waitForPts(50000).then(() => {
      resolved = true;
    });

    // pts 0 is before the target and doesn't cover it → still waiting.
    store.push(fakeFrame(0, 33333));
    await Promise.resolve();
    expect(resolved).toBe(false);

    // A frame past the target arrives → the frame for 50000 is now final.
    store.push(fakeFrame(66666, 33333));
    await waited;
    expect(resolved).toBe(true);
  });

  it("resolves synchronously when the target's interval is already held", async () => {
    const store = new ExportFrameStore();
    store.push(fakeFrame(0, 33333));
    await expect(store.waitForPts(0)).resolves.toBeUndefined();
  });

  // Regression: long-GOP DirectExport DEADLOCK. When a chunk needs frames far
  // ahead of a keyframe, the decoder re-decodes a long run from the GOP key.
  // Those decoded-but-unconsumed frames pile into the ring while the consumer
  // is parked in `waitForPts(targetAhead)`, exhausting the WebCodecs VideoFrame
  // pool (~13 HW slots) so the decoder stalls — and the per-frame `evictBefore`
  // that frees the pool only runs AFTER the await resolves → circular deadlock
  // (observed: export frozen at frame 250 = the 2nd x264 GOP key).
  //
  // Fix: `push()` frees slots behind the lowest pending waiter (keeping the
  // immediate lower neighbour for the PTS-drift case above), so the producer
  // can always make forward progress while a consumer waits.
  it("frees pool slots behind a pending waiter during a long re-decode", async () => {
    const store = new ExportFrameStore();
    const closed: number[] = [];
    const frame = (pts: number) =>
      ({ timestamp: pts, duration: 33333, close: () => closed.push(pts) }) as unknown as VideoFrame;

    // Consumer parks waiting for a far-ahead source frame (≈ frame 250).
    let resolved = false;
    const target = 250 * 33333; // 8333250
    const waited = store.waitForPts(target).then(() => {
      resolved = true;
    });

    // Decoder re-decodes from the GOP key: push frames 0..200, all far below
    // the target. Without freeing-behind-the-waiter these all pile up (the real
    // decoder's pool then exhausts and stalls).
    for (let i = 0; i <= 200; i++) store.push(frame(i * 33333));
    await Promise.resolve();

    expect(resolved).toBe(false); // target not yet covered → still waiting
    // Ring stayed bounded: the passed frames behind the waiter were freed,
    // leaving only the immediate lower neighbour (+ at most one).
    expect(store.size()).toBeLessThanOrEqual(2);
    expect(closed.length).toBeGreaterThanOrEqual(199);

    // Decoder reaches a frame covering the target → the parked waiter resolves.
    store.push(frame(target));
    await waited;
    expect(resolved).toBe(true);
  });

  // The deadlock's real shape: frames pile up DURING a chunk's decodeRange
  // dispatch — BEFORE the encode loop parks on any waiter — so the pool is
  // already full (decoder stalled, no more `push` callbacks) by the time the
  // consumer calls `waitForPts`. Freeing only in `push` can't help then (push
  // isn't being called). `waitForPts` must free behind the new waiter itself to
  // KICK the stalled decoder; `push` then sustains the flow.
  it("frees already-piled frames when a consumer starts waiting (kick a stalled decoder)", async () => {
    const store = new ExportFrameStore();
    const closed: number[] = [];
    const frame = (pts: number) =>
      ({ timestamp: pts, duration: 33333, close: () => closed.push(pts) }) as unknown as VideoFrame;

    // Decoder piled frames 0..15 with NO waiter yet (mid-dispatch). Nothing is
    // freed because there's no pending waiter to free behind.
    for (let i = 0; i <= 15; i++) store.push(frame(i * 33333));
    expect(store.size()).toBe(16);

    // Consumer now parks waiting for a far-ahead frame. The piled frames are
    // behind it and the (real) decoder is stalled — they MUST be freed now.
    store.waitForPts(250 * 33333);
    expect(store.size()).toBeLessThanOrEqual(2);
    expect(closed.length).toBeGreaterThanOrEqual(14);
  });
});

// EOS finalization — the ring-side half of the export tail-deadlock fix. Once
// the source hits end-of-stream the ring goes through two phases:
//
//   beginEosDrain()  — the EOS flush was ISSUED. Frames are still arriving from
//                      the drain, but eviction must keep the last held entry
//                      from now on: the consumer's per-frame cutoff can overrun
//                      the final frame's interval (composition grid extends
//                      past the video track), and an emptied ring leaves
//                      nothing to clamp to later.
//   finishEosDrain() — the flush COMPLETED: no frame will EVER arrive again.
//                      Any wait target is now final — resolve by clamping to
//                      the nearest held frame instead of parking forever.
//
// The clamp must NOT activate at issue time: during the drain the real frame
// for a target may still be on its way, and clamping early would composite a
// stale frame (silent dup-frame corruption across the export tail).
describe("ExportFrameStore EOS finalization", () => {
  it("finishEosDrain resolves a parked tail waiter by clamping to the last held frame", async () => {
    const store = new ExportFrameStore();
    let resolved = false;
    const waited = store.waitForPts(212_166_667).then(() => {
      resolved = true;
    });

    // The true-last source frame arrives; it doesn't cover the target (the
    // composition grid overhangs the video track) → still parked.
    store.push(fakeFrame(212_046_000, 33_333));
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Decoder reports fully drained → the target is final, clamp.
    store.finishEosDrain();
    await waited;
    expect(store.frameAt(212_166_667)).not.toBeNull();
  });

  it("resolves new tail waits immediately once ended while a frame is held", async () => {
    const store = new ExportFrameStore();
    store.push(fakeFrame(100_000, 33_333));
    store.finishEosDrain();
    await expect(store.waitForPts(999_999)).resolves.toBeUndefined();
    expect(store.frameAt(999_999)).not.toBeNull();
  });

  it("keeps the last entry during the EOS drain so the clamp target survives eviction", () => {
    const store = new ExportFrameStore();
    const closed: number[] = [];
    const frame = (pts: number) =>
      ({ timestamp: pts, duration: 33_333, close: () => closed.push(pts) }) as unknown as VideoFrame;
    store.push(frame(100_000));
    store.push(frame(133_333));
    store.beginEosDrain();
    // Per-frame evict with a cutoff past EVERYTHING (grid overhang): the last
    // entry must survive as the future clamp target.
    store.evictBefore(1_000_000);
    expect(store.size()).toBe(1);
    expect(closed).toEqual([100_000]);
  });

  it("clearEosDrain re-arms real waiting after a re-seek", async () => {
    const store = new ExportFrameStore();
    store.push(fakeFrame(0, 33_333));
    store.beginEosDrain();
    store.finishEosDrain();
    // A backward clip-reuse jump rebuilds the decoder: new frames CAN arrive
    // again, so finalized clamping must deactivate...
    store.clearEosDrain();
    const outcome = await Promise.race([
      store.waitForPts(500_000).then(() => "resolved" as const),
      new Promise<"parked">((r) => setTimeout(() => r("parked"), 150)),
    ]);
    expect(outcome).toBe("parked");
    // ...and eviction stops pinning the stale last entry.
    store.evictBefore(1_000_000);
    expect(store.size()).toBe(0);
  });
});

// TenBitFrame integration — the ring only reads timestamp/duration/close, so a
// TenBitFrame-shaped object (CPU planes, no VideoFrame pool slot) integrates
// without any ring changes.
describe("ExportFrameStore TenBitFrame integration", () => {
  it("accepts a TenBitFrame: containsPts, waitForPts, and evictBefore all work", async () => {
    const closeFn = vi.fn();
    const tb: TenBitFrame = {
      kind: "p10",
      width: 1920,
      height: 1080,
      data: new Uint8Array(0),
      yOffset: 0,
      uOffset: 0,
      vOffset: 0,
      colorSpace: null,
      timestamp: 0,
      duration: 33333,
      close: closeFn,
    };

    const store = new ExportFrameStore();
    // push accepts the widened union (TenBitFrame carries timestamp/duration/close)
    store.push(tb);

    expect(store.containsPts(10)).toBe(true);
    await expect(store.waitForPts(10)).resolves.toBeUndefined();

    store.evictBefore(40000);
    expect(store.size()).toBe(0);
    expect(closeFn).toHaveBeenCalledTimes(1);
  });
});

// ExportFrameStore.fail — loud copy failure (I1)
describe("ExportFrameStore.fail", () => {
  it("rejects a parked waitForPts waiter immediately", async () => {
    const store = new ExportFrameStore();
    const waitP = store.waitForPts(50_000);
    store.fail("copyTo exploded");
    await expect(waitP).rejects.toThrow("copyTo exploded");
  });

  it("rejects future waitForPts calls without parking", async () => {
    const store = new ExportFrameStore();
    store.fail("copyTo exploded");
    await expect(store.waitForPts(0)).rejects.toThrow("copyTo exploded");
  });

  it("is idempotent — second fail does not change the failure reason", () => {
    const store = new ExportFrameStore();
    store.fail("first");
    store.fail("second");
    // The rejection carries the first reason.
    return expect(store.waitForPts(0)).rejects.toThrow("first");
  });

  it("resolves gateWaiters so copy-chain links drain after failure", async () => {
    const store = new ExportFrameStore();
    // Fill to high-water: push 48 fake frames.
    for (let i = 0; i < 48; i++) {
      store.push(fakeFrame(i * 33333, 33333));
    }
    // Park a gate waiter.
    let gateResolved = false;
    const gateP = store.waitBelowTenBitHighWater().then(() => {
      gateResolved = true;
    });
    await Promise.resolve(); // still at HWM
    expect(gateResolved).toBe(false);

    // fail() must unblock the gate so chain links can drain.
    store.fail("error");
    await gateP;
    expect(gateResolved).toBe(true);
  });
});

// ExportFrameStore.waitBelowTenBitHighWater — I2 backpressure
describe("ExportFrameStore.waitBelowTenBitHighWater", () => {
  it("resolves immediately when the ring is below the high-water mark", async () => {
    const store = new ExportFrameStore();
    for (let i = 0; i < 47; i++) store.push(fakeFrame(i * 33333, 33333));
    await expect(store.waitBelowTenBitHighWater()).resolves.toBeUndefined();
  });

  it("parks at exactly high-water and resolves after evictBefore shrinks the ring", async () => {
    const store = new ExportFrameStore();
    // Push 48 entries — exactly at HWM.
    for (let i = 0; i < 48; i++) store.push(fakeFrame(i * 33333, 33333));

    let gateResolved = false;
    const gateP = store.waitBelowTenBitHighWater().then(() => {
      gateResolved = true;
    });
    await Promise.resolve();
    expect(gateResolved).toBe(false); // still at HWM

    // Evict one entry — ring drops to 47, below HWM.
    store.evictBefore(33333);
    await gateP;
    expect(gateResolved).toBe(true);
  });
});

// Resolution-derived high-water: the entry cap derives from the first
// TenBitFrame's actual plane bytes (a per-ring byte target expressed as an
// entry count — frame size is constant within one ring), clamped to
// [MIN 20, MAX 48]. Bounds 4K memory (~500 MB at the MIN floor) without
// live byte accounting.
describe("tenBitHighWaterFor", () => {
  it("clamps 1080p to the 48-entry ceiling (today's behavior unchanged)", () => {
    expect(tenBitHighWaterFor(BYTES_1080P)).toBe(48);
  });
  it("clamps 4K to the 20-entry deadlock floor", () => {
    expect(tenBitHighWaterFor(BYTES_4K)).toBe(20);
  });
  it("uses the byte-target quotient between the clamps (1440p → 30)", () => {
    expect(tenBitHighWaterFor(2560 * 1440 * 3)).toBe(30);
  });
});

describe("ExportFrameStore resolution-derived ten-bit high-water", () => {
  it("derives the gate level from the first TenBitFrame's bytes (4K → 20)", async () => {
    const store = new ExportFrameStore();
    for (let i = 0; i < 20; i++) store.push(fakeTenBitFrame(i * 33333, 33333, BYTES_4K));
    expect(store.tenBitHighWater).toBe(20);

    let gateResolved = false;
    const gateP = store.waitBelowTenBitHighWater().then(() => {
      gateResolved = true;
    });
    await Promise.resolve();
    expect(gateResolved).toBe(false); // parked at the derived (lower) HWM

    store.evictBefore(33333); // 19 entries — below the derived HWM
    await gateP;
    expect(gateResolved).toBe(true);
  });

  it("derives once — later frames with different sizes don't re-derive", () => {
    const store = new ExportFrameStore();
    store.push(fakeTenBitFrame(0, 33333, BYTES_1080P));
    expect(store.tenBitHighWater).toBe(48);
    store.push(fakeTenBitFrame(33333, 33333, BYTES_4K * 4));
    expect(store.tenBitHighWater).toBe(48);
  });

  it("keeps the 48 ceiling for plain VideoFrame rings (8-bit lane untouched)", async () => {
    const store = new ExportFrameStore();
    for (let i = 0; i < 47; i++) store.push(fakeFrame(i * 33333, 33333));
    expect(store.tenBitHighWater).toBe(48);
    await expect(store.waitBelowTenBitHighWater()).resolves.toBeUndefined();
  });

  // Deadlock-freedom at the MIN floor: a parked consumer always reopens the
  // gate. Decoder output is presentation-ordered, so an unsatisfied waiter
  // implies every held frame is at/below its target — all evictable except
  // the immediate lower neighbour. `waitForPts` runs `freeBehindWaiters`
  // itself, so parking the consumer shrinks the ring and releases the chain.
  it("at the 20-entry floor, a parked waiter evicts behind itself and reopens the gate", async () => {
    const store = new ExportFrameStore();
    for (let i = 0; i < 20; i++) store.push(fakeTenBitFrame(i * 33333, 33333, BYTES_4K));

    let gateResolved = false;
    const gateP = store.waitBelowTenBitHighWater().then(() => {
      gateResolved = true;
    });
    await Promise.resolve();
    expect(gateResolved).toBe(false); // chain blocked at the floor

    // Consumer parks for a frame beyond everything held (pts 30 × 33333).
    let waiterResolved = false;
    const waitP = store.waitForPts(30 * 33333).then(() => {
      waiterResolved = true;
    });
    // Its freeBehindWaiters keeps only the immediate lower neighbour → the
    // gate reopens and the copy chain can progress toward the awaited frame.
    await gateP;
    expect(gateResolved).toBe(true);

    store.push(fakeTenBitFrame(30 * 33333, 33333, BYTES_4K));
    await waitP;
    expect(waiterResolved).toBe(true);
  });
});
