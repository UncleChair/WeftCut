import { Container, type Application } from "pixi.js";
import { describe, expect, it, vi } from "vitest";

import type { LayerSummary, ProjectSummary, TrackSummary } from "../ipc";
import { Compositor } from "./Compositor";
import type { DecoderPool } from "./decoder/session";

// Decode sessions are pool-owned and keyed by LAYER id, so the only thing that
// frees one — and, on the ffmpeg hardware lane, the GPU session inside it — is
// an explicit `pool.release`. The Compositor tears clips down in two places and
// for a long time neither released: the pool held the handle until its idle
// sweep noticed seconds later, and a clip resolving inside that window raced
// admission against layers the user had already deleted. Losing that race is
// permanent, because the lane is picked once per source. These tests
// pin the release rather than the teardown, since the teardown was never the
// part that broke.

const colorLayer: LayerSummary = {
  id: "layer-keep",
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

function summaryWith(layers: LayerSummary[]): ProjectSummary {
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
    layers,
  };
  return {
    project_id: "project-1",
    name: "Session lifetime",
    composition: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, duration_pinned: false },
    track_count: 1,
    layer_count: layers.length,
    duration_us: 2_000_000,
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [],
    tracks: [track],
    markers: [],
    groups: [],
    audio_roles: [],
  };
}

/// A clip is only ever built by `ensureClip`, which needs a resolver, a live
/// pool and a GL-backed sprite — none of which exist in the node environment.
/// The teardown contract under test doesn't depend on any of that, so the clip
/// is injected with just the surface `setProject`'s eviction loop touches.
function injectClip(compositor: Compositor, layerId: string, mediaId: string) {
  const sprite = { dispose: vi.fn() };
  const effects = { dispose: vi.fn() };
  const clips = (compositor as unknown as { clips: Map<string, unknown> }).clips;
  clips.set(layerId, { layerId, mediaId, sprite, effects, source: { disposed: false } });
  return { sprite, effects };
}

describe("Compositor decode-session lifetime", () => {
  function setup() {
    const release = vi.fn();
    const compositor = new Compositor({
      app: { stage: new Container() } as unknown as Application,
      width: 1920,
      height: 1080,
      mode: "export",
      originalAssetUrl: () => null,
      sourceColor: () => undefined,
      mediaById: () => undefined,
      pool: { dispose: vi.fn(), release } as unknown as DecoderPool,
    });
    return { compositor, release };
  }

  it("releases a vanished layer's decode session, not just its sprite", () => {
    const { compositor, release } = setup();
    compositor.setProject(summaryWith([colorLayer]));
    const { sprite, effects } = injectClip(compositor, "layer-gone", "media-1");

    compositor.setProject(summaryWith([colorLayer]));

    expect(release).toHaveBeenCalledWith("layer-gone");
    expect(sprite.dispose).toHaveBeenCalled();
    expect(effects.dispose).toHaveBeenCalled();
    compositor.dispose();
  });

  // A COMPLETED overlap-swap leaves `clip.source` under `${layerId}#swap` with
  // the base key already released, so releasing only the layer id would leak
  // the handle that is actually decoding. `abandonSwap` cannot cover it — by
  // then the swap state is gone.
  it("releases the swap key too, so a completed swap can't strand its handle", () => {
    const { compositor, release } = setup();
    compositor.setProject(summaryWith([colorLayer]));
    injectClip(compositor, "layer-gone", "media-1");

    compositor.setProject(summaryWith([colorLayer]));

    expect(release).toHaveBeenCalledWith("layer-gone#swap");
    compositor.dispose();
  });

  it("leaves a surviving layer's session alone", () => {
    const { compositor, release } = setup();
    compositor.setProject(summaryWith([colorLayer]));
    injectClip(compositor, "layer-keep", "media-1");

    compositor.setProject(summaryWith([colorLayer]));

    expect(release).not.toHaveBeenCalled();
    compositor.dispose();
  });
});
