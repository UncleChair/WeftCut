// Locks down `FrameRing.frameAt` / `containsPts` semantics — in
// particular that lookup works even when the source frame's duration
// was 0 at push time (WebCodecs lets implementations leave
// `VideoFrame.duration` null on output, and the producer side passes
// `frame.duration ?? 0` into the ring along with the snapshotted
// `ImageBitmap`).

import { beforeEach, describe, expect, it } from "vitest";

import { FrameRing } from "./FrameRing";
import {
  frameRingByteBudget,
  liveFrameRingCount,
  resetFrameRingBudgetForTest,
} from "./frameRingBudget";
import { nv12FrameFromBytes } from "./nv12Frame";

// Rings register themselves against a SHARED byte budget, so a ring left
// undisposed by an earlier test would shrink every later ring's share and make
// the byte arm of `isLookaheadFull` fire where the test never intended it to.
// Reset the divisor per test rather than disposing 18 rings by hand.
beforeEach(() => {
  resetFrameRingBudgetForTest();
});

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
  it("returns the selected frame together with its presentation identity", () => {
    const ring = new FrameRing();
    const first = makeBitmap(0);
    const second = makeBitmap(33_333);
    ring.push(first, 0, 33_333);
    ring.push(second, 33_333, 33_334);

    expect(ring.selectFrame(50_000)).toEqual({
      frame: second,
      ptsUs: 33_333,
      durationUs: 33_334,
    });
  });

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

describe("strandedAheadOf", () => {
  // The backward-seek hole `setAnchor` structurally cannot close: it evicts from
  // the FRONT only, so a jump back past everything cached leaves the whole ring
  // in place and `frameAt` returning null forever. Measured symptom on the ffmpeg
  // lane (which had no flush-on-backward-seek): 12 s of frozen picture while the
  // ring held frames from the old playhead position.
  const ringAt = (...pts: number[]) => {
    const ring = new FrameRing();
    for (const p of pts) ring.push(makeBitmap(p), p, 33_333);
    return ring;
  };

  it("is false for an empty ring (nothing to strand)", () => {
    expect(new FrameRing().strandedAheadOf(0)).toBe(false);
  });

  it("is false while the target is inside or behind the cached span", () => {
    const ring = ringAt(11_700_000, 11_733_333, 11_766_666);
    expect(ring.strandedAheadOf(11_733_333)).toBe(false);
    expect(ring.strandedAheadOf(11_800_000)).toBe(false); // ahead of the ring
  });

  it("is false within the clamp gap — a CTS / edit-list offset must not flush", () => {
    // A source whose first decoded frame carries a positive CTS offset asks for
    // t=0 against a ring starting at +50ms every tick. `frameAt` clamps to the
    // first entry there, so treating it as stranded would flush a perfectly good
    // ring on every tick and never let one accumulate.
    const ring = ringAt(50_000, 83_333);
    expect(ring.strandedAheadOf(0)).toBe(false);
  });

  it("is true once the target falls before the ring by more than the clamp gap", () => {
    const ring = ringAt(11_700_000, 11_733_333);
    expect(ring.strandedAheadOf(0)).toBe(true);
    expect(ring.strandedAheadOf(1_000_000)).toBe(true);
    // Exactly the boundary case the clamp still rescues vs. the first one past it.
    expect(ring.strandedAheadOf(11_600_000)).toBe(false); // 100ms gap → clamped
    expect(ring.strandedAheadOf(11_599_000)).toBe(true);
  });
});

// These lock the byte arm that bounds ring memory — and the floors that keep it
// from degrading into thrash. Why the budget exists: frameRingBudget.ts.
/// Mirrors the module's private floors. Not exported from `FrameRing` because
/// they are policy the tests below assert, not configuration a caller sets.
const MIN_LOOKAHEAD_FRAMES = 10;
const BYTES_4K = 3840 * 2160 * 4;
const BYTES_1080P = 1920 * 1080 * 4;

describe("FrameRing byte budget", () => {
  function make4k(): ImageBitmap {
    return {
      width: 3840,
      height: 2160,
      close: () => undefined,
    } as unknown as ImageBitmap;
  }

  function make1080p(): ImageBitmap {
    return {
      width: 1920,
      height: 1080,
      close: () => undefined,
    } as unknown as ImageBitmap;
  }

  /// Push `count` 4K frames at 30 fps, continuing from what's already there.
  function push4k(ring: FrameRing, count: number): void {
    const from = ring.size();
    for (let i = from; i < from + count; i++) {
      const ptsUs = Math.round((i * 1_000_000) / 30);
      ring.push(make4k(), ptsUs, 33_333);
    }
  }

  it("tallies retained bytes by frame kind, not by what JS can reach", () => {
    const ring = new FrameRing();
    // An ImageBitmap is GPU-backed RGBA — width × height × 4 is the real cost.
    ring.push(make4k(), 0, 33_333);
    expect(ring.retainedBytes).toBe(BYTES_4K);
    // An NV12 CPU plane costs exactly its buffer.
    const nv12 = nv12FrameFromBytes({
      data: new Uint8Array(1920 * 1080 * 1.5),
      width: 1920,
      height: 1080,
      colorSpace: null,
      timestamp: 100_000,
      duration: 33_333,
    });
    ring.push(nv12, 100_000, 33_333);
    expect(ring.retainedBytes).toBe(BYTES_4K + 1920 * 1080 * 1.5);
  });

  it("pauses the pump on bytes before the time window is satisfied", () => {
    // TWO rings, because the budget is sized so a SINGLE 4K clip's whole 1 s
    // window fits under it — the byte arm is a ceiling for the multi-clip
    // pathology, not a clamp on the cases that already measure well.
    const rings = [new FrameRing(), new FrameRing()];
    const ring = rings[0]!;
    const perRing = frameRingByteBudget();
    const untilFull = Math.floor(perRing / BYTES_4K);

    push4k(ring, untilFull);
    expect(ring.retainedBytes).toBeLessThan(perRing);
    expect(ring.isLookaheadFull()).toBe(false);

    push4k(ring, 1);
    expect(ring.retainedBytes).toBeGreaterThan(perRing);
    // The gap this exists to close: bytes run out while the 1 s TIME window is
    // barely half satisfied, so without the byte arm the pump keeps filling.
    expect(ring.lastPtsUs()!).toBeLessThan(1_000_000);
    expect(ring.isLookaheadFull()).toBe(true);
  });

  it("never pauses below the lookahead floor, even far over budget", () => {
    // Four rings divide the 1 GiB budget, so each gets 256 MiB — about eight 4K
    // frames.
    const rings = [new FrameRing(), new FrameRing(), new FrameRing(), new FrameRing()];
    expect(liveFrameRingCount()).toBe(4);
    const ring = rings[0]!;
    push4k(ring, MIN_LOOKAHEAD_FRAMES - 1);
    // Way over its 256 MiB share, but starving the pump here would break the
    // warm-up gate, which needs ~150 ms of ring before it releases the clock.
    expect(ring.retainedBytes).toBeGreaterThan(frameRingByteBudget());
    expect(ring.isLookaheadFull()).toBe(false);
    push4k(ring, 1);
    expect(ring.isLookaheadFull()).toBe(true);
  });

  it("counts an entry exactly ON the anchor toward the lookahead floor", () => {
    // The floor's contract is frames at-or-AFTER the anchor, but the binary
    // search classes an anchor-exact entry as at-or-before — uncorrected, the
    // effective floor is 10 or 11 depending on whether the frame grid lands a
    // PTS exactly on the anchor. One lookbehind entry keeps the whole-ring-
    // ahead early return out of play, and the tail stays inside the 1 s time
    // window so only the byte arm answers.
    const rings = [new FrameRing(), new FrameRing(), new FrameRing(), new FrameRing()];
    const ring = rings[0]!;
    ring.push(make4k(), 466_667, 33_333); // lookbehind, still inside 0.5 s
    for (let i = 0; i < MIN_LOOKAHEAD_FRAMES; i++) {
      ring.push(make4k(), 500_000 + i * 33_333, 33_333); // first sits AT the anchor
    }
    ring.setAnchor(500_000);
    // Byte arm active, time arm unsatisfied — the floor is the sole decider.
    expect(ring.retainedBytes).toBeGreaterThan(frameRingByteBudget());
    expect(ring.lastPtsUs()!).toBeLessThan(500_000 + 1_000_000);
    expect(ring.isLookaheadFull()).toBe(true);
  });

  it("stays below the floor at 9 frames ahead even when the first sits on the anchor", () => {
    const rings = [new FrameRing(), new FrameRing(), new FrameRing(), new FrameRing()];
    const ring = rings[0]!;
    ring.push(make4k(), 466_667, 33_333);
    for (let i = 0; i < MIN_LOOKAHEAD_FRAMES - 1; i++) {
      ring.push(make4k(), 500_000 + i * 33_333, 33_333);
    }
    ring.setAnchor(500_000);
    expect(ring.retainedBytes).toBeGreaterThan(frameRingByteBudget());
    expect(ring.isLookaheadFull()).toBe(false);
  });

  it("does NOT trim lookbehind on byte pressure — only its time window evicts", () => {
    // Guards the lookbehind LANDMINE in FrameRing.ts, which owns the measured
    // reason byte pressure must never trim lookbehind.
    const rings = [new FrameRing(), new FrameRing(), new FrameRing(), new FrameRing()];
    const ring = rings[0]!;
    push4k(ring, 30); // 1 s of 4K ≈ 995 MB against a 256 MiB share
    expect(ring.retainedBytes).toBeGreaterThan(frameRingByteBudget());

    // Anchor at the last frame. Lookbehind is 0.5 s, so the time window keeps
    // the trailing ~15 frames and byte pressure must not take them.
    ring.setAnchor(Math.round((29 * 1_000_000) / 30));
    expect(ring.size()).toBeGreaterThan(MIN_LOOKAHEAD_FRAMES);
    expect(ring.retainedBytes).toBeGreaterThan(frameRingByteBudget());
  });

  it("keeps a single 1080p clip's window intact — the case that measures well today", () => {
    const ring = new FrameRing();
    // 47 frames is what a smooth 1080p single-clip session held before the
    // budget existed; it must still fit or this change trades a 4K fix for a
    // 1080p regression.
    for (let i = 0; i < 47; i++) {
      const ptsUs = Math.round((i * 1_000_000) / 30);
      ring.push(make1080p(), ptsUs, 33_333);
    }
    // 47 × 8.3 MB = 390 MB, comfortably inside this sole ring's 1 GiB share, so
    // the byte arm never fires and eviction is still driven purely by the time
    // window.
    // (`isLookaheadFull` is true here on the TIME arm — 47 frames at 30 fps
    // spans 1.53 s past a 1 s lookahead — which is pre-existing behaviour.)
    expect(ring.retainedBytes).toBe(47 * BYTES_1080P);
    expect(ring.retainedBytes).toBeLessThan(frameRingByteBudget());
    expect(ring.size()).toBe(47);
    ring.setAnchor(Math.round((15 * 1_000_000) / 30));
    expect(ring.size()).toBe(47); // nothing trimmed: not over budget
  });

  it("dispose is idempotent, so a double call can't shrink every other ring", () => {
    const soleShare = frameRingByteBudget(); // no rings live yet → the whole total
    const a = new FrameRing();
    const b = new FrameRing();
    expect(liveFrameRingCount()).toBe(2);
    expect(frameRingByteBudget()).toBe(soleShare / 2);
    a.dispose();
    a.dispose();
    expect(liveFrameRingCount()).toBe(1);
    // `b` is back to the whole budget, not a third of it.
    expect(frameRingByteBudget()).toBe(soleShare);
    b.dispose();
    expect(liveFrameRingCount()).toBe(0);
  });

  it("flush and eviction keep the tally honest", () => {
    const ring = new FrameRing();
    push4k(ring, 5);
    expect(ring.retainedBytes).toBe(5 * BYTES_4K);
    // Anchor past everything: all five fall outside the lookbehind window.
    ring.setAnchor(10_000_000);
    expect(ring.size()).toBe(0);
    expect(ring.retainedBytes).toBe(0);
    push4k(ring, 3);
    ring.flush();
    expect(ring.retainedBytes).toBe(0);
  });
});

// The measured failure these exist for: at 3–4 concurrent 1080p clips the rings
// read EMPTY while every decoder reported full-rate delivery, so frames were
// produced and lost. `decodeFps` is a `pushCount` diff and both engines bump
// their own delivery counter BEFORE calling `push`, so nothing in the old
// instrumentation could distinguish "pushed and painted" from "pushed and
// binned" — or from "offered and refused at the door".
// What it turned out to be, and what the counters found: docs/playback-perf.md.
describe("FrameRing.fate", () => {
  it("starts at zero on every counter", () => {
    const ring = new FrameRing();
    for (const [, v] of Object.entries(ring.fate)) expect(v).toBe(0);
  });

  it("returns a copy, so a held snapshot cannot drift under the caller", () => {
    const ring = new FrameRing();
    const before = ring.fate;
    ring.push(makeBitmap(0), 0, 33_333);
    expect(before.pushed).toBe(0);
    expect(ring.fate.pushed).toBe(1);
  });

  it("counts a frame the ring refuses at the door as staleDropped, not pushed", () => {
    // THE hypothesis this instrumentation was built to test. A long-GOP source
    // re-seeking to serve the playhead re-decodes the whole GOP prefix; every
    // prefix frame older than `anchor - lookbehind` lands here. The producer
    // counts all of them as delivered, the ring holds none, and before this
    // counter existed the discard left no trace anywhere.
    const ring = new FrameRing();
    ring.setAnchor(10_000_000);
    ring.push(makeBitmap(0), 0, 33_333);
    ring.push(makeBitmap(1_000_000), 1_000_000, 33_333);
    expect(ring.fate.staleDropped).toBe(2);
    expect(ring.fate.pushed).toBe(0);
    expect(ring.size()).toBe(0);
  });

  it("separates evicted frames that were painted from those that never were", () => {
    const ring = new FrameRing();
    pushFrames(ring, 4, 33_333, 30);
    // Paint the second frame only.
    expect(ring.selectFrame(33_333)).not.toBeNull();
    // Anchor past everything → all four leave by the time window.
    ring.setAnchor(10_000_000);
    expect(ring.fate.evicted).toBe(4);
    expect(ring.fate.evictedUnserved).toBe(3);
  });

  it("attributes flushed frames the same way, and counts the flushes themselves", () => {
    const ring = new FrameRing();
    pushFrames(ring, 3, 33_333, 30);
    expect(ring.selectFrame(0)).not.toBeNull();
    ring.flush();
    expect(ring.fate.flushes).toBe(1);
    expect(ring.fate.flushed).toBe(3);
    expect(ring.fate.flushedUnserved).toBe(2);
    // A flush with nothing in the ring is still a seek/resync event — the churn
    // signal is the CALL count, which must not depend on what happened to be held.
    ring.flush();
    expect(ring.fate.flushes).toBe(2);
    expect(ring.fate.flushed).toBe(3);
  });

  it("holds the conservation identity: pushed === size + evicted + flushed", () => {
    // The reason to assert this rather than each counter alone: it is what makes
    // a report readable as a flow. If it ever breaks, a frame is leaving the ring
    // by a path nothing accounts for.
    const ring = new FrameRing();
    pushFrames(ring, 20, 33_333, 30); // pts 0 … 633ms
    ring.setAnchor(900_000); // lookbehind 0.5 s → evicts everything ending ≤ 400ms
    ring.push(makeBitmap(700_000), 700_000, 33_333);
    ring.flush();
    pushFrames(ring, 5, 33_333, 30);
    const f = ring.fate;
    // Both removal paths must have fired, or the identity is vacuous on one arm.
    expect(f.evicted).toBeGreaterThan(0);
    expect(f.flushed).toBeGreaterThan(0);
    expect(f.pushed).toBe(ring.size() + f.evicted + f.flushed);
  });

  it("counts a hit, a clamp, and both kinds of miss apart", () => {
    const ring = new FrameRing();
    // Empty ring.
    expect(ring.selectFrame(0)).toBeNull();
    expect(ring.fate.serveMissEmpty).toBe(1);

    // First entry at +50ms: a CTS / edit-list offset. Asking for 0 clamps.
    ring.push(makeBitmap(50_000), 50_000, 33_333);
    ring.push(makeBitmap(83_333), 83_333, 33_333);
    expect(ring.selectFrame(0)).not.toBeNull();
    expect(ring.fate.serveClamp).toBe(1);
    expect(ring.fate.serveHit).toBe(0);

    // Inside the span: a plain hit.
    expect(ring.selectFrame(83_333)).not.toBeNull();
    expect(ring.fate.serveHit).toBe(1);

    // Further before the ring than the clamp can rescue — the backward-seek
    // shape, distinct from an empty ring because the frames exist, just not
    // these ones.
    expect(ring.selectFrame(-5_000_000)).toBeNull();
    expect(ring.fate.serveMissGap).toBe(1);
    expect(ring.fate.serveMissEmpty).toBe(1);
  });

  it("counts a re-selected frame as a repeat — the judder the drop counter can't see", () => {
    // `judgeFrameSelection` asks only whether the bound frame is STALE, so a
    // compositor painting the same frame twice reads as two successful
    // selections and zero drops. Measured shape: presented 26.7 fps against a
    // 29.97 grid with dropped=0 throughout.
    const ring = new FrameRing();
    ring.push(makeBitmap(0), 0, 33_333);
    ring.push(makeBitmap(33_333), 33_333, 33_333);
    ring.selectFrame(10_000);
    expect(ring.fate.serveRepeat).toBe(0);
    ring.selectFrame(20_000); // same entry again → held frame
    expect(ring.fate.serveRepeat).toBe(1);
    ring.selectFrame(40_000); // advances to the next entry
    expect(ring.fate.serveRepeat).toBe(1);
  });

  it("does not call a re-push after a flush a repeat", () => {
    // Re-decoding the same PTS after a seek and painting it again is a genuine
    // new selection; carrying the old PTS across the flush would report the
    // recovery from a seek as judder.
    const ring = new FrameRing();
    ring.push(makeBitmap(0), 0, 33_333);
    ring.selectFrame(0);
    ring.flush();
    ring.push(makeBitmap(0), 0, 33_333);
    ring.selectFrame(0);
    expect(ring.fate.serveRepeat).toBe(0);
  });

  it("does not count or mark-served the readiness probes", () => {
    // `frameAt` is polled per tick by the Compositor's source-swap path and
    // `containsPts` by the decoder's seek decision. Counting either would
    // inflate hits with selections nothing painted, and marking entries served
    // would erase the evidence of a frame that was decoded and never shown.
    const ring = new FrameRing();
    pushFrames(ring, 3, 33_333, 30);
    expect(ring.frameAt(33_333)).not.toBeNull();
    expect(ring.containsPts(33_333)).toBe(true);
    expect(ring.fate.serveHit).toBe(0);
    ring.setAnchor(10_000_000);
    expect(ring.fate.evictedUnserved).toBe(3);
  });
});
