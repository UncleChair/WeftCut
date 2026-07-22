import { describe, expect, it, test } from "vitest";
import {
  adjacentFrameBoundaryUs,
  formatTimecode,
  frameDurUs,
  frameIndexInLayer,
  lastFrameAnchorUs,
  snapFrameFloor,
  snapFrameRound,
} from "./frames";

// snapFrameRound is wasm-backed now; the wasm is loaded by the global test
// setup (vitest.config.ts setupFiles).

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

describe("frameDurUs", () => {
  it("returns the rounded microsecond length of one frame", () => {
    expect(frameDurUs(30, 1)).toBe(33_333);
    expect(frameDurUs(60, 1)).toBe(16_667);
    expect(frameDurUs(24, 1)).toBe(41_667);
    expect(frameDurUs(30_000, 1001)).toBe(33_367);
  });

  it("falls back to a 30fps default on degenerate input", () => {
    expect(frameDurUs(0, 1)).toBe(33_333);
    expect(frameDurUs(30, 0)).toBe(33_333);
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

describe("snapFrameFloor", () => {
  it("rounds frame-grid values half-up to align all composition callers", () => {
    // Frame 299 exact start = 9_966_666.667 → half-up rounds to
    // 9_966_667. The export frame grid uses the same half-up rule; a decoder
    // may represent the corresponding source PTS as 9_966_666 instead.
    expect(snapFrameFloor(9_966_666, 30, 1)).toBe(9_966_667);
    expect(snapFrameFloor(9_966_667, 30, 1)).toBe(9_966_667);
    expect(snapFrameFloor(9_999_999, 30, 1)).toBe(9_966_667);
  });

  it("preserves zero and on-grid values whose exact start has no fractional µs", () => {
    expect(snapFrameFloor(0, 30, 1)).toBe(0);
    expect(snapFrameFloor(33_333, 30, 1)).toBe(33_333);
    expect(snapFrameFloor(10_000_000, 30, 1)).toBe(10_000_000);
  });

  it("doesn't drift like the pre-rounded-frameDurUs floor", () => {
    // Math.floor(9_966_666 / 33_333) * 33_333 = 9_966_567 (off by 100 µs
    // at frame 299 from the exact rational composition-grid value).
    expect(snapFrameFloor(9_966_666, 30, 1)).toBe(9_966_667);
    expect(Math.floor(9_966_666 / 33_333) * 33_333).toBe(9_966_567);
  });

  it("handles 29.97 NDF: half-up rounding gives 33_367 at frame 1", () => {
    // Frame 1 exact start = 1·1001/30000 s = 33_366.667 µs → 33_367.
    expect(snapFrameFloor(33_367, 30_000, 1001)).toBe(33_367);
    expect(snapFrameFloor(40_000, 30_000, 1001)).toBe(33_367);
  });

  it("returns input unchanged on degenerate fps", () => {
    expect(snapFrameFloor(12_345, 0, 1)).toBe(12_345);
    expect(snapFrameFloor(12_345, 30, 0)).toBe(12_345);
  });
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

test("frameIndexInLayer is exact-rational and clamped", () => {
  expect(frameIndexInLayer(0, 30000, 1001)).toBe(0);
  expect(frameIndexInLayer(33_367, 30000, 1001)).toBe(1); // exact start of frame 1 at 29.97
  expect(frameIndexInLayer(33_366, 30000, 1001)).toBe(0); // 1µs before → still frame 0
  expect(frameIndexInLayer(-50, 30000, 1001)).toBe(0);    // clamp low
  // degenerate fps clamps to 0
  expect(frameIndexInLayer(1000, 0, 1)).toBe(0);
  expect(frameIndexInLayer(1000, 30000, 0)).toBe(0);
});
