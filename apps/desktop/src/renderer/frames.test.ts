import { describe, expect, it, test } from "vitest";
import {
  adjacentFrameBoundaryUs,
  approxFrameDurUs,
  formatTimecode,
  formatWallClock,
  frameCount,
  frameIndexCeil,
  frameIndexFloor,
  frameIndexInLayer,
  frameIndexRound,
  isFractionalRate,
  lastFrameAnchorUs,
  snapFrameCeil,
  snapFrameFloor,
  snapFrameRound,
  timeUsAtFrame,
  wallClockAside,
} from "./frames";

// Every primitive here is wasm-backed; the wasm is loaded by the global test
// setup (vitest.config.ts setupFiles).

/// The spec's rate matrix: four broadcast fractional rates and their integer
/// twins. Every grid property below holds at all eight.
const RATES: [number, number][] = [
  [24_000, 1001],
  [24, 1],
  [25, 1],
  [30_000, 1001],
  [30, 1],
  [50, 1],
  [60_000, 1001],
  [60, 1],
];

const US_24H = 86_400_000_000;

describe("snapFrameRound", () => {
  it("snaps to nearest at 30fps integer boundaries", () => {
    expect(snapFrameRound(0, 30, 1)).toBe(0);
    expect(snapFrameRound(16_666, 30, 1)).toBe(0);
    expect(snapFrameRound(16_667, 30, 1)).toBe(33_333);
    expect(snapFrameRound(33_333, 30, 1)).toBe(33_333);
    // The composition grid represents the exact frame start with half-up
    // rounding (frame 2 true µs = 66_666.667 → 66_667).
    expect(snapFrameRound(50_000, 30, 1)).toBe(66_667);
  });

  it("matches Rust snap_frame_round math at 29.97 hour-scale", () => {
    const oneHour = 3_600_000_000;
    const snapped = snapFrameRound(oneHour, 30_000, 1001);
    expect(Math.abs(snapped - oneHour)).toBeLessThanOrEqual(16_700);
  });

  it("is idempotent (snap of a snapped value is itself)", () => {
    for (const t of [0, 10_000, 33_333, 100_000, 1_000_000]) {
      const a = snapFrameRound(t, 30, 1);
      const b = snapFrameRound(a, 30, 1);
      expect(b).toBe(a);
    }
  });

  it("returns input unchanged on degenerate fps", () => {
    expect(snapFrameRound(12_345, 0, 1)).toBe(12_345);
    expect(snapFrameRound(12_345, 30, 0)).toBe(12_345);
  });
});

describe("approxFrameDurUs", () => {
  it("returns the rounded microsecond length of one frame", () => {
    expect(approxFrameDurUs(30, 1)).toBe(33_333);
    expect(approxFrameDurUs(60, 1)).toBe(16_667);
    expect(approxFrameDurUs(24, 1)).toBe(41_667);
    expect(approxFrameDurUs(30_000, 1001)).toBe(33_367);
  });

  it("falls back to a 30fps default on degenerate input", () => {
    expect(approxFrameDurUs(0, 1)).toBe(33_333);
    expect(approxFrameDurUs(30, 0)).toBe(33_333);
  });

  it("is not accumulable — the reason nothing derives a grid time from it", () => {
    // 300 nominal frames at 30 fps land 100 µs short of the real boundary.
    expect(300 * approxFrameDurUs(30, 1)).toBe(9_999_900);
    expect(timeUsAtFrame(300, 30, 1)).toBe(10_000_000);
  });
});

describe("adjacentFrameBoundaryUs", () => {
  it("returns the previous and next canonical boundary at integer rates", () => {
    expect(adjacentFrameBoundaryUs(0, 1, 30, 1)).toBe(33_333);
    expect(adjacentFrameBoundaryUs(2_000_000, -1, 30, 1)).toBe(1_966_667);
    expect(adjacentFrameBoundaryUs(0, 1, 60, 1)).toBe(16_667);
  });

  it("derives neighbouring fractional-rate boundaries without adding a rounded duration", () => {
    const frame1 = adjacentFrameBoundaryUs(0, 1, 30_000, 1001);
    const frame2 = adjacentFrameBoundaryUs(frame1, 1, 30_000, 1001);

    expect(frame1).toBe(33_367);
    expect(frame2).toBe(66_733);
    expect(frame2 - frame1).toBe(33_366);
    expect(adjacentFrameBoundaryUs(frame2, -1, 30_000, 1001)).toBe(frame1);
  });
});

describe("lastFrameAnchorUs", () => {
  it("returns the composition-grid-aligned (half-up) last-frame start", () => {
    // 10s 30fps comp: 300 frames. The exact start of frame 299 is
    // 299/30 s = 9_966_666.667 µs. The composition anchor is represented as
    // 9_966_667; decoder PTS may be 9_966_666, and the ring's greatest-PTS<=
    // target rule still selects logical frame 299.
    expect(lastFrameAnchorUs(10_000_000, 30, 1)).toBe(9_966_667);
  });

  it("clamps at 0 for empty compositions", () => {
    expect(lastFrameAnchorUs(0, 30, 1)).toBe(0);
  });

  it("returns 0 when duration equals one frame", () => {
    expect(lastFrameAnchorUs(33_333, 30, 1)).toBe(0);
  });

  it("uses the comp fps, not 30fps default, at fractional rates", () => {
    // 29.97 NDF: 300 frames span ~10.010 s. Frame 299 exact start =
    // 299·1001/30000 s = 9_976_633.333 µs → half-up rounds DOWN to
    // 9_976_633 (since 0.333 < 0.5).
    expect(lastFrameAnchorUs(10_010_000, 30_000, 1001)).toBe(9_976_633);
  });
});

// `snapFrameFloor` is now the leaf's `snap_frame_floor` (it used to be a local
// TS twin that rounded its output half-up while the leaf truncated). These
// expectations are the OLD twin's, kept deliberately: the canonical values it
// produced still hold under the leaf, which is the evidence that the canonical
// half-up output policy is the right one and the leaf's truncating output was
// the bug. The one exception is called out inline.
describe("snapFrameFloor", () => {
  it("returns the canonical (half-up) start of the frame containing tUs", () => {
    // Frame 299 at 30 fps is canonical 9_966_667 (exact 9_966_666.667 → up).
    expect(snapFrameFloor(9_966_667, 30, 1)).toBe(9_966_667);
    expect(snapFrameFloor(9_999_999, 30, 1)).toBe(9_966_667);
    // DIVERGENCE from the deleted TS twin, which answered 9_966_667 here — a
    // "floor" one µs ABOVE its own input. 9_966_666 is below frame 299's
    // canonical start, so it belongs to frame 298.
    expect(snapFrameFloor(9_966_666, 30, 1)).toBe(9_933_333);
    expect(timeUsAtFrame(298, 30, 1)).toBe(9_933_333);
  });

  it("preserves zero and on-grid values", () => {
    expect(snapFrameFloor(0, 30, 1)).toBe(0);
    expect(snapFrameFloor(33_333, 30, 1)).toBe(33_333);
    expect(snapFrameFloor(10_000_000, 30, 1)).toBe(10_000_000);
  });

  it("doesn't drift like a pre-rounded frame-duration floor", () => {
    // Math.floor(9_966_667 / 33_333) * 33_333 = 9_966_567 — 100 µs below the
    // grid at frame 299, and the gap grows with the frame index.
    expect(Math.floor(9_966_667 / 33_333) * 33_333).toBe(9_966_567);
    expect(snapFrameFloor(9_966_667, 30, 1)).toBe(9_966_667);
  });

  it("handles 29.97 NDF: half-up rounding gives 33_367 at frame 1", () => {
    // Frame 1 exact start = 1·1001/30000 s = 33_366.667 µs → 33_367. This is
    // the value the leaf's truncating output policy used to miss (33_366).
    expect(snapFrameFloor(33_367, 30_000, 1001)).toBe(33_367);
    expect(snapFrameFloor(40_000, 30_000, 1001)).toBe(33_367);
  });

  it("returns input unchanged on degenerate fps", () => {
    expect(snapFrameFloor(12_345, 0, 1)).toBe(12_345);
    expect(snapFrameFloor(12_345, 30, 0)).toBe(12_345);
  });
});

describe("snapFrameCeil", () => {
  it("returns the canonical start of the next frame", () => {
    expect(snapFrameCeil(0, 30, 1)).toBe(0);
    expect(snapFrameCeil(1, 30, 1)).toBe(33_333);
    expect(snapFrameCeil(33_333, 30, 1)).toBe(33_333);
    // 66_667 (not the truncated 66_666) — the D2 output policy.
    expect(snapFrameCeil(33_334, 30, 1)).toBe(66_667);
    expect(snapFrameCeil(1, 30_000, 1001)).toBe(33_367);
  });

  it("returns input unchanged on degenerate fps", () => {
    expect(snapFrameCeil(12_345, 0, 1)).toBe(12_345);
  });
});

describe("frame index policies", () => {
  it("split the canonical cell floor/nearest/ceil", () => {
    expect(frameIndexFloor(33_332, 30, 1)).toBe(0);
    expect(frameIndexRound(33_332, 30, 1)).toBe(1);
    expect(frameIndexCeil(33_332, 30, 1)).toBe(1);
    // Half-frame rounds up; one µs below it does not.
    expect(frameIndexRound(16_666, 30, 1)).toBe(0);
    expect(frameIndexRound(16_667, 30, 1)).toBe(1);
  });

  it("answer 0 on degenerate fps", () => {
    for (const f of [frameIndexFloor, frameIndexRound, frameIndexCeil]) {
      expect(f(12_345, 0, 1)).toBe(0);
      expect(f(12_345, 30, 0)).toBe(0);
    }
    expect(timeUsAtFrame(7, 0, 1)).toBe(0);
    expect(frameCount(0, 1_000_000, 30, 0)).toBe(0);
  });
});

describe("frameCount", () => {
  it("counts the half-open range [start, end)", () => {
    expect(frameCount(0, 10_000_000, 30, 1)).toBe(300);
    expect(frameCount(0, 10_000_000, 60, 1)).toBe(600);
    expect(frameCount(0, 9_966_668, 30, 1)).toBe(300); // frame 299 < end → in
    expect(frameCount(0, 9_966_667, 30, 1)).toBe(299); // frame 299 == end → out
    expect(frameCount(1_000_000, 1_000_000, 30, 1)).toBe(0);
    expect(frameCount(2_000_000, 1_000_000, 30, 1)).toBe(0); // reversed
  });
});

// ---------------------------------------------------------------------------
// Grid properties over the full rate matrix. These are the acceptance
// invariants for the FrameGrid: nothing downstream (ruler ticks, trim bounds,
// export frame counts) is sound if one of them fails at one rate.
// ---------------------------------------------------------------------------

/// Frame indices to probe: a dense head (where index-policy off-by-ones live)
/// plus a coprime stride out to 24 h — the far end of the range the leaf's i128
/// math exists to keep exact. Sampled, not exhaustive: 24 h at 60 fps is 5.2 M
/// frames and each probe is several wasm calls.
function probeFrames(num: number, den: number): number[] {
  const last = frameCount(0, US_24H, num, den) - 1;
  const out: number[] = [];
  for (let i = 0; i < Math.min(2_000, last); i++) out.push(i);
  for (let i = 2_000; i < last; i += 9973) out.push(i);
  out.push(last);
  return out;
}

describe("grid properties at every rate", () => {
  for (const [num, den] of RATES) {
    it(`${num}/${den}: frame index round-trips and time is strictly monotonic`, () => {
      let prev = -1;
      for (const i of probeFrames(num, den)) {
        const t = timeUsAtFrame(i, num, den);
        expect(frameIndexRound(t, num, den)).toBe(i);
        expect(frameIndexFloor(t, num, den)).toBe(i);
        expect(frameIndexCeil(t, num, den)).toBe(i);
        expect(t).toBeGreaterThan(prev);
        prev = t;
      }
    });

    it(`${num}/${den}: snap is idempotent and floor <= nearest <= ceil`, () => {
      const probes = [0, 1, US_24H];
      for (const i of [0, 1, 2, 3, 107_892, 5_183_999]) {
        const t = timeUsAtFrame(i, num, den);
        probes.push(t - 1, t, t + 1, t + Math.floor((1_000_000 * den) / (2 * num)));
      }
      for (const t of probes.filter((v) => v >= 0)) {
        const lo = snapFrameFloor(t, num, den);
        const mid = snapFrameRound(t, num, den);
        const hi = snapFrameCeil(t, num, den);
        expect(lo).toBeLessThanOrEqual(mid);
        expect(mid).toBeLessThanOrEqual(hi);
        expect(lo).toBeLessThanOrEqual(t);
        expect(hi).toBeGreaterThanOrEqual(t);
        expect(snapFrameFloor(lo, num, den)).toBe(lo);
        expect(snapFrameRound(mid, num, den)).toBe(mid);
        expect(snapFrameCeil(hi, num, den)).toBe(hi);
      }
    });

    it(`${num}/${den}: frameCount agrees with its own predicate`, () => {
      for (const span of [1, 999_999, 1_000_000, 10_000_000, 3_600_000_000, US_24H]) {
        const start = 500_000;
        const n = frameCount(start, start + span, num, den);
        if (n > 0) expect(timeUsAtFrame(n - 1, num, den)).toBeLessThan(span);
        expect(timeUsAtFrame(n, num, den)).toBeGreaterThanOrEqual(span);
      }
    });
  }
});

describe("formatTimecode", () => {
  it("formats zero as HH:MM:SS:FF with two-digit zero-pad", () => {
    expect(formatTimecode(0, 30, 1)).toBe("00:00:00:00");
  });

  it("rolls over the frame field at the composition fps", () => {
    expect(formatTimecode(29 * 33_333, 30, 1)).toBe("00:00:00:29");
    expect(formatTimecode(30 * 33_333, 30, 1)).toBe("00:00:01:00");
  });

  it("rolls over seconds and minutes", () => {
    expect(formatTimecode(60 * 1_000_000, 30, 1)).toBe("00:01:00:00");
    expect(formatTimecode(3_600 * 1_000_000, 30, 1)).toBe("01:00:00:00");
  });

  it("rounds to the nearest frame for sub-frame microseconds (half-up)", () => {
    expect(formatTimecode(16_666, 30, 1)).toBe("00:00:00:00");
    expect(formatTimecode(16_667, 30, 1)).toBe("00:00:00:01");
  });

  it("handles 29.97 NDF: rolls past frame :29 the same as integer 30fps", () => {
    expect(formatTimecode(30 * 33_367, 30_000, 1001)).toBe("00:00:01:00");
  });
});

describe("wall-clock honesty beside NDF durations", () => {
  it("formats wall clock as HH:MM:SS.mmm, truncating ms", () => {
    expect(formatWallClock(0)).toBe("00:00:00.000");
    expect(formatWallClock(999_900)).toBe("00:00:00.999"); // truncate, never 1.000
    expect(formatWallClock(3_600_000_000)).toBe("01:00:00.000");
    expect(formatWallClock(-5)).toBe("00:00:00.000");
  });

  it("classifies only the NTSC family as fractional", () => {
    for (const [num, den] of [
      [24, 1],
      [25, 1],
      [30, 1],
      [50, 1],
      [60, 1],
      [60_000, 1000], // 60/1 written as a reducible pair — still integer fps
    ] as const) {
      expect(isFractionalRate(num, den)).toBe(false);
    }
    for (const [num, den] of [
      [24_000, 1001],
      [30_000, 1001],
      [60_000, 1001],
    ] as const) {
      expect(isFractionalRate(num, den)).toBe(true);
    }
    expect(isFractionalRate(0, 1)).toBe(false); // degenerate — nothing to claim
  });

  it("shows nothing at integer rates and the real duration at 29.97", () => {
    // One displayed NDF hour at 29.97 is 108000 frames = 3603.6 s of real time.
    const oneNdfHourUs = timeUsAtFrame(108_000, 30_000, 1001);
    expect(formatTimecode(oneNdfHourUs, 30_000, 1001)).toBe("01:00:00:00");
    expect(wallClockAside(oneNdfHourUs, 30_000, 1001)).toBe("01:00:03.600");
    // Integer rate: the aside would just repeat the timecode, so there is none.
    expect(wallClockAside(3_600_000_000, 30, 1)).toBeNull();
  });

  it("is the ~1.001 NDF factor, at every fractional rate in the matrix", () => {
    for (const [num, den] of [
      [24_000, 1001],
      [30_000, 1001],
      [60_000, 1001],
    ] as const) {
      const framesPerNdfHour = Math.round(num / den) * 3600;
      const us = timeUsAtFrame(framesPerNdfHour, num, den);
      expect(formatTimecode(us, num, den)).toBe("01:00:00:00");
      // The digits read one hour; the real elapsed time is 1001/1000 of it.
      expect(us / 3_600_000_000).toBeCloseTo(1001 / 1000, 6);
      expect(wallClockAside(us, num, den)).toBe("01:00:03.600");
    }
  });
});

test("frameIndexInLayer is exact-rational and clamped", () => {
  expect(frameIndexInLayer(0, 30000, 1001)).toBe(0);
  expect(frameIndexInLayer(33_367, 30000, 1001)).toBe(1); // exact start of frame 1 at 29.97
  expect(frameIndexInLayer(33_366, 30000, 1001)).toBe(0); // 1µs before → still frame 0
  expect(frameIndexInLayer(-50, 30000, 1001)).toBe(0);    // clamp low
  // degenerate fps clamps to 0
  expect(frameIndexInLayer(1000, 0, 1)).toBe(0);
  expect(frameIndexInLayer(1000, 30000, 0)).toBe(0);
});
