// Locks down `FrameRing.frameAt` / `containsPts` semantics — in
// particular that lookup works even when the source frame's duration
// was 0 at push time (WebCodecs lets implementations leave
// `VideoFrame.duration` null on output, and the producer side passes
// `frame.duration ?? 0` into the ring along with the snapshotted
// `ImageBitmap`). An earlier version of these methods used
// `duration || POSITIVE_INFINITY` as the predicate upper-bound, which
// made the binary search return whichever mid happened to satisfy
// `pts <= t` first instead of the latest such entry. With ~33 frames
// in the ring, asking for frame 9 deterministically returned frame 7
// — the "stuck on frame N" symptom the user saw in preview.

import { describe, expect, it } from "vitest";

import { FrameRing } from "./FrameRing";
import { nv12FrameFromBytes } from "./nv12Frame";

/// Stub `ImageBitmap` carrying only the fields `FrameRing` and its
/// consumers touch. We tag each stub with `ptsUs` so the assertions
/// below can verify which entry's bitmap came back from `frameAt`.
interface BitmapStub extends ImageBitmap {
  ptsUs: number;
}

function makeBitmap(ptsUs: number): BitmapStub {
  return {
    width: 1920,
    height: 1080,
    close: () => undefined,
    ptsUs,
  } as unknown as BitmapStub;
}

function pushFrames(
  ring: FrameRing,
  count: number,
  durationUs: number,
  fpsHz = 60,
): void {
  const frameDurUs = Math.round(1_000_000 / fpsHz);
  for (let i = 0; i < count; i++) {
    const ptsUs = i * frameDurUs;
    ring.push(makeBitmap(ptsUs), ptsUs, durationUs);
  }
}

function ptsOf(frame: unknown): number | null {
  if (!frame) return null;
  return (frame as BitmapStub).ptsUs;
}

describe("FrameRing.frameAt", () => {
  it("returns the right frame for a 60 fps stream with duration metadata", () => {
    const ring = new FrameRing();
    pushFrames(ring, 33, 16667);
    // frame N covers [N*16667, (N+1)*16667). Asking exactly at PTS
    // and inside the interval should both return that frame.
    expect(ptsOf(ring.frameAt(0))).toBe(0);
    expect(ptsOf(ring.frameAt(8000))).toBe(0);
    expect(ptsOf(ring.frameAt(16667))).toBe(16667);
    expect(ptsOf(ring.frameAt(150003))).toBe(150003);
    expect(ptsOf(ring.frameAt(150010))).toBe(150003);
  });

  it("returns the right frame when source duration was null", () => {
    // Regression: prior implementation used `duration ||
    // POSITIVE_INFINITY` in the search predicate, returning the
    // wrong frame deterministically when duration was absent.
    const ring = new FrameRing();
    pushFrames(ring, 33, 0); // duration null
    expect(ptsOf(ring.frameAt(150003))).toBe(150003);
    expect(ptsOf(ring.frameAt(133336))).toBe(133336);
    expect(ptsOf(ring.frameAt(8 * 16667))).toBe(8 * 16667);
    expect(ptsOf(ring.frameAt(9 * 16667))).toBe(9 * 16667);
    expect(ptsOf(ring.frameAt(20 * 16667))).toBe(20 * 16667);
    expect(ptsOf(ring.frameAt(32 * 16667))).toBe(32 * 16667);
  });

  it("clamps before the first entry when the gap is within CTS-offset range", () => {
    // Real-world sources commonly have a first-frame CTS offset
    // (B-frame reorder, edit-list `-ss`) of one frame or so. The
    // ring clamps to the first entry in this case so the painter
    // shows something at the start of the timeline.
    const r = new FrameRing();
    r.push(makeBitmap(33333), 33333, 16667);
    r.push(makeBitmap(50000), 50000, 16667);
    expect(ptsOf(r.frameAt(0))).toBe(33333);
    expect(ptsOf(r.frameAt(20000))).toBe(33333);
  });

  it("returns null when tUs is far before the first entry", () => {
    // After lookbehind eviction, the ring's first entry can be a
    // long way ahead of a backward-seek target. Clamping to it
    // would visibly flash the wrong region while the decoder
    // rebuilds — return null instead so the painter holds the
    // previous frame.
    const r = new FrameRing();
    r.push(makeBitmap(1_000_000), 1_000_000, 16667);
    r.push(makeBitmap(1_016_667), 1_016_667, 16667);
    expect(r.frameAt(0)).toBeNull();
    expect(r.frameAt(500_000)).toBeNull();
    // Right at the threshold (100ms gap): still returns null
    // because the check is strict-greater.
    expect(ptsOf(r.frameAt(900_001))).toBe(1_000_000);
    // Inside the threshold: clamp to first.
    expect(ptsOf(r.frameAt(950_000))).toBe(1_000_000);
  });

  it("clamps after the last entry to the last frame", () => {
    const ring = new FrameRing();
    pushFrames(ring, 10, 16667);
    // last entry is frame 9 at 150003. tUs past last interval ends
    // should return it.
    expect(ptsOf(ring.frameAt(10_000_000))).toBe(9 * 16667);
  });

  it("returns null on an empty ring", () => {
    const ring = new FrameRing();
    expect(ring.frameAt(0)).toBeNull();
  });
});

describe("FrameRing.push", () => {
  it("keeps order with monotonic PTS (proxy v4 / no B-frames)", () => {
    // Fast path: every push has PTS strictly greater than the tail.
    // The implementation skips the sort entirely; the assertion is
    // that order is still correct, which proves no behavior change.
    const r = new FrameRing();
    pushFrames(r, 60, 16667);
    expect(ptsOf(r.frameAt(0))).toBe(0);
    expect(ptsOf(r.frameAt(16667 * 29))).toBe(16667 * 29);
    expect(ptsOf(r.frameAt(16667 * 59))).toBe(16667 * 59);
  });

  it("still sorts out-of-order pushes (B-frame / async-bitmap races)", () => {
    // Slow path: push frame 2 before frame 1 (mimics async
    // `createImageBitmap` resolves landing out of order). The
    // safety-net sort must still kick in so `frameAt` returns the
    // correct frame.
    const r = new FrameRing();
    r.push(makeBitmap(0), 0, 16667);
    r.push(makeBitmap(2 * 16667), 2 * 16667, 16667);
    r.push(makeBitmap(1 * 16667), 1 * 16667, 16667);
    expect(ptsOf(r.frameAt(0))).toBe(0);
    expect(ptsOf(r.frameAt(1 * 16667))).toBe(1 * 16667);
    expect(ptsOf(r.frameAt(2 * 16667))).toBe(2 * 16667);
  });

  it("carries NativeNv12Frames (native SW preview lane) through lookup and eviction", () => {
    // The ring must treat CPU-plane frames exactly like bitmaps via the
    // shared close() — the native SW preview rings these so they convert in
    // Nv12Ingest, never through createImageBitmap (nv12Frame.ts).
    const r = new FrameRing();
    const frames = [0, 1, 2].map((i) =>
      nv12FrameFromBytes({
        data: new Uint8Array(2 * 2 + 2),
        width: 2,
        height: 2,
        timestamp: i * 16667,
        duration: 16667,
        colorSpace: { matrix: "bt709" },
      }),
    );
    for (const f of frames) r.push(f, f.timestamp, 16667);
    expect(r.frameAt(16667)).toBe(frames[1]);
    // Evict everything behind a far-forward anchor; the no-op close must not throw.
    r.setAnchor(10_000_000);
    expect(r.size()).toBe(0);
    expect(r.frameAt(16667)).toBeNull();
  });
});

describe("FrameRing.containsPts", () => {
  it("returns true for PTS inside any entry's interval", () => {
    const ring = new FrameRing();
    pushFrames(ring, 10, 16667);
    expect(ring.containsPts(0)).toBe(true);
    expect(ring.containsPts(8000)).toBe(true);
    expect(ring.containsPts(16667)).toBe(true);
    expect(ring.containsPts(150003)).toBe(true);
  });

  it("works when VideoFrame.duration is null", () => {
    // Regression: prior implementation used `duration || 0` as the
    // upper-bound, so `tUs < pts + 0` was always false — meaning
    // `containsPts` returned false for every input when duration
    // was absent.
    const ring = new FrameRing();
    pushFrames(ring, 10, 0);
    expect(ring.containsPts(0)).toBe(true);
    expect(ring.containsPts(16667)).toBe(true);
    expect(ring.containsPts(150003)).toBe(true);
    // Mid-interval also covered via next-entry-PTS bound.
    expect(ring.containsPts(8000)).toBe(true);
  });

  it("returns false outside the ring", () => {
    const ring = new FrameRing();
    pushFrames(ring, 5, 16667);
    // Before the first entry.
    expect(ring.containsPts(-1)).toBe(false);
    // Well past the last entry's recorded interval.
    expect(ring.containsPts(10_000_000)).toBe(false);
  });

  it("returns false on an empty ring", () => {
    const ring = new FrameRing();
    expect(ring.containsPts(0)).toBe(false);
  });
});

describe("pushCount", () => {
  it("counts accepted pushes and ignores dropped-behind ones", () => {
    const ring = new FrameRing();
    ring.setAnchor(10_000_000);
    // Ends before anchor - lookbehind (10s - 0.5s) → the drop path.
    ring.push(makeBitmap(0), 0, 33_333);
    expect(ring.pushCount).toBe(0);
    ring.push(makeBitmap(10_000_000), 10_000_000, 33_333);
    ring.push(makeBitmap(10_033_333), 10_033_333, 33_333);
    expect(ring.pushCount).toBe(2);
  });

  it("is not reset by eviction", () => {
    const ring = new FrameRing();
    ring.push(makeBitmap(0), 0, 33_333);
    ring.push(makeBitmap(33_333), 33_333, 33_333);
    ring.setAnchor(5_000_000); // evicts both
    expect(ring.size()).toBe(0);
    expect(ring.pushCount).toBe(2);
  });
});
