import { describe, expect, it } from "vitest";

import { MAX_PX_PER_SEC, MIN_PX_PER_SEC_FLOOR } from "./geometry";
import {
  KEYBOARD_ZOOM_FACTOR,
  fitPxPerSec,
  steppedPxPerSec,
  zoomAnchorX,
  zoomedScrollLeft,
} from "./zoom";

describe("fitPxPerSec", () => {
  it("fits the project extent to the lane", () => {
    // 60 s over a 1200 px lane = 20 px/s shows the whole thing.
    expect(fitPxPerSec(1200, 60_000_000)).toBe(20);
  });

  // Short projects still get an editing surface rather than a five-second
  // strip, so the fit is against MIN_TIMELINE_SECONDS, not the real duration.
  it("never fits closer than the minimum timeline span", () => {
    expect(fitPxPerSec(1000, 2_000_000)).toBe(100); // 10 s, not 2 s
  });

  // A lane that has never laid out measures 0, and minus the sticky header
  // column it goes negative — the floor is what keeps the bound usable.
  it("falls back to the absolute floor for degenerate widths", () => {
    expect(fitPxPerSec(0, 60_000_000)).toBe(MIN_PX_PER_SEC_FLOOR);
    expect(fitPxPerSec(-160, 60_000_000)).toBe(MIN_PX_PER_SEC_FLOOR);
  });
});

describe("steppedPxPerSec", () => {
  it("doubles in and halves out", () => {
    expect(steppedPxPerSec(80, 1, 5)).toBe(80 * KEYBOARD_ZOOM_FACTOR);
    expect(steppedPxPerSec(80, -1, 5)).toBe(80 / KEYBOARD_ZOOM_FACTOR);
  });

  it("stops at the fit-to-project bound on the way out", () => {
    expect(steppedPxPerSec(30, -1, 20)).toBe(20);
    // …and stays there, so the caller can skip the re-render.
    expect(steppedPxPerSec(20, -1, 20)).toBe(20);
  });

  it("stops at the hard ceiling on the way in", () => {
    expect(steppedPxPerSec(MAX_PX_PER_SEC * 0.75, 1, 5)).toBe(MAX_PX_PER_SEC);
    expect(steppedPxPerSec(MAX_PX_PER_SEC, 1, 5)).toBe(MAX_PX_PER_SEC);
  });

  // Out then in from anywhere between the bounds lands where it started: the
  // ladder is a power of two, so the round trip is exact in binary floating
  // point and repeated presses can't drift the zoom off its rungs.
  it("round-trips exactly", () => {
    for (const start of [17, 80, 123.5, 999]) {
      expect(steppedPxPerSec(steppedPxPerSec(start, -1, 1), 1, 1)).toBe(start);
    }
  });
});

describe("zoomAnchorX", () => {
  const VIEW = { scrollLeftPx: 1000, viewportPx: 800 };

  it("holds the playhead where it sits when it is on screen", () => {
    expect(zoomAnchorX({ ...VIEW, anchorPx: 1200 })).toBe(200);
    // Both edges count as on screen — the marker is still visible there.
    expect(zoomAnchorX({ ...VIEW, anchorPx: 1000 })).toBe(0);
    expect(zoomAnchorX({ ...VIEW, anchorPx: 1800 })).toBe(800);
  });

  // A zoom is a magnification, not a seek: widening a distant region the user
  // scrolled to must not teleport the view back to the playhead they left.
  it("holds the lane's centre when the playhead is off screen", () => {
    expect(zoomAnchorX({ ...VIEW, anchorPx: 0 })).toBe(400);
    expect(zoomAnchorX({ ...VIEW, anchorPx: 5000 })).toBe(400);
  });

  it("has nothing to anchor before the lane is measured", () => {
    expect(zoomAnchorX({ anchorPx: 1200, scrollLeftPx: 1000, viewportPx: 0 })).toBe(0);
    expect(zoomAnchorX({ anchorPx: 1200, scrollLeftPx: 1000, viewportPx: -160 })).toBe(0);
  });
});

describe("zoomedScrollLeft", () => {
  // The property the whole feature is named for, stated as arithmetic: the time
  // at the anchor before the zoom is the time at the anchor after it.
  it("leaves the anchored time under the anchor", () => {
    const scrollLeftPx = 1000;
    const anchorX = 200;
    const oldPxPerSec = 80;
    const newPxPerSec = 160;
    const anchoredTimeSec = (scrollLeftPx + anchorX) / oldPxPerSec;

    const next = zoomedScrollLeft({
      scrollLeftPx,
      anchorX,
      ratio: newPxPerSec / oldPxPerSec,
    });

    expect((next + anchorX) / newPxPerSec).toBeCloseTo(anchoredTimeSec, 10);
  });

  it("is a no-op when the scale doesn't change", () => {
    expect(zoomedScrollLeft({ scrollLeftPx: 1000, anchorX: 200, ratio: 1 })).toBe(1000);
  });

  // Zooming out near t=0 wants a negative offset; the DOM clamps the
  // assignment, and the caller relies on that rather than pre-clamping against
  // a content width the canvas has only just been re-laid-out around.
  it("returns the raw offset even when it lands before the start", () => {
    expect(
      zoomedScrollLeft({ scrollLeftPx: 100, anchorX: 400, ratio: 0.5 }),
    ).toBe(-150);
  });
});
