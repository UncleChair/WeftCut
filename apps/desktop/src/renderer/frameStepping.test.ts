import { describe, expect, it } from "vitest";
import {
  adjacentFrameBoundaryUs,
  approxFrameDurUs,
  frameCount,
  lastFrameAnchorUs,
  timeUsAtFrame,
} from "./frames";

// Acceptance for the single-frame playhead step (App.tsx `seekFrameBack` /
// `seekFrameForward`). The step moves the frame INDEX and asks the grid for that
// frame's time, so every assertion here is against the grid alone: the clock's
// setPosition snap is deliberately not in the loop.

/// The spec's rate matrix: four broadcast fractional rates and their integer
/// twins. Stepping must be exact at all eight.
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

const US_1H = 3_600_000_000;

/// One step as App.tsx performs it: the neighbouring canonical boundary, then
/// `seekTo`'s clamp to `[0, lastFrameAnchorUs]` (`state/navigation.clampSeekUs`).
/// Mirrored rather than imported because the App-side pair is a wiring closure
/// over the live project summary.
function stepUs(
  fromUs: number,
  direction: -1 | 1,
  fpsNum: number,
  fpsDen: number,
  upperUs: number,
): number {
  const target = adjacentFrameBoundaryUs(fromUs, direction, fpsNum, fpsDen);
  return Math.max(0, Math.min(target, upperUs));
}

/// An exactly-one-hour composition on this rate's grid, so `durationUs` is
/// canonical and the last-frame anchor is `timeUsAtFrame(totalFrames - 1)`.
function hourLongComp(fpsNum: number, fpsDen: number) {
  const totalFrames = frameCount(0, US_1H, fpsNum, fpsDen);
  // Guard against a vacuous walk: an hour is 86_314 frames at the slowest rate
  // in the matrix (24000/1001), so a short count means the grid, not the step.
  expect(totalFrames).toBeGreaterThan(86_000);
  const durationUs = timeUsAtFrame(totalFrames, fpsNum, fpsDen);
  return { totalFrames, durationUs, upperUs: lastFrameAnchorUs(durationUs, fpsNum, fpsDen) };
}

describe("single-frame playhead stepping", () => {
  for (const [num, den] of RATES) {
    it(`${num}/${den}: N forward steps from 0 land on frame N, out to one hour`, () => {
      const { totalFrames } = hourLongComp(num, den);
      // One `expect` per frame would dominate the runtime; record the first
      // divergence instead so a failure still names the frame it happened at.
      let t = 0;
      let firstBad = -1;
      for (let i = 1; i < totalFrames; i++) {
        t = adjacentFrameBoundaryUs(t, 1, num, den);
        if (t !== timeUsAtFrame(i, num, den)) {
          firstBad = i;
          break;
        }
      }
      expect(firstBad).toBe(-1);
      expect(t).toBe(timeUsAtFrame(totalFrames - 1, num, den));
    });

    it(`${num}/${den}: back-stepping from the last frame anchor reaches 0 in totalFrames - 1 steps`, () => {
      const { totalFrames, upperUs } = hourLongComp(num, den);
      expect(upperUs).toBe(timeUsAtFrame(totalFrames - 1, num, den));

      let t = upperUs;
      let steps = 0;
      let firstBad = -1;
      while (t > 0 && steps < totalFrames) {
        t = stepUs(t, -1, num, den, upperUs);
        steps++;
        if (t !== timeUsAtFrame(totalFrames - 1 - steps, num, den)) {
          firstBad = steps;
          break;
        }
      }
      expect(firstBad).toBe(-1);
      expect(t).toBe(0);
      expect(steps).toBe(totalFrames - 1);
    });

    it(`${num}/${den}: back at frame 0 is a no-op and forward at the last frame clamps`, () => {
      const { upperUs, durationUs } = hourLongComp(num, den);
      expect(durationUs).toBeGreaterThan(upperUs);
      expect(stepUs(0, -1, num, den, upperUs)).toBe(0);
      expect(stepUs(upperUs, 1, num, den, upperUs)).toBe(upperUs);
    });
  }

  it("a rounded-duration step lands off the grid where an index step does not", () => {
    // The shape this replaced: at 29.97 the nominal step is 33_367 µs but frames
    // 1→2 are 33_366 µs apart, so adding it overshoots frame 2's canonical start
    // by 1 µs and only the clock's snap pulled the playhead back on grid.
    const frame1 = timeUsAtFrame(1, 30_000, 1001);
    const frame2 = timeUsAtFrame(2, 30_000, 1001);
    expect(frame1 + approxFrameDurUs(30_000, 1001)).toBe(frame2 + 1);
    expect(adjacentFrameBoundaryUs(frame1, 1, 30_000, 1001)).toBe(frame2);
  });
});
