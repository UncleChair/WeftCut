import { describe, expect, it } from "vitest";
import { ExportFrameStore } from "./ExportDecoderPool";

// ExportFrameStore.push reads only `timestamp` + `duration` and calls `close()`
// on eviction, so a plain stub stands in for a real VideoFrame in node/vitest.
function fakeFrame(ptsUs: number, durationUs: number): VideoFrame {
  return {
    timestamp: ptsUs,
    duration: durationUs,
    close: () => {},
  } as unknown as VideoFrame;
}

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
