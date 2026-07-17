import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../settings/appSettingsStore", () => ({
  setMediaPoolDrawerOpen: vi.fn(() => Promise.resolve()),
}));

import {
  clampSeekUs,
  jumpToLayer,
  registerRevealMedia,
  registerRevealTrack,
  registerScrollToTime,
  revealInMediaPool,
  selectLayer,
  selectLayers,
  seekToClamped,
} from "./navigation";
import { setMediaPoolDrawerOpen } from "../settings/appSettingsStore";
import { registerTransport } from "./playbackStore";
import { playheadTimeUs, setPlayheadTimeUs } from "./playheadStore";
import { useProjectStore } from "./projectStore";
import {
  selectedLayerId,
  selectedLayerIds,
  setLayerSelection,
  setSelectedLayerId,
} from "./selectionStore";
import type { ProjectSummary } from "../ipc";

/// 10 s 30 fps summary with one video track (one clip at 2 s) and one
/// media item. Only the fields navigation touches need to be realistic.
function fixtureSummary(): ProjectSummary {
  return {
    project_id: "p1",
    name: "fixture",
    composition: { width: 1920, height: 1080, fps_num: 30, fps_den: 1, duration_pinned: false },
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
  setSelectedLayerId(null);
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

describe("jumpToLayer", () => {
  it("selects, seeks to t_start, scrolls, and reveals the owner track", () => {
    const reveal = vi.fn();
    const scroll = vi.fn();
    const unReveal = registerRevealTrack(reveal);
    const unScroll = registerScrollToTime(scroll);
    expect(jumpToLayer("l1")).toBe(true);
    expect(reveal).toHaveBeenCalledWith("t1", "l1");
    expect(selectedLayerId()).toBe("l1");
    expect(Array.from(selectedLayerIds())).toEqual(["l1"]);
    expect(playheadTimeUs()).toBe(2_000_000);
    expect(scroll).toHaveBeenCalledWith(2_000_000);
    unReveal();
    unScroll();
  });

  it("falls back to plain selection when no reveal handle is registered", () => {
    expect(jumpToLayer("l1")).toBe(true);
    expect(selectedLayerId()).toBe("l1");
  });

  it("returns false for a stale layer id and changes nothing", () => {
    expect(jumpToLayer("ghost")).toBe(false);
    expect(selectedLayerId()).toBeNull();
    expect(playheadTimeUs()).toBe(0);
  });
});

describe("selectLayer / selectLayers", () => {
  it("selects one Layer or an exact complete set", () => {
    expect(selectLayer("l1")).toBe(true);
    expect(selectedLayerId()).toBe("l1");
    expect(Array.from(selectedLayerIds())).toEqual(["l1"]);

    expect(selectLayers(["l1", "l2"], "l2")).toBe(true);
    expect(selectedLayerId()).toBe("l2");
    expect(Array.from(selectedLayerIds())).toEqual(["l1", "l2"]);
  });

  it("rejects a stale Layer or invalid primary without a partial update", () => {
    setLayerSelection("l1", ["l1", "l2"]);

    expect(selectLayers(["l2", "ghost"], "l2")).toBe(false);
    expect(selectLayers(["l1"], "l2")).toBe(false);
    expect(selectedLayerId()).toBe("l1");
    expect(Array.from(selectedLayerIds())).toEqual(["l1", "l2"]);
  });

  it("clears the complete selection when the Project session resets", () => {
    setLayerSelection("l2", ["l1", "l2"]);
    useProjectStore.getState().apply(null);

    expect(selectedLayerId()).toBeNull();
    expect(selectedLayerIds().size).toBe(0);
  });
});

describe("revealInMediaPool", () => {
  it("opens the drawer and calls the registered handle", () => {
    const flash = vi.fn();
    const un = registerRevealMedia(flash);
    expect(revealInMediaPool("m1")).toBe(true);
    expect(setMediaPoolDrawerOpen).toHaveBeenCalledWith(true);
    expect(flash).toHaveBeenCalledWith("m1");
    un();
  });

  it("returns false for a stale media id", () => {
    expect(revealInMediaPool("ghost")).toBe(false);
  });
});
