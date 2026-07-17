import { Container, type Application } from "pixi.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LayerSummary, ProjectSummary, TrackSummary } from "../ipc";
import { Compositor } from "./Compositor";
import type { DecoderPool } from "./decoder/session";

// The Dock-presentation gate (issue 07's contract at the Compositor level):
// a hidden Preview keeps the owner clock ticking but freezes presented
// output; re-showing schedules exactly one catch-up repaint.

const colorLayer: LayerSummary = {
  id: "layer-1",
  label: "Color A",
  t_start_us: 0,
  t_end_us: 2_000_000,
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
  layers: [colorLayer],
};

const summary: ProjectSummary = {
  project_id: "project-1",
  name: "Presentation Gate",
  composition: {
    width: 1920,
    height: 1080,
    fps_num: 30,
    fps_den: 1,
    duration_pinned: false,
  },
  track_count: 1,
  layer_count: 1,
  duration_us: 2_000_000,
  history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
  media: [],
  tracks: [track],
  markers: [],
  groups: [],
  audio_roles: [],
};

describe("Compositor presentation gate", () => {
  let compositor: Compositor;
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    rafCallbacks = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    compositor = new Compositor({
      // Real scene-graph Containers; only the renderer is absent (node env).
      app: { stage: new Container() } as unknown as Application,
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
    vi.unstubAllGlobals();
  });

  function runRepaint(): void {
    const callbacks = rafCallbacks.splice(0);
    expect(callbacks.length).toBeGreaterThan(0);
    for (const cb of callbacks) cb(0);
  }

  it("freezes presented output while hidden while the owner clock keeps ticking", () => {
    compositor.compositeFrame(0);
    expect(compositor.presentationSnapshot()).toEqual({
      visible: true,
      dirty: false,
      ownerCompositeCount: 1,
      presentedCompositeCount: 1,
    });

    compositor.setPresentationVisible(false);
    expect(compositor.presentationSnapshot().dirty).toBe(true);

    compositor.compositeFrame(33_333);
    compositor.compositeFrame(66_666);
    const snap = compositor.presentationSnapshot();
    expect(snap.ownerCompositeCount).toBe(3);
    expect(snap.presentedCompositeCount).toBe(1);
    expect(snap.dirty).toBe(true);
  });

  it("does not stage visuals for hidden frames", () => {
    compositor.compositeFrame(0);
    const staged = compositor.stage.children.length;
    expect(staged).toBeGreaterThan(0);

    compositor.setPresentationVisible(false);
    compositor.compositeFrame(33_333);
    expect(compositor.stage.children.length).toBe(0);
  });

  it("schedules exactly one catch-up repaint on re-show and resumes presentation", () => {
    compositor.compositeFrame(0);
    compositor.setPresentationVisible(false);
    compositor.compositeFrame(33_333);
    compositor.compositeFrame(66_666);
    expect(compositor.presentationSnapshot().presentedCompositeCount).toBe(1);

    compositor.setPresentationVisible(true);
    expect(rafCallbacks).toHaveLength(1);
    runRepaint();

    const snap = compositor.presentationSnapshot();
    expect(snap.presentedCompositeCount).toBe(2);
    expect(snap.dirty).toBe(false);
    expect(compositor.stage.children.length).toBeGreaterThan(0);
  });

  it("scheduleRepaint while hidden only marks dirty — no frame is scheduled", () => {
    compositor.compositeFrame(0);
    compositor.setPresentationVisible(false);
    rafCallbacks.length = 0;

    compositor.scheduleRepaint();
    expect(rafCallbacks).toHaveLength(0);
    expect(compositor.presentationSnapshot().dirty).toBe(true);

    // Idempotence: re-hiding or re-showing the current state schedules nothing.
    compositor.setPresentationVisible(false);
    expect(rafCallbacks).toHaveLength(0);

    compositor.setPresentationVisible(true);
    expect(rafCallbacks).toHaveLength(1);
    runRepaint();
    expect(compositor.presentationSnapshot().presentedCompositeCount).toBe(2);
  });
});
