import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clampSeekUs,
  jumpToLayer,
  registerOpenMediaPoolPanel,
  registerRevealMedia,
  registerRevealTrack,
  registerScrollToTime,
  revealInMediaPool,
  selectLayer,
  selectLayers,
  seekToClamped,
  seekToNextEdit,
  seekToPrevEdit,
} from "./navigation";
import { registerTransport } from "./playbackStore";
import { playheadTimeUs, setPlayheadTimeUs } from "./playheadStore";
import { useProjectStore } from "./projectStore";
import {
  clearLayerSelection,
  setLayerSelection,
  useSelectionStore,
} from "./selectionStore";
import type { ProjectSummary } from "../ipc";

/// 10 s 30 fps summary with one video track (one clip at 2 s) and one
/// media item. Only the fields navigation touches need to be realistic.
function fixtureSummary(): ProjectSummary {
  return {
    project_id: "p1",
    name: "fixture",
    composition: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, duration_pinned: false, fps_locked: false },
    track_count: 1,
    layer_count: 2,
    duration_us: 10_000_000,
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [
      {
        id: "m1", label: "beach.mp4", path: "C:/x/beach.mp4", kind: "Video",
        duration_us: 5_000_000, width: 1920, height: 1080, size_bytes: 1,
        available: true, decode_route: { kind: "Original" } as never,
        codec: "h264", pix_fmt: "yuv420p",
      },
    ],
    tracks: [
      {
        id: "t1", kind: "Video", label: "A-Roll", enabled: true, locked: false,
        muted: false, solo: false, role: "a-roll", transient: false,
        layers: [
          {
            id: "l1", label: null, t_start_us: 2_000_000, t_end_us: 4_000_000,
            kind: "VideoClip", color_hint: "", enabled: true, locked: false,
            effects: [],
            params: {
              kind: "VideoClip", media_id: "m1", media_label: "beach.mp4",
              src_in_us: 0, src_out_us: 2_000_000,
              x: { mode: "Static", value: 0 }, y: { mode: "Static", value: 0 },
              scale_x: { mode: "Static", value: 1 }, scale_y: { mode: "Static", value: 1 },
              rotation_deg: { mode: "Static", value: 0 },
              opacity: { mode: "Static", value: 1 },
              speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0,
            },
          },
          {
            id: "l2", label: "Second", t_start_us: 5_000_000, t_end_us: 6_000_000,
            kind: "Color", color_hint: "", enabled: true, locked: false,
            effects: [],
            params: {
              kind: "Color",
              color: { mode: "Static", value: { r: 0, g: 0, b: 0, a: 1 } },
              width: 1920,
              height: 1080,
            },
          },
        ],
      },
    ],
    markers: [],
    groups: [],
    audio_roles: [],
  };
}

beforeEach(() => {
  useProjectStore.getState().apply(fixtureSummary());
  clearLayerSelection();
  setPlayheadTimeUs(0);
  vi.clearAllMocks();
});

describe("clampSeekUs / seekToClamped", () => {
  it("clamps to [0, lastFrameAnchorUs]", () => {
    expect(clampSeekUs(-5)).toBe(0);
    // 10 s @ 30 fps → last frame anchor 9_966_667
    expect(clampSeekUs(99_000_000)).toBe(9_966_667);
    expect(clampSeekUs(2_000_000)).toBe(2_000_000);
  });

  it("writes playheadStore optimistically and seeks the transport", () => {
    const seek = vi.fn();
    registerTransport({ play() {}, pause() {}, seek, isPlaying: () => false });
    seekToClamped(2_000_000);
    expect(playheadTimeUs()).toBe(2_000_000);
    expect(seek).toHaveBeenCalledWith(2_000_000);
  });
});

describe("seekToPrevEdit / seekToNextEdit", () => {
  // Fixture edit points: 0, 2s, 4s (l1 boundaries), 5s, 6s (l2 boundaries).

  it("walks forward across every layer boundary", () => {
    setPlayheadTimeUs(0);
    seekToNextEdit();
    expect(playheadTimeUs()).toBe(2_000_000);
    seekToNextEdit();
    expect(playheadTimeUs()).toBe(4_000_000);
    seekToNextEdit();
    expect(playheadTimeUs()).toBe(5_000_000);
    seekToNextEdit();
    expect(playheadTimeUs()).toBe(6_000_000);
  });

  it("walks backward and reaches 0", () => {
    setPlayheadTimeUs(6_000_000);
    seekToPrevEdit();
    expect(playheadTimeUs()).toBe(5_000_000);
    seekToPrevEdit();
    expect(playheadTimeUs()).toBe(4_000_000);
    seekToPrevEdit();
    expect(playheadTimeUs()).toBe(2_000_000);
    seekToPrevEdit();
    expect(playheadTimeUs()).toBe(0);
    // Already at the first point — stays put.
    seekToPrevEdit();
    expect(playheadTimeUs()).toBe(0);
  });

  it("navigates from a position between edit points", () => {
    setPlayheadTimeUs(4_500_000);
    seekToPrevEdit();
    expect(playheadTimeUs()).toBe(4_000_000);
    setPlayheadTimeUs(4_500_000);
    seekToNextEdit();
    expect(playheadTimeUs()).toBe(5_000_000);
  });

  it("is a no-op past the last edit point", () => {
    setPlayheadTimeUs(7_000_000);
    seekToNextEdit();
    expect(playheadTimeUs()).toBe(7_000_000);
  });

  it("clamps a boundary at the exclusive composition end to the last frame anchor", () => {
    // Stretch l2 to the composition end: its t_end (10s) is exclusive, so
    // "next edit" from 6s parks on the last frame's start, not on 10s.
    const summary = fixtureSummary();
    summary.tracks[0]!.layers[1]!.t_end_us = 10_000_000;
    useProjectStore.getState().apply(summary);
    setPlayheadTimeUs(6_000_000);
    seekToNextEdit();
    expect(playheadTimeUs()).toBe(9_966_667);
  });
});

describe("jumpToLayer", () => {
  it("selects, seeks to t_start, scrolls, and reveals the owner track", () => {
    const reveal = vi.fn();
    const scroll = vi.fn();
    const unReveal = registerRevealTrack(reveal);
    const unScroll = registerScrollToTime(scroll);
    expect(jumpToLayer("l1")).toBe(true);
    expect(reveal).toHaveBeenCalledWith("t1", "l1");
    expect(useSelectionStore.getState().primaryLayerId).toBe("l1");
    expect(Array.from(useSelectionStore.getState().selectedLayerIds)).toEqual(["l1"]);
    expect(playheadTimeUs()).toBe(2_000_000);
    expect(scroll).toHaveBeenCalledWith(2_000_000);
    unReveal();
    unScroll();
  });

  it("falls back to plain selection when no reveal handle is registered", () => {
    expect(jumpToLayer("l1")).toBe(true);
    expect(useSelectionStore.getState().primaryLayerId).toBe("l1");
  });

  it("returns false for a stale layer id and changes nothing", () => {
    expect(jumpToLayer("ghost")).toBe(false);
    expect(useSelectionStore.getState().primaryLayerId).toBeNull();
    expect(playheadTimeUs()).toBe(0);
  });
});

describe("selectLayer / selectLayers", () => {
  it("selects one Layer or an exact complete set", () => {
    expect(selectLayer("l1")).toBe(true);
    expect(useSelectionStore.getState().primaryLayerId).toBe("l1");
    expect(Array.from(useSelectionStore.getState().selectedLayerIds)).toEqual(["l1"]);

    expect(selectLayers(["l1", "l2"], "l2")).toBe(true);
    expect(useSelectionStore.getState().primaryLayerId).toBe("l2");
    expect(Array.from(useSelectionStore.getState().selectedLayerIds)).toEqual(["l1", "l2"]);
  });

  it("rejects a stale Layer or invalid primary without a partial update", () => {
    setLayerSelection("l1", ["l1", "l2"]);

    expect(selectLayers(["l2", "ghost"], "l2")).toBe(false);
    expect(selectLayers(["l1"], "l2")).toBe(false);
    expect(useSelectionStore.getState().primaryLayerId).toBe("l1");
    expect(Array.from(useSelectionStore.getState().selectedLayerIds)).toEqual(["l1", "l2"]);
  });

  it("clears the complete selection when the Project session resets", () => {
    setLayerSelection("l2", ["l1", "l2"]);
    useProjectStore.getState().apply(null);

    expect(useSelectionStore.getState().primaryLayerId).toBeNull();
    expect(useSelectionStore.getState().selectedLayerIds.size).toBe(0);
  });
});

describe("revealInMediaPool", () => {
  it("focuses the Media Pool Panel and calls the mounted reveal handle", () => {
    const openPanel = vi.fn();
    const flash = vi.fn();
    const unOpen = registerOpenMediaPoolPanel(openPanel);
    const unReveal = registerRevealMedia(flash);
    expect(revealInMediaPool("m1")).toBe(true);
    expect(openPanel).toHaveBeenCalledOnce();
    expect(flash).toHaveBeenCalledWith("m1");
    unReveal();
    unOpen();
  });

  it("delivers a pending reveal after a closed Panel is recreated", () => {
    const openPanel = vi.fn();
    const unOpen = registerOpenMediaPoolPanel(openPanel);

    expect(revealInMediaPool("m1")).toBe(true);
    expect(openPanel).toHaveBeenCalledOnce();

    const flash = vi.fn();
    const unReveal = registerRevealMedia(flash);
    expect(flash).toHaveBeenCalledWith("m1");
    unReveal();
    unOpen();
  });

  it("returns false for a stale media id", () => {
    expect(revealInMediaPool("ghost")).toBe(false);
  });
});
