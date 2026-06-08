// Unit tests for the net-new, pure frame-selection math the MotifSprite
// uses to map a layer-relative time to (frame, frameTimeSec, cacheKey). The
// sprite itself constructs a Pixi Sprite + touches `createImageBitmap`, so it
// can't run in Node — these helpers are extracted so the arithmetic is
// testable without the browser surface. The async capture/bind chain is
// exercised end-to-end by the real-WebView2 e2e (`templates.e2e.js`).

import { describe, expect, test } from "vitest";

import {
  frameTimeSec,
  motifContentFrame,
  motifDurationFrames,
  motifFrameCacheKey,
} from "../motifs/motifFrames";

describe("motifDurationFrames", () => {
  test("exact-rational frame count over the duration (30fps)", () => {
    // 5 s @ 30 fps = 150 frames.
    expect(motifDurationFrames(5_000_000, 30, 1)).toBe(150);
    // 10 s @ 30 fps = 300 frames.
    expect(motifDurationFrames(10_000_000, 30, 1)).toBe(300);
  });

  test("clamps to at least 1 frame for sub-frame / zero durations", () => {
    expect(motifDurationFrames(0, 30, 1)).toBe(1);
    expect(motifDurationFrames(1, 30, 1)).toBe(1);
    // ~16.6ms is under one 30fps frame → still 1.
    expect(motifDurationFrames(16_000, 30, 1)).toBe(1);
  });

  test("degenerate fps falls back to 1", () => {
    expect(motifDurationFrames(5_000_000, 0, 1)).toBe(1);
    expect(motifDurationFrames(5_000_000, 30, 0)).toBe(1);
  });

  test("honors a non-1 fps denominator (29.97)", () => {
    // 1 s @ 30000/1001 ≈ 29.97 → round(1e6 * 30000 / (1e6 * 1001)) ≈ 30.
    expect(motifDurationFrames(1_000_000, 30000, 1001)).toBe(30);
  });
});

describe("frameTimeSec", () => {
  test("exact seconds at a frame start (30fps)", () => {
    expect(frameTimeSec(0, 30, 1)).toBe(0);
    expect(frameTimeSec(75, 30, 1)).toBe(2.5);
    expect(frameTimeSec(30, 30, 1)).toBe(1);
  });

  test("respects the fps denominator", () => {
    // frame 30 @ 60fps = 0.5 s.
    expect(frameTimeSec(30, 60, 1)).toBe(0.5);
  });

  test("degenerate fpsNum returns 0", () => {
    expect(frameTimeSec(10, 0, 1)).toBe(0);
  });
});

describe("motifFrameCacheKey", () => {
  const base = {
    motifId: "countdown",
    version: 1,
    canonicalProps: { from: 5 },
    renderW: 1920,
    renderH: 1080,
    fpsNum: 30,
    fpsDen: 1,
    durationFrames: 150,
  };

  test("is deterministic for identical input", () => {
    expect(motifFrameCacheKey(base)).toBe(motifFrameCacheKey({ ...base }));
  });

  test("does NOT embed the frame index (cache appends #<frame>)", () => {
    expect(motifFrameCacheKey(base)).not.toMatch(/#\d+$/);
  });

  test("changes with each keyed dimension", () => {
    const k = motifFrameCacheKey(base);
    expect(motifFrameCacheKey({ ...base, version: 2 })).not.toBe(k);
    expect(motifFrameCacheKey({ ...base, durationFrames: 300 })).not.toBe(k);
    expect(motifFrameCacheKey({ ...base, fpsNum: 60 })).not.toBe(k);
    expect(motifFrameCacheKey({ ...base, renderW: 1280 })).not.toBe(k);
    expect(motifFrameCacheKey({ ...base, canonicalProps: { from: 9 } })).not.toBe(k);
  });
});

describe("motifContentFrame", () => {
  // 6s content @30fps = 180 frames (0..179).
  test("window [0,5s] into 6s content shows content frames 0..149 (6 down to 2)", () => {
    const at0 = motifContentFrame(0, 0, 6_000_000, 30, 1);
    expect(at0.contentDurationFrames).toBe(180);
    expect(at0.frame).toBe(0); // content t=0 -> "6"
    const atEnd = motifContentFrame(5_000_000 - 1, 0, 6_000_000, 30, 1);
    expect(atEnd.frame).toBe(149); // ~content t=5s -> "2"
  });
  test("src_in scrubs into content: window [1s,..] starts at content frame 30 (=5)", () => {
    const at0 = motifContentFrame(0, 1_000_000, 6_000_000, 30, 1);
    expect(at0.frame).toBe(30);
  });
  test("clamps to the last content frame", () => {
    const past = motifContentFrame(10_000_000, 0, 6_000_000, 30, 1);
    expect(past.frame).toBe(179);
  });
});
