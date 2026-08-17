// Unit tests for the net-new, pure frame-selection math the MotifSprite
// uses to map a layer-relative time to (frame, frameTimeSec, cacheKey). The
// sprite itself constructs a Pixi Sprite + touches `createImageBitmap`, so it
// can't run in Node — these helpers are extracted so the arithmetic is
// testable without the browser surface. The async capture/bind chain is
// exercised end-to-end by the Electron e2e (`e2e/electron/motif-capture.spec.ts`).

import { describe, expect, test, it, vi } from "vitest";

// Pixi touches WebGL/DOM at module load; the sprite only needs `Sprite`,
// `Texture`, and `ImageSource` to exist as constructible stubs for the
// refresh-path tests (which never bind a real bitmap in Node).
vi.mock("pixi.js", () => {
  class FakeTexture {
    // `orig` is what `anchorPivot`'s textureExtent reads for the pivot; real
    // Pixi always carries it, so the double has to as well. 0×0 ⇒ pivot 0,
    // which is the correct answer for a texture with no bound raster.
    static EMPTY = { orig: { width: 0, height: 0 } };
    source: unknown;
    orig = { width: 0, height: 0 };
    constructor(opts?: { source?: unknown }) {
      this.source = opts?.source ?? null;
    }
    destroy() {}
  }
  class FakeSprite {
    texture: unknown = FakeTexture.EMPTY;
    position = { set: vi.fn() };
    pivot = { set: vi.fn() };
    scale = { set: vi.fn() };
    alpha = 1;
    zIndex = 0;
    constructor(tex?: unknown) {
      this.texture = tex ?? FakeTexture.EMPTY;
    }
    destroy() {}
  }
  class FakeImageSource {
    constructor(public opts: unknown) {}
  }
  return { Sprite: FakeSprite, Texture: FakeTexture, ImageSource: FakeImageSource };
});

// `getMotif` is controlled per-test so a "draft edit" (content_hash change) can
// be simulated between `update()` calls.
const getMotifMock = vi.fn();
vi.mock("../motifs/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../motifs/catalog")>();
  return { ...actual, getMotif: (id: string) => getMotifMock(id) };
});

// Observe the (cacheKey, frame) the sprite requests, and never resolve a real
// raster (the async path is irrelevant to the refresh-guard assertion).
const getFrameMock = vi.fn(
  (_cacheKey: string, _frame: number): ImageBitmap | null => null,
);
vi.mock("../motifs/motifRasterCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../motifs/motifRasterCache")>();
  return {
    ...actual,
    sharedMotifFrameCache: {
      getFrame: (cacheKey: string, frame: number) => getFrameMock(cacheKey, frame),
      setFrame: vi.fn((_k: string, _f: number, b: unknown) => b),
      readPng: vi.fn(async () => null),
    },
    resolveMotifFrame: vi.fn(async () => ({}) as unknown as ImageBitmap),
  };
});

import {
  frameTimeSec,
  motifContentFrame,
  motifDurationFrames,
  motifFrameCacheKey,
} from "../motifs/motifFrames";
import type { MotifManifest, Motif } from "../motifs/catalog";
import type { ResolvedMotifView } from "../resolveView";
import { MotifSprite } from "./MotifSprite";

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

describe("MotifSprite.refreshMotif", () => {
  // A minimal Motif whose only varying field is `content_hash` — which the
  // descriptor folds into the frame cache key (motifFrameDescriptor), so a
  // draft edit (new content_hash) MUST produce a different requested key.
  function motifWith(contentHash: string): Motif {
    const manifest: MotifManifest = {
      id: "d1",
      name: "Draft 1",
      version: 1,
      size: [480, 480],
      default_duration_s: 5,
      props_schema: {},
      content_hash: contentHash,
      status: "draft",
    };
    return { manifest, hasParamsUi: false };
  }

  const view: ResolvedMotifView = {
    motif_id: "d1",
    x: 0,
    y: 0,
    scale_x: 1,
    scale_y: 1,
    rotation_deg: 0,
    anchor_x: 0.5, anchor_y: 0.5,
    opacity: 1,
    src_in_us: 0,
    props: {},
  };

  function lastRequestedCacheKey(): string {
    const calls = getFrameMock.mock.calls;
    return calls[calls.length - 1]![0];
  }

  it("refreshMotif re-fetches the motif so the next update re-evaluates the key", () => {
    getFrameMock.mockClear();
    // getMotif: construction (#1) sees "A"; refreshMotif() re-fetch (#2) sees "B".
    getMotifMock.mockReset();
    getMotifMock.mockReturnValueOnce(motifWith("A")).mockReturnValueOnce(motifWith("B"));

    const sprite = new MotifSprite({ layerId: "L1", motifId: "d1", fpsNum: 30, fpsDen: 1 });
    sprite.update(view, 0, 5_000_000);
    expect(getFrameMock).toHaveBeenCalledTimes(1);
    const firstKey = lastRequestedCacheKey();

    // Same-time update WITHOUT refresh no-ops (cacheKey+frame unchanged).
    sprite.update(view, 0, 5_000_000);
    expect(getFrameMock).toHaveBeenCalledTimes(1);

    // After refreshMotif the next same-time update must NOT no-op: it
    // re-evaluates the key against the freshly-fetched motif ("B").
    sprite.refreshMotif();
    sprite.update(view, 0, 5_000_000);
    expect(getFrameMock).toHaveBeenCalledTimes(2);
    const secondKey = lastRequestedCacheKey();

    // content_hash A→B is part of the cache key → the key changed.
    expect(secondKey).not.toBe(firstKey);
  });

  it("refreshMotif is a no-op once the sprite is disposed", () => {
    getMotifMock.mockReset();
    getMotifMock.mockReturnValue(motifWith("A"));
    const sprite = new MotifSprite({ layerId: "L1", motifId: "d1", fpsNum: 30, fpsDen: 1 });
    sprite.dispose();
    expect(() => sprite.refreshMotif()).not.toThrow();
  });
});
