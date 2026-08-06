import { Container, DOMAdapter, Graphics, Mesh, type Application } from "pixi.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { LayerSummary, ProjectSummary, TrackSummary } from "../ipc";
import { Compositor } from "./Compositor";
import type { DecoderPool } from "./decoder/session";

// GlProgram construction probes fragment precision through a DOMAdapter test
// canvas; node has no document, so hand the adapter a context-less canvas
// (Pixi falls back to mediump). Deliberately NOT a `document` stub — that
// would flip the Compositor's DOM gates (prewarmer/baker) on.
const realAdapter = DOMAdapter.get();
beforeAll(() => {
  DOMAdapter.set({
    ...realAdapter,
    createCanvas: () =>
      ({ getContext: () => null }) as unknown as ReturnType<typeof realAdapter.createCanvas>,
  });
});
afterAll(() => {
  DOMAdapter.set(realAdapter);
});

// The two-input transition node at the Compositor seam: inside the window
// the sweep diverts both participants into offscreen sides (rendered to
// pooled RTs) and stages ONE full-frame quad; outside it, normal drawing.
// Color layers keep this headless (Graphics need no decoder/GL upload —
// same trick as Compositor.presentation.test.ts).

function colorLayer(id: string, tStartUs: number, tEndUs: number): LayerSummary {
  return {
    id,
    label: id,
    t_start_us: tStartUs,
    t_end_us: tEndUs,
    kind: "Color",
    color_hint: "#4488cc",
    enabled: true,
    locked: false,
    params: {
      kind: "Color",
      color: { mode: "Static", value: { r: 10, g: 20, b: 30, a: 255 } },
      width: 1920,
      height: 1080,
    },
    effects: [],
  };
}

// Start-at-cut shape: A extended over the overlap, window = [1s, 2s).
const layerA = colorLayer("layer-a", 0, 2_000_000);
const layerB = colorLayer("layer-b", 1_000_000, 3_000_000);

const track: TrackSummary = {
  id: "track-1",
  kind: "Video",
  label: "V1",
  enabled: true,
  locked: false,
  muted: false,
  solo: false,
  role: "a-roll",
  transient: false,
  layers: [layerA, layerB],
};

const summary: ProjectSummary = {
  project_id: "project-1",
  name: "Transition Node",
  composition: {
    width: 1920,
    height: 1080,
    fps_num: 30,
    fps_den: 1,
    duration_pinned: false,
    fps_locked: false,
  },
  track_count: 1,
  layer_count: 2,
  duration_us: 3_000_000,
  history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
  media: [],
  tracks: [track],
  markers: [],
  transitions: [
    {
      id: "tr-1",
      from_layer: "layer-a",
      to_layer: "layer-b",
      duration_us: 1_000_000,
      kind: { kind: "Crossfade" },
    },
  ],
  groups: [],
  audio_roles: [],
};

interface RenderCall {
  containerChildren: number;
  target: unknown;
  clearColor: unknown;
}

describe("Compositor transition divert", () => {
  let compositor: Compositor;
  let renderCalls: RenderCall[];

  beforeEach(() => {
    // `setCompositionSize` schedules a repaint; node has no rAF. Collect the
    // callbacks rather than running them — these tests drive `compositeFrame`
    // themselves (same stub as Compositor.presentation.test.ts).
    vi.stubGlobal("requestAnimationFrame", () => 1);
    renderCalls = [];
    const renderer = {
      // "gl" selects the WebGL RT format branch; render records side bakes.
      gl: {},
      render: (opts: { container: Container; target: unknown; clearColor: unknown }) => {
        renderCalls.push({
          containerChildren: opts.container.children.length,
          target: opts.target,
          clearColor: opts.clearColor,
        });
      },
    };
    compositor = new Compositor({
      app: { stage: new Container(), renderer } as unknown as Application,
      width: 1920,
      height: 1080,
      mode: "export",
      originalAssetUrl: () => null,
      sourceColor: () => undefined,
      mediaById: () => undefined,
      pool: { dispose: vi.fn() } as unknown as DecoderPool,
    });
    compositor.setProject(summary);
  });

  afterEach(() => {
    compositor.dispose();
  });

  it("outside the window both layers draw normally, no quad, no node", () => {
    compositor.compositeFrame(500_000); // only A active
    expect(compositor.stage.children).toHaveLength(1);
    expect(compositor.stage.children[0]).toBeInstanceOf(Graphics);
    expect(renderCalls).toHaveLength(0);
    expect(compositor.getPerfSnapshot().transitions).toBeNull();
  });

  it("inside the window the participants divert and one quad stages", () => {
    compositor.compositeFrame(1_500_000);
    // Stage holds ONLY the quad — both Graphics went to offscreen sides.
    expect(compositor.stage.children).toHaveLength(1);
    expect(compositor.stage.children[0]).toBeInstanceOf(Mesh);
    // Both sides baked, each holding its one diverted sprite, transparent clear.
    expect(renderCalls).toHaveLength(2);
    for (const call of renderCalls) {
      expect(call.containerChildren).toBe(1);
      expect(call.clearColor).toEqual([0, 0, 0, 0]);
    }
    expect(renderCalls[0]!.target).not.toBe(renderCalls[1]!.target);
    // Linear progress at the window midpoint.
    const quad = compositor.stage.children[0] as Mesh;
    const uniforms = (
      quad.shader!.resources as { transition: { uniforms: { uProgress: number } } }
    ).transition.uniforms;
    expect(uniforms.uProgress).toBeCloseTo(0.5, 5);
    expect(compositor.getPerfSnapshot().transitions).toMatchObject({
      nodes: 1,
      rt: { outstanding: 2, created: 2 },
    });
  });

  it("replaying the window never allocates another RT (pool reuse)", () => {
    for (let tUs = 1_000_000; tUs < 2_000_000; tUs += 33_334) {
      compositor.compositeFrame(tUs);
    }
    expect(compositor.getPerfSnapshot().transitions).toMatchObject({
      nodes: 1,
      rt: { outstanding: 2, created: 2 },
    });
    // Leaving and re-entering the window reuses the pooled pair.
    compositor.compositeFrame(2_500_000);
    expect(compositor.getPerfSnapshot().transitions).toMatchObject({
      nodes: 0,
      rt: { outstanding: 0, free: 2, created: 2 },
    });
    compositor.compositeFrame(1_500_000);
    expect(compositor.getPerfSnapshot().transitions).toMatchObject({
      nodes: 1,
      rt: { outstanding: 2, created: 2 },
    });
  });

  it("past the window the node releases and normal drawing resumes", () => {
    compositor.compositeFrame(1_500_000);
    compositor.compositeFrame(2_500_000); // only B active
    expect(compositor.stage.children).toHaveLength(1);
    expect(compositor.stage.children[0]).toBeInstanceOf(Graphics);
    expect(compositor.getPerfSnapshot().transitions).toMatchObject({
      nodes: 0,
      rt: { outstanding: 0, free: 2 },
    });
  });

  // Why the drain is required: see `Compositor.setCompositionSize`.
  it("a composition resize drains the transition RT pool", () => {
    compositor.compositeFrame(1_500_000);
    compositor.compositeFrame(2_500_000); // node released, both RTs back free
    expect(compositor.getPerfSnapshot().transitions).toMatchObject({
      rt: { free: 2, outstanding: 0 },
    });

    compositor.setCompositionSize(1280, 720);
    expect(compositor.getPerfSnapshot().transitions).toMatchObject({
      rt: { free: 0, outstanding: 0, destroyed: 2 },
    });

    const after = compositor.getPerfSnapshot().transitions;
    compositor.setCompositionSize(1280, 720); // same size → no-op
    expect(compositor.getPerfSnapshot().transitions).toEqual(after);
  });

  it("a composition resize before any transition node exists is safe", () => {
    compositor.setCompositionSize(1280, 720);
    expect(compositor.getPerfSnapshot().transitions).toBeNull();
    compositor.compositeFrame(1_500_000);
    expect(compositor.stage.children[0]).toBeInstanceOf(Mesh);
  });

  it("the exact window start diverts; the exact end does not", () => {
    compositor.compositeFrame(1_000_000);
    expect(compositor.stage.children[0]).toBeInstanceOf(Mesh);
    compositor.compositeFrame(2_000_000);
    // A ended at 2s (exclusive) — only B draws, normally.
    expect(compositor.stage.children).toHaveLength(1);
    expect(compositor.stage.children[0]).toBeInstanceOf(Graphics);
  });
});
