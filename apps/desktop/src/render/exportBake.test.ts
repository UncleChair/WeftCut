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
});
