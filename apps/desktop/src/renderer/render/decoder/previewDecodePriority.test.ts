import { describe, expect, it } from "vitest";

import type { LayerSummary, ProjectSummary, TrackSummary } from "../../ipc";
import { planPreviewDecodePriority } from "./previewDecodePriority";

function video(
  id: string,
  startUs: number,
  endUs: number,
  enabled = true,
): LayerSummary {
  return {
    id,
    label: id,
    t_start_us: startUs,
    t_end_us: endUs,
    kind: "VideoClip",
    color_hint: "#000000",
    enabled,
    locked: false,
    params: {
      kind: "VideoClip",
      media_id: `media-${id}`,
      media_label: id,
      src_in_us: 0,
      src_out_us: endUs - startUs,
      speed: 1,
      opacity: { mode: "Static", value: 1 },
      x: { mode: "Static", value: 0 },
      y: { mode: "Static", value: 0 },
      scale_x: { mode: "Static", value: 1 },
      scale_y: { mode: "Static", value: 1 },
      rotation_deg: { mode: "Static", value: 0 },
      flip_h: false,
      flip_v: false,
      fade_in_us: 0,
      fade_out_us: 0,
    },
    effects: [],
  };
}

function summary(layers: LayerSummary[]): ProjectSummary {
  const track: TrackSummary = {
    id: "track",
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
    project_id: "project",
    name: "Priority",
    composition: {
      width: 1920,
      height: 1080,
      fps_num: 30,
      fps_den: 1,
      duration_pinned: false,
    },
    track_count: 1,
    layer_count: layers.length,
    duration_us: 20_000_000,
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [],
    tracks: [track],
    markers: [],
    groups: [],
    audio_roles: [],
  };
}

describe("preview decode priority plan", () => {
  it("protects every active clip and only the nearest upcoming boundary, including swap keys", () => {
    const active = video("active", 4_000_000, 8_000_000);
    const retained = video("retained", 0, 4_000_000);
    const upcomingA = video("upcoming-a", 5_500_000, 9_000_000);
    const upcomingB = video("upcoming-b", 5_500_000, 9_000_000);
    const later = video("later", 5_800_000, 9_000_000);
    const disabled = video("disabled", 5_500_000, 9_000_000, false);

    const plan = planPreviewDecodePriority(
      summary([active, retained, upcomingA, upcomingB, later, disabled]),
      5_000_000,
      1_000_000,
    );

    expect(plan.nextStartUs).toBe(5_500_000);
    expect(plan.upcomingLayers.map((layer) => layer.id)).toEqual([
      "upcoming-a",
      "upcoming-b",
    ]);
    expect(plan.poolKeys).toEqual([
      "active",
      "active#swap",
      "upcoming-a",
      "upcoming-a#swap",
      "upcoming-b",
      "upcoming-b#swap",
    ]);
  });
});
