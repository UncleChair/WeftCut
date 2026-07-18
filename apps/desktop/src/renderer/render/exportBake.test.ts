// Unit tests for the export Motif bake. The PURE half (`motifLayersToBake`,
// `bakeContentFrameFor`) is fully Node-testable. The bake LOOP
// (`exportBakeMotifs`) is covered here too by mocking its CDP producer
// (`bakeMotifFrame`); the real CDP capture + encode is exercised end-to-end by
// the real-Chromium/Electron e2e (`e2e/electron/motif-export.spec.ts`).
//
// The load-bearing invariant: a layer's baked frame range is computed on the
// COMPOSITION fps with the SAME `motifDurationFrames` / `frameIndexInLayer`
// math the Worker's `MotifSprite.update` uses to look frames up. A drift
// here = export binds the wrong (or an out-of-range) frame. The first test
// pins exactly that: the full-range bake covers `[0, motifDurationFrames-1]`.

import { describe, expect, it, test, vi, beforeEach } from "vitest";

// Mock the CDP producer so the bake loop is Node-testable (no host/DOM).
vi.mock("./motifs/motifRaster", () => ({
  bakeMotifFrame: vi.fn(
    async (motif, frame) =>
      ({ tag: `${motif.manifest.id}#${frame}` }) as unknown as ImageBitmap,
  ),
}));

// Mock the disk-path infra (L2 baked key index + frame cache).
vi.mock("./motifs/motifRasterCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./motifs/motifRasterCache")>();
  return {
    ...actual,
    sharedBakedKeyIndex: { has: vi.fn(() => false) },
    sharedMotifFrameCache: {
      readPng: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })),
    },
  };
});

// Node/jsdom has no createImageBitmap; stub it so the disk-path test works.
(globalThis as unknown as { createImageBitmap: (b: Blob) => Promise<ImageBitmap> }).createImageBitmap =
  vi.fn(async () => ({ tag: "from-disk" }) as unknown as ImageBitmap);

import type { AnimTrack, LayerParamsView, ProjectSummary, MotifView } from "../ipc";
import { frameIndexInLayer, snapFrameFloor } from "../frames";
import { bakeContentFrameFor, motifLayersToBake, exportBakeMotifs } from "./exportBake";
import { motifContentFrame, motifDurationFrames } from "./motifs/motifFrames";
import { bakeMotifFrame } from "./motifs/motifRaster";
import { sharedBakedKeyIndex, sharedMotifFrameCache } from "./motifs/motifRasterCache";

const COUNTDOWN = "countdown"; // built-in, 480x480

const stat = (v: number): AnimTrack<number> => ({ mode: "Static", value: v });

function motifLayer(
  id: string,
  tStartUs: number,
  tEndUs: number,
  overrides: Partial<MotifView> = {},
): { id: string; t_start_us: number; t_end_us: number; params: LayerParamsView } {
  const params: LayerParamsView = {
    kind: "Motif",
    motif_id: COUNTDOWN,
    x: stat(0),
    y: stat(0),
    scale_x: stat(1),
    scale_y: stat(1),
    rotation_deg: stat(0),
    opacity: stat(1),
    src_in_us: 0,
    props: {},
    ...overrides,
  };
  return { id, t_start_us: tStartUs, t_end_us: tEndUs, params };
}

/// Minimal ProjectSummary carrying one track of the given layers. Only the
/// fields `motifLayersToBake` reads are populated; the rest is cast.
function summaryWith(
  layers: Array<{
    id: string;
    t_start_us: number;
    t_end_us: number;
    params: LayerParamsView;
    enabled?: boolean;
  }>,
  trackEnabled = true,
): ProjectSummary {
  return {
    tracks: [
      {
        enabled: trackEnabled,
        layers: layers.map((l) => ({
          enabled: l.enabled ?? true,
          ...l,
        })),
      },
    ],
  } as unknown as ProjectSummary;
}

describe("motifLayersToBake", () => {
  test("full-range bake covers [0, motifDurationFrames-1] on COMP fps", () => {
    // 5 s @ 30 fps → 150 comp frames.
    const summary = summaryWith([motifLayer("L1", 0, 5_000_000)]);
    const specs = motifLayersToBake(summary, 0, 5_000_000, 30, 1);
    expect(specs).toHaveLength(1);
    const s = specs[0]!;
    expect(s.durationFrames).toBe(motifDurationFrames(5_000_000, 30, 1));
    expect(s.durationFrames).toBe(150);
    // The whole animation is baked: first frame 0, last frame 149.
    expect(s.firstFrame).toBe(0);
    expect(s.lastFrame).toBe(s.durationFrames - 1);
    expect(s.lastFrame).toBe(149);
    // Total baked count == the full comp-frame count.
    expect(s.lastFrame - s.firstFrame + 1).toBe(s.durationFrames);
  });

  test("output-fps independence: the bake count tracks COMP fps, not the export's output fps", () => {
    // Whatever output fps the caller later picks, the bake is always on the
    // comp fps passed here. Pass comp fps = 30 even for a hypothetical 60fps
    // OUTPUT export: 150 frames, not 300.
    const summary = summaryWith([motifLayer("L1", 0, 5_000_000)]);
    const specs = motifLayersToBake(summary, 0, 5_000_000, 30, 1);
    expect(specs[0]!.durationFrames).toBe(150);
  });

  test("a mid-layer export start narrows to the overlapping comp-frame window", () => {
    // 10 s layer @ 30 fps (300 frames). Export only [3s, 6s).
    const summary = summaryWith([motifLayer("L1", 0, 10_000_000)]);
    const specs = motifLayersToBake(summary, 3_000_000, 6_000_000, 30, 1);
    expect(specs).toHaveLength(1);
    const s = specs[0]!;
    expect(s.durationFrames).toBe(300);
    // frame index of t=3s is 90; t just under 6s is 179 (frame 180 starts at 6s,
    // which is excluded by the half-open range).
    expect(s.firstFrame).toBe(90);
    expect(s.lastFrame).toBe(179);
  });

  test("a layer offset on the timeline bakes from its own frame 0", () => {
    // Layer placed at t=2s, 5 s long → covers [2s, 7s). Motifs have no
    // source-in offset, so frame 0 is at the layer's t_start (2s).
    const summary = summaryWith([motifLayer("L1", 2_000_000, 7_000_000)]);
    const specs = motifLayersToBake(summary, 0, 10_000_000, 30, 1);
    const s = specs[0]!;
    expect(s.durationFrames).toBe(150);
    expect(s.firstFrame).toBe(0);
    expect(s.lastFrame).toBe(149);
  });

  test("skips disabled layers, disabled tracks, and out-of-range layers", () => {
    const summary = summaryWith([
      motifLayer("on", 0, 5_000_000),
      { ...motifLayer("off", 0, 5_000_000), enabled: false },
      motifLayer("past", 8_000_000, 10_000_000), // outside [0, 5s)
    ]);
    const specs = motifLayersToBake(summary, 0, 5_000_000, 30, 1);
    expect(specs.map((s) => s.layerId)).toEqual(["on"]);

    const disabledTrack = motifLayersToBake(
      summaryWith([motifLayer("L1", 0, 5_000_000)], false),
      0,
      5_000_000,
      30,
      1,
    );
    expect(disabledTrack).toHaveLength(0);
  });

  test("skips non-Motif layers and unknown motif ids", () => {
    const summary = summaryWith([
      motifLayer("known", 0, 5_000_000),
      motifLayer("unknown", 0, 5_000_000, {
        motif_id: "does-not-exist",
      } as Partial<MotifView>),
    ]);
    const specs = motifLayersToBake(summary, 0, 5_000_000, 30, 1);
    expect(specs.map((s) => s.layerId)).toEqual(["known"]);
  });

  test("no Motif layers → empty result", () => {
    const summary = summaryWith([]);
    expect(motifLayersToBake(summary, 0, 5_000_000, 30, 1)).toEqual([]);
  });

  test("frame-parity: off-grid startUs maps to the same firstFrame the Worker visits", () => {
    // Regression guard for the frame-parity bug: when the export range's
    // `startUs` is NOT on the composition-frame grid (reachable via "set range
    // to playhead" — `currentTimeUs` is not snapped), the bake must snap
    // `startUs` the same way the Worker does before computing `firstFrame`.
    //
    // Setup: 5 s Motif layer at t_start=0, comp fps = 30/1.
    // At 30 fps a frame is 33_333 µs (floor of 33_333.333…). startUs=50_000 µs
    // falls inside frame 1's interval [33_333, 66_666) by the raw index math
    // (`Math.floor(50_000 * 30 / 1_000_000) = 1`), but the Worker's
    // `snapFrameFloor(50_000, 30, 1)` snaps DOWN to 0 µs (frame 0), so the
    // worker WILL request frame 0. Without the snap fix, `firstFrame` would
    // be 1, leaving `injectedFrames[0]` undefined → blank leading frame.
    const FPS_NUM = 30;
    const FPS_DEN = 1;
    const START_US = 50_000; // deliberately off-grid; between frame 0 (0µs) and frame 1 (~33_333µs)

    const summary = summaryWith([motifLayer("L1", 0, 5_000_000)]);
    const specs = motifLayersToBake(summary, START_US, 5_000_000, FPS_NUM, FPS_DEN);
    expect(specs).toHaveLength(1);
    const s = specs[0]!;

    // The Worker snaps `tUs` with `snapFrameFloor` before subtracting
    // `t_start_us`, so the first frame it requests equals:
    const expectedFirstFrame = frameIndexInLayer(
      snapFrameFloor(START_US, FPS_NUM, FPS_DEN) - 0, // t_start_us = 0
      FPS_NUM,
      FPS_DEN,
    );
    // `snapFrameFloor(50_000, 30, 1) = 0` → frameIndexInLayer(0, …) = 0.
    expect(expectedFirstFrame).toBe(0);

    // The bake's firstFrame must match the worker's first request — frame 0
    // must be baked so `injectedFrames[0]` is defined, not a hole.
    expect(s.firstFrame).toBe(expectedFirstFrame);

    // Demonstrate what the OLD (unsnapped) code would have returned, to prove
    // this test genuinely guards the regression: raw index of 50_000 µs into a
    // layer starting at 0 is frame 1 — one frame AHEAD of what the worker
    // requests, causing a blank leading frame.
    const rawFirstFrame = frameIndexInLayer(START_US - 0, FPS_NUM, FPS_DEN);
    expect(rawFirstFrame).toBe(1); // confirms the old code would have been wrong
    // And the fixed code does NOT return the stale raw value.
    expect(s.firstFrame).not.toBe(rawFirstFrame);
  });
});

// ---------------------------------------------------------------------------
// Export bake / preview PARITY tests
//
// The core invariant: for every layer-local frame `f` that the export Worker
// will request, `bakeContentFrameFor(f, ...)` must return the SAME content
// frame as the live preview's `motifContentFrame(tInLayerUs, ...)`. The
// compositor derives `tInLayerUs = snapFrameFloor(compFrameUs) - t_start_us`;
// this helper reconstructs that exactly so that floor(a+b) ≠ floor(a)+floor(b)
// divergences at /1001 fps boundaries are eliminated.
// ---------------------------------------------------------------------------

const US = 1_000_000;

/// Reproduce the compositor's content-frame selection for an absolute comp
/// frame index, mirroring MotifSprite.update's preview path.
function previewContentFrameAt(
  compFrameIdx: number,
  tStartUs: number,
  srcInUs: number,
  contentDurUs: number,
  n: number,
  d: number,
): number {
  const compFrameUs = snapFrameFloor(Math.round((compFrameIdx * US * d) / n), n, d);
  const tInLayerUs = compFrameUs - tStartUs;
  return motifContentFrame(tInLayerUs, srcInUs, contentDurUs, n, d).frame;
}

describe("export bake matches preview content frame (windowed motif)", () => {
  it("agrees for every layer-local frame at 29.97fps with src_in>0 and t_start>0", () => {
    const n = 30000, d = 1001;
    // Layer starts at comp frame 30, src_in scrubbed in by ~1s, content 6s.
    const tStartFrame = 30;
    const tStartUs = snapFrameFloor(Math.round((tStartFrame * US * d) / n), n, d);
    const srcInUs = snapFrameFloor(Math.round((30 * US * d) / n), n, d); // ~1s, grid-aligned
    const contentDurUs = 6 * US;
    const layerWidthFrames = 90; // 3s window
    const mismatches: number[] = [];
    for (let f = 0; f < layerWidthFrames; f++) {
      const preview = previewContentFrameAt(tStartFrame + f, tStartUs, srcInUs, contentDurUs, n, d);
      const bake = bakeContentFrameFor(f, tStartUs, srcInUs, contentDurUs, n, d);
      if (preview !== bake) mismatches.push(f);
    }
    expect(mismatches).toEqual([]);
  });

  it("agrees with src_in==0 and t_start==0 (legacy/common path)", () => {
    const n = 30000, d = 1001;
    const tStartUs = 0;
    const srcInUs = 0;
    const contentDurUs = 6 * US;
    const layerWidthFrames = 90;
    const mismatches: number[] = [];
    for (let f = 0; f < layerWidthFrames; f++) {
      const preview = previewContentFrameAt(f, tStartUs, srcInUs, contentDurUs, n, d);
      const bake = bakeContentFrameFor(f, tStartUs, srcInUs, contentDurUs, n, d);
      if (preview !== bake) mismatches.push(f);
    }
    expect(mismatches).toEqual([]);
  });

  it("agrees for every layer-local frame at 30fps (integer rate) with src_in>0", () => {
    const n = 30, d = 1;
    const tStartFrame = 15;
    const tStartUs = snapFrameFloor(Math.round((tStartFrame * US * d) / n), n, d);
    const srcInUs = snapFrameFloor(Math.round((10 * US * d) / n), n, d);
    const contentDurUs = 5 * US;
    const layerWidthFrames = 60;
    const mismatches: number[] = [];
    for (let f = 0; f < layerWidthFrames; f++) {
      const preview = previewContentFrameAt(tStartFrame + f, tStartUs, srcInUs, contentDurUs, n, d);
      const bake = bakeContentFrameFor(f, tStartUs, srcInUs, contentDurUs, n, d);
      if (preview !== bake) mismatches.push(f);
    }
    expect(mismatches).toEqual([]);
  });

  it("agrees for every layer-local frame at 24fps with src_in>0", () => {
    const n = 24, d = 1;
    const tStartFrame = 24; // 1s in
    const tStartUs = snapFrameFloor(Math.round((tStartFrame * US * d) / n), n, d);
    const srcInUs = snapFrameFloor(Math.round((12 * US * d) / n), n, d); // 0.5s in
    const contentDurUs = 4 * US;
    const layerWidthFrames = 48;
    const mismatches: number[] = [];
    for (let f = 0; f < layerWidthFrames; f++) {
      const preview = previewContentFrameAt(tStartFrame + f, tStartUs, srcInUs, contentDurUs, n, d);
      const bake = bakeContentFrameFor(f, tStartUs, srcInUs, contentDurUs, n, d);
      if (preview !== bake) mismatches.push(f);
    }
    expect(mismatches).toEqual([]);
  });

  it("agrees for every layer-local frame at 23.976fps with src_in>0 and t_start>0", () => {
    const n = 24000, d = 1001;
    const tStartFrame = 24;
    const tStartUs = snapFrameFloor(Math.round((tStartFrame * US * d) / n), n, d);
    const srcInUs = snapFrameFloor(Math.round((24 * US * d) / n), n, d);
    const contentDurUs = 5 * US;
    const layerWidthFrames = 72;
    const mismatches: number[] = [];
    for (let f = 0; f < layerWidthFrames; f++) {
      const preview = previewContentFrameAt(tStartFrame + f, tStartUs, srcInUs, contentDurUs, n, d);
      const bake = bakeContentFrameFor(f, tStartUs, srcInUs, contentDurUs, n, d);
      if (preview !== bake) mismatches.push(f);
    }
    expect(mismatches).toEqual([]);
  });

  it("agrees for every layer-local frame at 59.94fps with src_in>0 and t_start>0", () => {
    const n = 60000, d = 1001;
    const tStartFrame = 60;
    const tStartUs = snapFrameFloor(Math.round((tStartFrame * US * d) / n), n, d);
    const srcInUs = snapFrameFloor(Math.round((60 * US * d) / n), n, d);
    const contentDurUs = 6 * US;
    const layerWidthFrames = 180;
    const mismatches: number[] = [];
    for (let f = 0; f < layerWidthFrames; f++) {
      const preview = previewContentFrameAt(tStartFrame + f, tStartUs, srcInUs, contentDurUs, n, d);
      const bake = bakeContentFrameFor(f, tStartUs, srcInUs, contentDurUs, n, d);
      if (preview !== bake) mismatches.push(f);
    }
    expect(mismatches).toEqual([]);
  });
});

describe("exportBakeMotifs → CDP (bakeMotifFrame)", () => {
  beforeEach(() => {
    (bakeMotifFrame as unknown as ReturnType<typeof vi.fn>).mockClear();
    (sharedBakedKeyIndex.has as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it("bakes a countdown layer's frames via bakeMotifFrame, indexed by comp frame", async () => {
    const summary = summaryWith([motifLayer("L1", 0, 2_000_000)]);
    const out = await exportBakeMotifs(summary, 0, 2_000_000, 30, 1);
    const frames = out["L1"]!;
    expect(frames).toBeDefined();
    expect(frames.length).toBe(60);
    expect((frames[0] as unknown as { tag: string }).tag).toBe("countdown#0");
    expect((frames[59] as unknown as { tag: string }).tag).toBe("countdown#59");
    expect(bakeMotifFrame).toHaveBeenCalledTimes(60);
    expect(bakeMotifFrame).toHaveBeenCalledWith(
      expect.objectContaining({ manifest: expect.objectContaining({ id: "countdown" }) }),
      0,
      30,
      1,
      expect.any(Object),
    );
  });
});

describe("exportBakeMotifs → L2 disk fast path", () => {
  beforeEach(() => {
    (bakeMotifFrame as unknown as ReturnType<typeof vi.fn>).mockClear();
    (sharedBakedKeyIndex.has as ReturnType<typeof vi.fn>).mockReturnValue(true);
    // Default the disk read to a HIT; the miss test below overrides it.
    (sharedMotifFrameCache.readPng as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    );
  });

  it("reads L2 PNGs off disk and does NOT re-capture when the key is baked", async () => {
    const summary = summaryWith([motifLayer("L1", 0, 2_000_000)]);
    const out = await exportBakeMotifs(summary, 0, 2_000_000, 30, 1);
    expect(out["L1"]!.length).toBe(60);
    expect((out["L1"]![0] as unknown as { tag: string }).tag).toBe("from-disk");
    expect(bakeMotifFrame).toHaveBeenCalledTimes(0);
  });

  it("falls back to CDP capture when the key is baked but the PNG is missing on disk", async () => {
    // Stale index (key marked baked) but readPng returns null — must NOT blank
    // the export: fall through to a live capture for every such frame.
    (sharedMotifFrameCache.readPng as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const summary = summaryWith([motifLayer("L1", 0, 2_000_000)]);
    const out = await exportBakeMotifs(summary, 0, 2_000_000, 30, 1);
    expect(out["L1"]!.length).toBe(60);
    expect((out["L1"]![0] as unknown as { tag: string }).tag).toBe("countdown#0");
    expect(bakeMotifFrame).toHaveBeenCalledTimes(60);
  });
});
