import { Container, type Application } from "pixi.js";
import { describe, expect, it, vi } from "vitest";

import type { LayerSummary, ProjectSummary, TrackSummary } from "../ipc";
import { Compositor } from "./Compositor";
import type {
  DecodeSession,
  DecoderPool,
  FrameSelection,
  FrameStore,
  SourceHandleInit,
} from "./decoder/session";

function video(id: string, startUs: number, endUs: number): LayerSummary {
  return {
    id,
    label: id,
    t_start_us: startUs,
    t_end_us: endUs,
    kind: "VideoClip",
    color_hint: "#000000",
    enabled: true,
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
      scale_linked: true,
      rotation_deg: { mode: "Static", value: 0 },
      anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
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
    name: "Priority wiring",
    composition: {
      width: 1920,
      height: 1080,
      fps_num: 30,
      fps_den: 1,
      duration_pinned: false,
      fps_locked: false,
    },
    track_count: 1,
    layer_count: layers.length,
    duration_us: 10_000_000,
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [],
    tracks: [track],
    markers: [],
    groups: [],
    audio_roles: [],
  };
}

function emptyRing(): FrameStore {
  return {
    selectFrame: (): FrameSelection | null => null,
    frameAt: () => null,
    containsPts: () => false,
    firstPtsUs: () => null,
    lastPtsUs: () => null,
    size: () => 0,
  };
}

describe("Compositor preview decode priority wiring", () => {
  it("publishes active/upcoming keys before active acquire and boundary prewarm acquire", () => {
    const events: Array<{ kind: "priority" | "acquire"; value: string[] | string }> = [];
    const sessions = new Map<string, DecodeSession>();
    const pool: DecoderPool = {
      setPriorityKeys(keys) {
        events.push({ kind: "priority", value: [...keys] });
        return false;
      },
      acquire(init: SourceHandleInit) {
        events.push({ kind: "acquire", value: init.layerId });
        const session: DecodeSession = {
          mediaId: init.mediaId,
          ring: emptyRing(),
          disposed: false,
          ensureReady: async () => {},
          dispose: vi.fn(),
          requestFrameAt: async () => {},
          onFirstFrame: vi.fn(),
        };
        sessions.set(init.layerId, session);
        return session;
      },
      release: vi.fn(),
      dispose: vi.fn(),
    };
    const compositor = new Compositor({
      app: { stage: new Container() } as unknown as Application,
      width: 1920,
      height: 1080,
      mode: "preview",
      resolveSource: (mediaId) => ({
        engine: "ffmpeg",
        source: "original",
        status: "ok",
        target: `C:/${mediaId}.mp4`,
        key: `ffmpeg:original:${mediaId}`,
      }),
      originalAssetUrl: () => null,
      sourceColor: () => undefined,
      mediaById: () => undefined,
      pool,
    });
    compositor.setProject(summary([
      video("active", 4_000_000, 8_000_000),
      video("upcoming", 5_500_000, 9_000_000),
    ]));

    compositor.compositeFrame(5_000_000);
    expect(events[0]).toEqual({
      kind: "priority",
      value: ["active", "active#swap", "upcoming", "upcoming#swap"],
    });
    expect(events[1]).toEqual({ kind: "acquire", value: "active" });

    compositor.setAnchorTime(5_000_000);
    const upcomingAcquire = events.findIndex(
      (event) => event.kind === "acquire" && event.value === "upcoming",
    );
    const priorityEvents = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.kind === "priority");
    expect(priorityEvents).toHaveLength(1);
    expect(upcomingAcquire).toBeGreaterThan(priorityEvents[0]!.index);
    compositor.dispose();
  });
});
