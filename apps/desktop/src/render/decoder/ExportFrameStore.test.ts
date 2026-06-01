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
});
