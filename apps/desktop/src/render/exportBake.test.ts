// Unit tests for the PURE, Node-testable half of the export template bake:
// `templateLayersToBake` (layer selection + comp-fps frame-range math). The
// rasterize half (`exportBakeTemplates`) touches the DOM harness +
// `createImageBitmap`, so it's exercised end-to-end by the real-WebView2 e2e
// (`template_export.e2e.js`).
//
// The load-bearing invariant: a layer's baked frame range is computed on the
// COMPOSITION fps with the SAME `templateDurationFrames` / `frameIndexInLayer`
// math the Worker's `TemplateSprite.update` uses to look frames up. A drift
// here = export binds the wrong (or an out-of-range) frame. The first test
// pins exactly that: the full-range bake covers `[0, templateDurationFrames-1]`.

import { describe, expect, test } from "vitest";

import type { LayerParamsView, ProjectSummary, TemplateView } from "../ipc";
import { frameIndexInLayer, snapFrameFloor } from "../frames";
import { templateLayersToBake } from "./exportBake";
import { templateDurationFrames } from "./sprite/TemplateSprite";

const COUNTDOWN = "countdown"; // built-in, 480x480

function templateLayer(
  id: string,
  tStartUs: number,
  tEndUs: number,
  overrides: Partial<TemplateView> = {},
): { id: string; t_start_us: number; t_end_us: number; params: LayerParamsView } {
  const params: LayerParamsView = {
    kind: "Template",
    template_id: COUNTDOWN,
    x: 0,
    y: 0,
    scale_x: 1,
    scale_y: 1,
    opacity: 1,
    props: {},
    ...overrides,
  };
  return { id, t_start_us: tStartUs, t_end_us: tEndUs, params };
}

/// Minimal ProjectSummary carrying one track of the given layers. Only the
/// fields `templateLayersToBake` reads are populated; the rest is cast.
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

describe("templateLayersToBake", () => {
  test("full-range bake covers [0, templateDurationFrames-1] on COMP fps", () => {
    // 5 s @ 30 fps → 150 comp frames.
    const summary = summaryWith([templateLayer("L1", 0, 5_000_000)]);
    const specs = templateLayersToBake(summary, 0, 5_000_000, 30, 1);
    expect(specs).toHaveLength(1);
    const s = specs[0]!;
    expect(s.durationFrames).toBe(templateDurationFrames(5_000_000, 30, 1));
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
    const summary = summaryWith([templateLayer("L1", 0, 5_000_000)]);
    const specs = templateLayersToBake(summary, 0, 5_000_000, 30, 1);
    expect(specs[0]!.durationFrames).toBe(150);
  });

  test("a mid-layer export start narrows to the overlapping comp-frame window", () => {
    // 10 s layer @ 30 fps (300 frames). Export only [3s, 6s).
    const summary = summaryWith([templateLayer("L1", 0, 10_000_000)]);
    const specs = templateLayersToBake(summary, 3_000_000, 6_000_000, 30, 1);
    expect(specs).toHaveLength(1);
    const s = specs[0]!;
    expect(s.durationFrames).toBe(300);
    // frame index of t=3s is 90; t just under 6s is 179 (frame 180 starts at 6s,
    // which is excluded by the half-open range).
    expect(s.firstFrame).toBe(90);
    expect(s.lastFrame).toBe(179);
  });

  test("a layer offset on the timeline bakes from its own frame 0", () => {
    // Layer placed at t=2s, 5 s long → covers [2s, 7s). Templates have no
    // source-in offset, so frame 0 is at the layer's t_start (2s).
    const summary = summaryWith([templateLayer("L1", 2_000_000, 7_000_000)]);
    const specs = templateLayersToBake(summary, 0, 10_000_000, 30, 1);
    const s = specs[0]!;
    expect(s.durationFrames).toBe(150);
    expect(s.firstFrame).toBe(0);
    expect(s.lastFrame).toBe(149);
  });

  test("skips disabled layers, disabled tracks, and out-of-range layers", () => {
    const summary = summaryWith([
      templateLayer("on", 0, 5_000_000),
      { ...templateLayer("off", 0, 5_000_000), enabled: false },
      templateLayer("past", 8_000_000, 10_000_000), // outside [0, 5s)
    ]);
    const specs = templateLayersToBake(summary, 0, 5_000_000, 30, 1);
    expect(specs.map((s) => s.layerId)).toEqual(["on"]);

    const disabledTrack = templateLayersToBake(
      summaryWith([templateLayer("L1", 0, 5_000_000)], false),
      0,
      5_000_000,
      30,
      1,
    );
    expect(disabledTrack).toHaveLength(0);
  });

  test("skips non-Template layers and unknown template ids", () => {
    const summary = summaryWith([
      templateLayer("known", 0, 5_000_000),
      templateLayer("unknown", 0, 5_000_000, {
        template_id: "does-not-exist",
      } as Partial<TemplateView>),
    ]);
    const specs = templateLayersToBake(summary, 0, 5_000_000, 30, 1);
    expect(specs.map((s) => s.layerId)).toEqual(["known"]);
  });

  test("no Template layers → empty result", () => {
    const summary = summaryWith([]);
    expect(templateLayersToBake(summary, 0, 5_000_000, 30, 1)).toEqual([]);
  });

  test("frame-parity: off-grid startUs maps to the same firstFrame the Worker visits", () => {
    // Regression guard for the frame-parity bug: when the export range's
    // `startUs` is NOT on the composition-frame grid (reachable via "set range
    // to playhead" — `currentTimeUs` is not snapped), the bake must snap
    // `startUs` the same way the Worker does before computing `firstFrame`.
    //
    // Setup: 5 s Template layer at t_start=0, comp fps = 30/1.
    // At 30 fps a frame is 33_333 µs (floor of 33_333.333…). startUs=50_000 µs
    // falls inside frame 1's interval [33_333, 66_666) by the raw index math
    // (`Math.floor(50_000 * 30 / 1_000_000) = 1`), but the Worker's
    // `snapFrameFloor(50_000, 30, 1)` snaps DOWN to 0 µs (frame 0), so the
    // worker WILL request frame 0. Without the snap fix, `firstFrame` would
    // be 1, leaving `injectedFrames[0]` undefined → blank leading frame.
    const FPS_NUM = 30;
    const FPS_DEN = 1;
    const START_US = 50_000; // deliberately off-grid; between frame 0 (0µs) and frame 1 (~33_333µs)

    const summary = summaryWith([templateLayer("L1", 0, 5_000_000)]);
    const specs = templateLayersToBake(summary, START_US, 5_000_000, FPS_NUM, FPS_DEN);
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
