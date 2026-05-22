// Locks down `FrameRing.frameAt` / `containsPts` semantics — in
// particular that lookup works even when `VideoFrame.duration` is 0.
// WebCodecs lets implementations leave `duration` null on output;
// an earlier version of these methods used `duration ||
// POSITIVE_INFINITY` as the predicate upper-bound, which made the
// binary search return whichever mid happened to satisfy `pts <= t`
// first instead of the latest such entry. With ~33 frames in the
// ring, asking for frame 9 deterministically returned frame 7 — the
// "stuck on frame N" symptom the user saw in preview.

import { describe, expect, it } from "vitest";

import { FrameRing } from "./FrameRing";

/// Stub `VideoFrame` carrying only the fields `FrameRing` reads.
/// `duration` is parameterized so tests can simulate both "browser
/// propagated EncodedVideoChunk.duration" (16667) and "browser left
/// it null" (0).
function makeFrame(ptsUs: number, durationUs: number): VideoFrame {
  return {
    timestamp: ptsUs,
    duration: durationUs || null,
    close: () => undefined,
  } as unknown as VideoFrame;
}

function pushFrames(
  ring: FrameRing,
  count: number,
  durationUs: number,
  fpsHz = 60,
): void {
  const frameDurUs = Math.round(1_000_000 / fpsHz);
  for (let i = 0; i < count; i++) {
    ring.push(makeFrame(i * frameDurUs, durationUs));
  }
}

describe("FrameRing.frameAt", () => {
  it("returns the right frame for a 60 fps stream with duration metadata", () => {
    const ring = new FrameRing();
    pushFrames(ring, 33, 16667);
    // frame N covers [N*16667, (N+1)*16667). Asking exactly at PTS
    // and inside the interval should both return that frame.
    expect(ring.frameAt(0)!.timestamp).toBe(0);
    expect(ring.frameAt(8000)!.timestamp).toBe(0);
    expect(ring.frameAt(16667)!.timestamp).toBe(16667);
    expect(ring.frameAt(150003)!.timestamp).toBe(150003);
    expect(ring.frameAt(150010)!.timestamp).toBe(150003);
  });

  it("returns the right frame when VideoFrame.duration is null", () => {
    // Regression: prior implementation used `duration ||
    // POSITIVE_INFINITY` in the search predicate, returning the
    // wrong frame deterministically when duration was absent.
    const ring = new FrameRing();
    pushFrames(ring, 33, 0); // duration null
    expect(ring.frameAt(150003)!.timestamp).toBe(150003);
    expect(ring.frameAt(133336)!.timestamp).toBe(133336);
    expect(ring.frameAt(8 * 16667)!.timestamp).toBe(8 * 16667);
    expect(ring.frameAt(9 * 16667)!.timestamp).toBe(9 * 16667);
    expect(ring.frameAt(20 * 16667)!.timestamp).toBe(20 * 16667);
    expect(ring.frameAt(32 * 16667)!.timestamp).toBe(32 * 16667);
  });

  it("clamps before the first entry when the gap is within CTS-offset range", () => {
    // Real-world sources commonly have a first-frame CTS offset
    // (B-frame reorder, edit-list `-ss`) of one frame or so. The
    // ring clamps to the first entry in this case so the painter
    // shows something at the start of the timeline.
    const r = new FrameRing();
    r.push(makeFrame(33333, 16667));
    r.push(makeFrame(50000, 16667));
    expect(r.frameAt(0)!.timestamp).toBe(33333);
    expect(r.frameAt(20000)!.timestamp).toBe(33333);
  });

  it("returns null when tUs is far before the first entry", () => {
    // After lookbehind eviction, the ring's first entry can be a
    // long way ahead of a backward-seek target. Clamping to it
    // would visibly flash the wrong region while the decoder
    // rebuilds — return null instead so the painter holds the
    // previous frame.
    const r = new FrameRing();
    r.push(makeFrame(1_000_000, 16667));
    r.push(makeFrame(1_016_667, 16667));
    expect(r.frameAt(0)).toBeNull();
    expect(r.frameAt(500_000)).toBeNull();
    // Right at the threshold (100ms gap): still returns null
    // because the check is strict-greater.
    expect(r.frameAt(900_001)!.timestamp).toBe(1_000_000);
    // Inside the threshold: clamp to first.
    expect(r.frameAt(950_000)!.timestamp).toBe(1_000_000);
  });

  it("clamps after the last entry to the last frame", () => {
    const ring = new FrameRing();
    pushFrames(ring, 10, 16667);
    // last entry is frame 9 at 150003. tUs past last interval ends
    // should return it.
    expect(ring.frameAt(10_000_000)!.timestamp).toBe(9 * 16667);
  });

  it("returns null on an empty ring", () => {
    const ring = new FrameRing();
    expect(ring.frameAt(0)).toBeNull();
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
