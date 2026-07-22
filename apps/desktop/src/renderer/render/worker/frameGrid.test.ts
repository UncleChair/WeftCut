import { describe, expect, it } from "vitest";
import { exportFrameCount, frameTimeUs } from "./frameGrid";

describe("frameTimeUs", () => {
  // The grid must equal the exact rational composition grid round(i*1e6/fps), NOT the
  // drift-prone i*round(1e6/fps). At 30 fps the two diverge from i=2 on.
  it("matches the rational composition grid (no compounded floor)", () => {
    for (let i = 0; i < 30; i++) {
      expect(frameTimeUs(0, i, 30, 1)).toBe(Math.round((i * 1_000_000) / 30));
    }
  });

  // Regression pin: frame 2 is the first point where the floored `i*33333`
  // approximation diverges from the exact composition grid. Whether that
  // numeric difference changes source identity depends on the decoder's own
  // quantization; the composition timestamp itself must remain exact-rational.
  it("places frame 2 at 66667us, not the drifted 66666us (30fps)", () => {
    expect(frameTimeUs(0, 2, 30, 1)).toBe(66667);
    expect(2 * Math.round(1_000_000 / 30)).toBe(66666); // the old, wrong value
  });

  it("is strictly increasing (no two output frames share a time)", () => {
    for (let i = 1; i < 300; i++) {
      expect(frameTimeUs(0, i, 30, 1)).toBeGreaterThan(frameTimeUs(0, i - 1, 30, 1));
    }
  });

  it("honors startUs offset and other fps", () => {
    expect(frameTimeUs(500_000, 0, 60, 1)).toBe(500_000);
    expect(frameTimeUs(0, 60, 60, 1)).toBe(1_000_000);
  });
});

describe("exportFrameCount", () => {
  // The core regression: a 300-frame 30fps clip is exactly 10_000_000us. The
  // old `ceil(10_000_000 / 33333)` returned 301 (the extra frame that forced a
  // duplicate); the predicate count returns 300.
  it("counts 300 frames for a 10s 30fps composition (not 301)", () => {
    expect(exportFrameCount(0, 10_000_000, 30, 1)).toBe(300);
    expect(Math.ceil(10_000_000 / Math.round(1_000_000 / 30))).toBe(301); // old, wrong
  });

  it("counts 600 frames for a 10s 60fps composition", () => {
    expect(exportFrameCount(0, 10_000_000, 60, 1)).toBe(600);
  });

  // The advisor's tail edge case: a non-frame-aligned trim range. `endUs`
  // strictly past frame 299's time (9_966_667) must INCLUDE frame 299; `endUs`
  // exactly at frame 299's time must EXCLUDE it (interval is half-open). A
  // round()-based count gets one of these wrong.
  it("handles non-frame-aligned trim ranges via the half-open predicate", () => {
    expect(frameTimeUs(0, 299, 30, 1)).toBe(9_966_667);
    expect(exportFrameCount(0, 9_966_668, 30, 1)).toBe(300); // 299's time < end → included
    expect(exportFrameCount(0, 9_966_667, 30, 1)).toBe(299); // 299's time == end → excluded
  });

  it("counts 0 for an empty or inverted range", () => {
    expect(exportFrameCount(1_000_000, 1_000_000, 30, 1)).toBe(0);
    expect(exportFrameCount(2_000_000, 1_000_000, 30, 1)).toBe(0);
  });

  // The count and grid agree by construction: frame (n-1) is inside the range,
  // frame n is at/after the end. Verify across assorted spans.
  it("is consistent with frameTimeUs at the boundary", () => {
    for (const endUs of [33_333, 100_000, 5_000_000, 9_999_999, 10_000_000]) {
      const n = exportFrameCount(0, endUs, 30, 1);
      if (n > 0) expect(frameTimeUs(0, n - 1, 30, 1)).toBeLessThan(endUs);
      expect(frameTimeUs(0, n, 30, 1)).toBeGreaterThanOrEqual(endUs);
    }
  });
});
