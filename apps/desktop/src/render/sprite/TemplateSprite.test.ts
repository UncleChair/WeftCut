// Unit tests for the net-new, pure frame-selection math the TemplateSprite
// uses to map a layer-relative time to (frame, frameTimeSec, cacheKey). The
// sprite itself constructs a Pixi Sprite + touches `createImageBitmap`, so it
// can't run in Node — these helpers are extracted so the arithmetic is
// testable without the browser surface. The async capture/bind chain is
// exercised end-to-end by the real-WebView2 e2e (`templates.e2e.js`).

import { describe, expect, test } from "vitest";

import {
  frameTimeSec,
  templateDurationFrames,
  templateFrameCacheKey,
} from "./TemplateSprite";

describe("templateDurationFrames", () => {
  test("exact-rational frame count over the duration (30fps)", () => {
    // 5 s @ 30 fps = 150 frames.
    expect(templateDurationFrames(5_000_000, 30, 1)).toBe(150);
    // 10 s @ 30 fps = 300 frames.
    expect(templateDurationFrames(10_000_000, 30, 1)).toBe(300);
  });

  test("clamps to at least 1 frame for sub-frame / zero durations", () => {
    expect(templateDurationFrames(0, 30, 1)).toBe(1);
    expect(templateDurationFrames(1, 30, 1)).toBe(1);
    // ~16.6ms is under one 30fps frame → still 1.
    expect(templateDurationFrames(16_000, 30, 1)).toBe(1);
  });

  test("degenerate fps falls back to 1", () => {
    expect(templateDurationFrames(5_000_000, 0, 1)).toBe(1);
    expect(templateDurationFrames(5_000_000, 30, 0)).toBe(1);
  });

  test("honors a non-1 fps denominator (29.97)", () => {
    // 1 s @ 30000/1001 ≈ 29.97 → round(1e6 * 30000 / (1e6 * 1001)) ≈ 30.
    expect(templateDurationFrames(1_000_000, 30000, 1001)).toBe(30);
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

describe("templateFrameCacheKey", () => {
  const base = {
    templateId: "countdown",
    version: 1,
    canonicalProps: { from: 5 },
    renderW: 1920,
    renderH: 1080,
    fpsNum: 30,
    fpsDen: 1,
    durationFrames: 150,
  };

  test("is deterministic for identical input", () => {
    expect(templateFrameCacheKey(base)).toBe(templateFrameCacheKey({ ...base }));
  });

  test("does NOT embed the frame index (cache appends #<frame>)", () => {
    expect(templateFrameCacheKey(base)).not.toMatch(/#\d+$/);
  });

  test("changes with each keyed dimension", () => {
    const k = templateFrameCacheKey(base);
    expect(templateFrameCacheKey({ ...base, version: 2 })).not.toBe(k);
    expect(templateFrameCacheKey({ ...base, durationFrames: 300 })).not.toBe(k);
    expect(templateFrameCacheKey({ ...base, fpsNum: 60 })).not.toBe(k);
    expect(templateFrameCacheKey({ ...base, renderW: 1280 })).not.toBe(k);
    expect(templateFrameCacheKey({ ...base, canonicalProps: { from: 9 } })).not.toBe(k);
  });
});
