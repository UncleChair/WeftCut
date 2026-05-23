import { describe, expect, it } from "vitest";
import { formatTimecode, frameDurUs, snapFrameRound } from "./frames";

describe("snapFrameRound", () => {
  it("snaps to nearest at 30fps integer boundaries", () => {
    expect(snapFrameRound(0, 30, 1)).toBe(0);
    expect(snapFrameRound(16_666, 30, 1)).toBe(0);
    expect(snapFrameRound(16_667, 30, 1)).toBe(33_333);
    expect(snapFrameRound(33_333, 30, 1)).toBe(33_333);
    expect(snapFrameRound(50_000, 30, 1)).toBe(66_666);
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
