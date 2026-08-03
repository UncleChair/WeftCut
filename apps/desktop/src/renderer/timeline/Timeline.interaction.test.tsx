// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import "../i18n"; // initialize i18next so t(key) resolves in chrome
import type {
  GroupSummary,
  LayerSummary,
  MediaSummary,
  TrackSummary,
} from "../ipc";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { Timeline } from "./Timeline";
import {
  MEDIA_DRAG_CURSOR_OFFSET_PX,
  MEDIA_DRAG_TYPE,
  mediaDragPayload,
  useMediaDragStore,
} from "./mediaDrag";
import {
  clearLayerSelection,
  setLayerSelection,
  useSelectionStore,
} from "../state/selectionStore";
import { playheadTimeUs, setPlayheadTimeUs } from "../state/playheadStore";
import { registerTransport, releaseTransport } from "../state/playbackStore";

const ipcMocks = vi.hoisted(() => ({
  addMediaLayer: vi.fn().mockResolvedValue(undefined),
  moveLayer: vi.fn().mockResolvedValue(undefined),
  pasteLayer: vi.fn().mockResolvedValue("duplicated-layer"),
  trimLayer: vi.fn().mockResolvedValue(undefined),
  getWaveformPeaks: vi.fn().mockRejectedValue("not_ready"),
  groupsCreate: vi.fn().mockResolvedValue("group-created"),
  logEmit: vi.fn().mockResolvedValue(undefined),
  viewStateGet: vi
    .fn()
    .mockResolvedValue({ timeline_px_per_sec: 80, track_heights: {}, expanded_tracks: [] }),
  viewStateSet: vi.fn().mockResolvedValue(undefined),
}));

// jsdom 25 does not implement PointerEvent; alias it to MouseEvent so
// fireEvent.pointerDown carries a usable .button / .clientX (same shim the
// KeyframeCurveGraph test uses).
if (typeof window !== "undefined" && !window.PointerEvent) {
  (window as unknown as Record<string, unknown>).PointerEvent = window.MouseEvent;
}

// useTimelineView loads/saves view.json over the backend IPC on mount. There is no
// backend runtime under jsdom, so stub just those two calls; keep every other
// ipc export real (types, helpers).
vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return {
    ...actual,
    addMediaLayer: ipcMocks.addMediaLayer,
    moveLayer: ipcMocks.moveLayer,
    pasteLayer: ipcMocks.pasteLayer,
    trimLayer: ipcMocks.trimLayer,
    getWaveformPeaks: ipcMocks.getWaveformPeaks,
    groupsCreate: ipcMocks.groupsCreate,
    logEmit: ipcMocks.logEmit,
    viewStateGet: ipcMocks.viewStateGet,
    viewStateSet: ipcMocks.viewStateSet,
  };
});

const staticNum = (value: number) => ({ mode: "Static" as const, value });

const layer: LayerSummary = {
  id: "layer-1",
  label: "Clip A",
  t_start_us: 0,
  t_end_us: 2_000_000,
  kind: "Color",
  color_hint: "#4488cc",
  enabled: true,
  locked: false,
  params: { kind: "Color", color: { mode: "Static", value: { r: 0, g: 0, b: 0, a: 1 } }, width: 1920, height: 1080 },
  effects: [],
};

const track: TrackSummary = {
  id: "track-1",
  kind: "Video",
  label: "S1",
  enabled: true,
  locked: false,
  muted: false,
  solo: false,
  role: "a-roll",
  transient: false,
  layers: [layer],
};

const tinyVideoLayer: LayerSummary = {
  id: "video-1",
  label: "Tiny Video",
  t_start_us: 0,
  t_end_us: 100_000,
  kind: "VideoClip",
  color_hint: "#5588aa",
  enabled: true,
  locked: false,
  params: {
    kind: "VideoClip",
    media_id: "media-1",
    media_label: "media.mov",
    src_in_us: 0,
    src_out_us: 100_000,
    x: staticNum(0),
    y: staticNum(0),
    scale_x: staticNum(1),
    scale_y: staticNum(1),
    scale_linked: true,
    rotation_deg: staticNum(0),
    opacity: staticNum(1),
    speed: 1,
    flip_h: false,
    flip_v: false,
    fade_in_us: 0,
    fade_out_us: 0,
  },
  effects: [],
};

const tinyVideoTrack: TrackSummary = {
  ...track,
  layers: [tinyVideoLayer],
};

const groupedLayer: LayerSummary = {
  ...layer,
  id: "layer-2",
  label: "Clip B",
  t_start_us: 2_000_000,
  t_end_us: 4_000_000,
  color_hint: "#cc8844",
};

const groupedTrack: TrackSummary = {
  ...track,
  layers: [layer, groupedLayer],
};

const group: GroupSummary = {
  id: "group-1",
  label: null,
  layer_ids: [layer.id, groupedLayer.id],
};

const sourceMedia: MediaSummary = {
  id: "media-source",
  label: "Source clip",
  path: "C:/media/source.mp4",
  kind: "Video",
  duration_us: 3_000_000,
  width: 1920,
  height: 1080,
  size_bytes: 1024,
  available: true,
  decode_route: { route: "bypass" },
  codec: "h264",
  pix_fmt: "yuv420p",
};

function renderTimeline(overrides: {
  selectedLayerId?: string | null;
  onSeek?: () => void;
  bladeMode?: boolean;
  tracks?: TrackSummary[];
  groups?: GroupSummary[];
  media?: MediaSummary[];
  onMutated?: () => Promise<void>;
  fpsNum?: number;
  fpsDen?: number;
}) {
  const onSeek = overrides.onSeek ?? vi.fn();
  const selectedLayerId = overrides.selectedLayerId ?? null;
  setLayerSelection(selectedLayerId, selectedLayerId ? [selectedLayerId] : []);
  return render(
    <Timeline
      tracks={overrides.tracks ?? [track]}
      groups={overrides.groups ?? []}
      durationUs={5_000_000}
      keybindings={{}}
      fpsNum={overrides.fpsNum ?? 30}
      fpsDen={overrides.fpsDen ?? 1}
      bladeMode={overrides.bladeMode ?? false}
      media={overrides.media ?? []}
      importing={new Set()}
      proxyState={new Map()}
      previewDecodable={new Set()}
      onExitBlade={vi.fn()}
      onSeek={onSeek}
      onMutated={overrides.onMutated ?? vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

describe("Timeline seek/selection coupling", () => {
  beforeEach(() => {
    clearLayerSelection();
    setPlayheadTimeUs(0);
    ipcMocks.addMediaLayer.mockClear();
    ipcMocks.moveLayer.mockClear();
    ipcMocks.pasteLayer.mockClear();
    ipcMocks.trimLayer.mockClear();
    ipcMocks.getWaveformPeaks.mockClear();
    ipcMocks.groupsCreate.mockClear();
    ipcMocks.logEmit.mockClear();
    // Show-All so the role-stamped track always renders regardless of the
    // default AB-roll filter.
    useAppSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        display_mode: "ShowAll",
        tail_snap_enabled: true,
        tail_snap_strength_px: 12,
      },
    }));
  });
  afterEach(() => {
    useMediaDragStore.getState().end();
    cleanup();
    vi.useRealTimers();
  });

  it("clicking the ruler seeks AND keeps the selected clip selected", () => {
    const onSeek = vi.fn();
    const { container } = renderTimeline({ selectedLayerId: layer.id, onSeek });
    const ruler = container.querySelector('[data-testid="timeline-ruler"]')!;
    fireEvent.pointerDown(ruler, { button: 0, clientX: 200 });
    fireEvent.pointerUp(window, { clientX: 200 });
    fireEvent.click(ruler);
    expect(onSeek).toHaveBeenCalled();
    expect(useSelectionStore.getState().primaryLayerId).toBe(layer.id);
    expect(Array.from(useSelectionStore.getState().selectedLayerIds)).toEqual([layer.id]);
  });

  it("clicking empty lane background deselects and does NOT seek", () => {
    const onSeek = vi.fn();
    const { container } = renderTimeline({ selectedLayerId: layer.id, onSeek });
    const lane = container.querySelector('[data-testid="track-lane"]')!;
    fireEvent.pointerDown(lane, { button: 0, clientX: 200 });
    fireEvent.pointerUp(window, { clientX: 200 });
    fireEvent.click(lane);
    expect(onSeek).not.toHaveBeenCalled();
    expect(useSelectionStore.getState().primaryLayerId).toBeNull();
    expect(useSelectionStore.getState().selectedLayerIds.size).toBe(0);
  });

  it("clicking a clip selects it without seeking", () => {
    const onSeek = vi.fn();
    const { container } = renderTimeline({ selectedLayerId: null, onSeek });
    const block = container.querySelector(".timeline-layer")!;
    fireEvent.pointerDown(block, { button: 0, clientX: 50 });
    fireEvent.pointerUp(window, { clientX: 50 });
    fireEvent.click(block);
    expect(useSelectionStore.getState().primaryLayerId).toBe(layer.id);
    expect(Array.from(useSelectionStore.getState().selectedLayerIds)).toEqual([layer.id]);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("does not let snapping move a selected clip during a stationary click", () => {
    setPlayheadTimeUs(100_000);
    const { getByText } = renderTimeline({ selectedLayerId: layer.id });
    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(block, {
      button: 0,
      clientX: 80,
      clientY: 30,
    });
    fireEvent.pointerUp(window, { clientX: 80, clientY: 30 });

    expect(ipcMocks.moveLayer).not.toHaveBeenCalled();
    expect(ipcMocks.trimLayer).not.toHaveBeenCalled();
  });

  it("keeps a short drag on an unselected clip as selection only", () => {
    vi.useFakeTimers();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, tail_snap_enabled: false },
    }));
    const { getByText } = renderTimeline({ selectedLayerId: null });
    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(block, {
      button: 0,
      clientX: 80,
      clientY: 30,
    });
    fireEvent.pointerMove(window, { clientX: 83, clientY: 30 });

    expect(block.style.left).toBe("0px");

    fireEvent.pointerUp(window, { clientX: 83, clientY: 30 });
    expect(useSelectionStore.getState().primaryLayerId).toBe(layer.id);
    expect(ipcMocks.moveLayer).not.toHaveBeenCalled();
  });

  it("arms an unselected clip drag after a short delay without losing its small delta", () => {
    vi.useFakeTimers();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, tail_snap_enabled: false },
    }));
    const { getByText } = renderTimeline({ selectedLayerId: null });
    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(block, {
      button: 0,
      clientX: 80,
      clientY: 30,
    });
    fireEvent.pointerMove(window, { clientX: 83, clientY: 30 });
    expect(block.style.left).toBe("0px");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(block.style.left).toBe(`${(33_333 / 1_000_000) * 80}px`);

    fireEvent.pointerUp(window, { clientX: 83, clientY: 30 });
    expect(ipcMocks.moveLayer).toHaveBeenCalledWith(
      layer.id,
      track.id,
      33_333,
      false,
    );
  });

  it("starts a selected clip drag without the temporal delay", () => {
    vi.useFakeTimers();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, tail_snap_enabled: false },
    }));
    const { getByText } = renderTimeline({ selectedLayerId: layer.id });
    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(block, {
      button: 0,
      clientX: 80,
      clientY: 30,
    });
    fireEvent.pointerMove(window, { clientX: 83, clientY: 30 });

    expect(block.style.left).toBe(`${(33_333 / 1_000_000) * 80}px`);

    fireEvent.pointerUp(window, { clientX: 83, clientY: 30 });
    expect(ipcMocks.moveLayer).toHaveBeenCalledWith(
      layer.id,
      track.id,
      33_333,
      false,
    );
  });

  // -------- Cross-track hit-testing --------
  //
  // Visual order is the reverse of the data array, so [bottom, mid, top]
  // renders top → bottom as rowTop, rowMid, rowBottom.

  const rowTop: TrackSummary = { ...track, id: "row-top", label: "Top", layers: [] };
  const rowMid: TrackSummary = { ...track, id: "row-mid", label: "Mid", layers: [] };
  const draggedLayer: LayerSummary = { ...layer, id: "dragged", label: "Dragged" };
  const rowBottom: TrackSummary = {
    ...track,
    id: "row-bottom",
    label: "Bottom",
    layers: [draggedLayer],
  };
  const threeRows = [rowBottom, rowMid, rowTop];

  // Give the lanes a vertical layout jsdom cannot produce on its own. The gap
  // between rowMid and rowBottom is what an expanded track's keyframe
  // sub-lanes occupy — the geometry an arithmetic row-offset table cannot see.
  function stubLaneLayout(container: HTMLElement) {
    const bands: [number, number][] = [
      [0, 56], // rowTop
      [56, 112], // rowMid — its sub-lanes then fill 112 → 184
      [184, 240], // rowBottom
    ];
    container
      .querySelectorAll('[data-testid="track-lane"]')
      .forEach((el, i) => {
        const band = bands[i];
        if (!band) return;
        const [top, bottom] = band;
        vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
          top,
          bottom,
          height: bottom - top,
          y: top,
          left: 0,
          right: 0,
          width: 0,
          x: 0,
          toJSON: () => ({}),
        } as DOMRect);
      });
  }

  it("keeps a drag on the lane the DOM reports it is over", () => {
    vi.useFakeTimers();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, tail_snap_enabled: false },
    }));
    const { container, getByText } = renderTimeline({
      tracks: threeRows,
      selectedLayerId: draggedLayer.id,
    });
    stubLaneLayout(container);
    const block = getByText("Dragged").closest(".timeline-layer") as HTMLElement;

    // Both ends stay inside rowBottom's measured band [184, 240).
    fireEvent.pointerDown(block, { button: 0, clientX: 80, clientY: 212 });
    fireEvent.pointerMove(window, { clientX: 83, clientY: 214 });
    fireEvent.pointerUp(window, { clientX: 83, clientY: 214 });

    expect(ipcMocks.moveLayer).toHaveBeenCalledWith(
      draggedLayer.id,
      rowBottom.id,
      33_333,
      false,
    );
  });

  it("lands a cross-track drag on the measured destination lane", () => {
    vi.useFakeTimers();
    const { container, getByText } = renderTimeline({
      tracks: threeRows,
      selectedLayerId: draggedLayer.id,
    });
    stubLaneLayout(container);
    const block = getByText("Dragged").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(block, { button: 0, clientX: 80, clientY: 212 });
    // 80 is inside rowMid's own lane [56, 112).
    fireEvent.pointerMove(window, { clientX: 80, clientY: 80 });
    fireEvent.pointerUp(window, { clientX: 80, clientY: 80 });

    expect(ipcMocks.moveLayer).toHaveBeenCalledWith(
      draggedLayer.id,
      rowMid.id,
      0,
      false,
    );
  });

  it("hands an expanded track's sub-lane band to the track that owns it", () => {
    vi.useFakeTimers();
    const { container, getByText } = renderTimeline({
      tracks: threeRows,
      selectedLayerId: draggedLayer.id,
    });
    stubLaneLayout(container);
    const block = getByText("Dragged").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(block, { button: 0, clientX: 80, clientY: 212 });
    // 150 is in the 112 → 184 sub-lane strip, which belongs to rowMid.
    fireEvent.pointerMove(window, { clientX: 80, clientY: 150 });
    fireEvent.pointerUp(window, { clientX: 80, clientY: 150 });

    expect(ipcMocks.moveLayer).toHaveBeenCalledWith(
      draggedLayer.id,
      rowMid.id,
      0,
      false,
    );
  });

  it("never changes track without vertical travel, even if the measurement disagrees", () => {
    vi.useFakeTimers();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, tail_snap_enabled: false },
    }));
    const { container, getByText } = renderTimeline({
      tracks: threeRows,
      selectedLayerId: draggedLayer.id,
    });
    stubLaneLayout(container);
    const block = getByText("Dragged").closest(".timeline-layer") as HTMLElement;

    // y=30 measures as rowTop while the clip lives on rowBottom. A horizontal
    // drag must still be a pure time move on its own track.
    fireEvent.pointerDown(block, { button: 0, clientX: 80, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 83, clientY: 30 });
    fireEvent.pointerUp(window, { clientX: 83, clientY: 30 });

    expect(ipcMocks.moveLayer).toHaveBeenCalledWith(
      draggedLayer.id,
      rowBottom.id,
      33_333,
      false,
    );
  });

  it("keeps a motionless click on a clip a selection, never a track change", () => {
    vi.useFakeTimers();
    const { container, getByText } = renderTimeline({
      tracks: threeRows,
      selectedLayerId: draggedLayer.id,
    });
    stubLaneLayout(container);
    const block = getByText("Dragged").closest(".timeline-layer") as HTMLElement;

    // The reported symptom: a bare click used to commit a cross-track move
    // because a disagreeing hit-test alone counted as edit intent.
    fireEvent.pointerDown(block, { button: 0, clientX: 80, clientY: 30 });
    fireEvent.pointerUp(window, { clientX: 80, clientY: 30 });

    expect(ipcMocks.moveLayer).not.toHaveBeenCalled();
  });

  it("starts an explicit trim handle drag without the temporal delay", () => {
    vi.useFakeTimers();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, tail_snap_enabled: false },
    }));
    const { getByText } = renderTimeline({ selectedLayerId: null });
    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
    vi.spyOn(block, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 160,
      top: 0,
      bottom: 48,
      width: 160,
      height: 48,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(block, {
      button: 0,
      clientX: 160,
      clientY: 30,
    });
    fireEvent.pointerMove(window, { clientX: 163, clientY: 30 });

    expect(block.title).toContain("00:00:02:01");

    fireEvent.pointerUp(window, { clientX: 163, clientY: 30 });
    expect(ipcMocks.trimLayer).toHaveBeenCalledWith(
      layer.id,
      "out",
      2_033_333,
      false,
    );
  });

  it("drives the monitor to the LAST KEPT frame during a tail trim and restores on release", () => {
    vi.useFakeTimers();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, tail_snap_enabled: false },
    }));
    const seek = vi.fn();
    const pause = vi.fn();
    const transport = { play() {}, pause, seek, isPlaying: () => false };
    registerTransport(transport);
    setPlayheadTimeUs(500_000);
    const { getByText } = renderTimeline({ selectedLayerId: null });
    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
    vi.spyOn(block, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 160,
      top: 0,
      bottom: 48,
      width: 160,
      height: 48,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(block, { button: 0, clientX: 160, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 163, clientY: 30 });

    // New end 2_033_333 (exclusive) → the monitor shows the last kept
    // frame's start, 2_000_000 (frame 60 @ 30fps) — not the boundary frame.
    expect(pause).toHaveBeenCalled();
    expect(seek).toHaveBeenCalledWith(2_000_000);

    fireEvent.pointerMove(window, { clientX: 168, clientY: 30 });
    // New end 2_100_000 → last kept frame 62 starts at 2_066_667.
    expect(seek).toHaveBeenCalledWith(2_066_667);

    fireEvent.pointerUp(window, { clientX: 168, clientY: 30 });
    // Gesture over: the playhead line and the monitor return to the
    // pre-trim park position.
    expect(playheadTimeUs()).toBe(500_000);
    expect(seek).toHaveBeenLastCalledWith(500_000);
    releaseTransport(transport);
  });

  it("drives the monitor to the FIRST KEPT frame during a head trim", () => {
    vi.useFakeTimers();
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, tail_snap_enabled: false },
    }));
    const seek = vi.fn();
    const transport = { play() {}, pause() {}, seek, isPlaying: () => false };
    registerTransport(transport);
    setPlayheadTimeUs(500_000);
    const { getByText } = renderTimeline({ selectedLayerId: null });
    const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
    vi.spyOn(block, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 160,
      top: 0,
      bottom: 48,
      width: 160,
      height: 48,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(block, { button: 0, clientX: 0, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 3, clientY: 30 });

    // New start 33_333: the in side shows the boundary frame itself.
    expect(seek).toHaveBeenCalledWith(33_333);

    fireEvent.pointerUp(window, { clientX: 3, clientY: 30 });
    expect(playheadTimeUs()).toBe(500_000);
    releaseTransport(transport);
  });

  it("clicking the content preview overlay still selects without seeking", () => {
    const onSeek = vi.fn();
    const { container } = renderTimeline({ selectedLayerId: null, onSeek });
    const preview = container.querySelector('[data-testid="timeline-visual-preview"]')!;
    fireEvent.pointerDown(preview, { button: 0, clientX: 50 });
    fireEvent.pointerUp(window, { clientX: 50 });
    fireEvent.click(preview);
    expect(useSelectionStore.getState().primaryLayerId).toBe(layer.id);
    expect(Array.from(useSelectionStore.getState().selectedLayerIds)).toEqual([layer.id]);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("writes plain, Alt escape, and Shift additive group selection globally", () => {
    const { getByText } = renderTimeline({
      tracks: [groupedTrack],
      groups: [group],
    });
    const first = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
    const second = getByText("Clip B").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(first, { button: 0, clientX: 40 });
    fireEvent.pointerUp(window, { clientX: 40 });
    expect(useSelectionStore.getState().primaryLayerId).toBe(layer.id);
    expect(Array.from(useSelectionStore.getState().selectedLayerIds)).toEqual([layer.id, groupedLayer.id]);

    fireEvent.pointerDown(second, { button: 0, clientX: 200, altKey: true });
    fireEvent.pointerUp(window, { clientX: 200, altKey: true });
    expect(useSelectionStore.getState().primaryLayerId).toBe(groupedLayer.id);
    expect(Array.from(useSelectionStore.getState().selectedLayerIds)).toEqual([groupedLayer.id]);

    fireEvent.pointerDown(first, { button: 0, clientX: 40, shiftKey: true });
    fireEvent.pointerUp(window, { clientX: 40, shiftKey: true });
    expect(useSelectionStore.getState().primaryLayerId).toBe(layer.id);
    expect(new Set(useSelectionStore.getState().selectedLayerIds)).toEqual(
      new Set([layer.id, groupedLayer.id]),
    );
  });

  it("groups the complete global selection through the existing shortcut", async () => {
    const { getByText } = renderTimeline({
      tracks: [groupedTrack],
      groups: [],
    });
    const first = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
    const second = getByText("Clip B").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(first, { button: 0, clientX: 40 });
    fireEvent.pointerUp(window, { clientX: 40 });
    fireEvent.pointerDown(second, { button: 0, clientX: 200, shiftKey: true });
    fireEvent.pointerUp(window, { clientX: 200, shiftKey: true });
    fireEvent.keyDown(window, { key: "g", code: "KeyG", ctrlKey: true });

    await waitFor(() => {
      expect(ipcMocks.groupsCreate).toHaveBeenCalledWith(
        [layer.id, groupedLayer.id],
        null,
        false,
      );
    });
  });

  it("keeps the layer root overflow visible while the visual preview clips its own content", () => {
    const { container } = renderTimeline({});
    const block = container.querySelector(".timeline-layer") as HTMLElement;
    const preview = container.querySelector(
      '[data-testid="timeline-visual-preview"]',
    ) as HTMLElement;

    expect(block.className).not.toContain("overflow-hidden");
    expect(preview.className).toContain("overflow-hidden");
  });

  it("hides labels and avoids preview requests for clips narrower than 16px", () => {
    const { container, queryByText } = renderTimeline({ tracks: [tinyVideoTrack] });
    expect(queryByText("Tiny Video")).toBeNull();
    expect(container.querySelector('[data-testid="timeline-visual-preview"]')).toBeNull();
  });

  it("shows a blade cut preview at the hovered cut point", () => {
    const { container } = renderTimeline({ bladeMode: true });
    const block = container.querySelector(".timeline-layer")!;
    fireEvent.pointerMove(block, { clientX: 80, buttons: 0 });

    const marker = container.querySelector(
      '[data-testid="timeline-blade-preview"]',
    ) as HTMLElement | null;
    expect(marker).not.toBeNull();
    expect(marker?.style.left).toBe("80px");

    fireEvent.pointerLeave(block);
    expect(container.querySelector('[data-testid="timeline-blade-preview"]')).toBeNull();
  });

  it("dragging on the ruler scrubs the playhead repeatedly", () => {
    const onSeek = vi.fn();
    const { container } = renderTimeline({ selectedLayerId: layer.id, onSeek });
    const ruler = container.querySelector('[data-testid="timeline-ruler"]')!;
    fireEvent.pointerDown(ruler, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 300 });
    fireEvent.pointerUp(window, { clientX: 300 });
    // pointerdown seeks once; the drag-scrub pointermove seeks again.
    expect(onSeek.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(useSelectionStore.getState().primaryLayerId).toBe(layer.id);
    expect(Array.from(useSelectionStore.getState().selectedLayerIds)).toEqual([layer.id]);
  });

  it("pins the ruler and playhead head during vertical timeline scrolling", () => {
    const { container } = renderTimeline({});
    const ruler = container.querySelector('[data-testid="timeline-ruler"]') as HTMLElement;
    const rulerCorner = container.querySelector(
      '[data-testid="timeline-ruler-corner"]',
    ) as HTMLElement;
    const playheadHead = container.querySelector(
      '[data-testid="timeline-playhead-head"]',
    ) as HTMLElement;
    const playheadHeadShape = container.querySelector(
      '[data-testid="timeline-playhead-head-shape"]',
    ) as HTMLElement;

    expect(ruler.className).toContain("sticky");
    expect(ruler.className).toContain("top-0");
    expect(rulerCorner.className).toContain("sticky");
    expect(rulerCorner.className).toContain("top-0");
    expect(playheadHead.className).toContain("sticky");
    expect(playheadHead.classList.contains("top-0")).toBe(true);
    expect(playheadHeadShape.classList.contains("top-0.5")).toBe(true);
  });

  it("masks the playhead line above the sticky head", () => {
    const { container } = renderTimeline({});
    const playhead = container.querySelector(
      '[data-testid="timeline-playhead"]',
    ) as HTMLElement;
    const playheadHead = container.querySelector(
      '[data-testid="timeline-playhead-head"]',
    ) as HTMLElement;
    const lineCap = container.querySelector(
      '[data-testid="timeline-playhead-line-cap"]',
    ) as HTMLElement | null;
    const headShape = container.querySelector(
      '[data-testid="timeline-playhead-head-shape"]',
    ) as HTMLElement | null;

    expect(playhead.classList.contains("top-0")).toBe(true);
    expect(playheadHead.classList.contains("top-0")).toBe(true);
    expect(lineCap?.classList.contains("h-0.5")).toBe(true);
    expect(headShape?.classList.contains("top-0.5")).toBe(true);
  });

  it("starts with a longer ruler and matching trailing edit workspace", () => {
    const { container } = renderTimeline({});
    const ruler = container.querySelector(
      '[data-testid="timeline-ruler"]',
    ) as HTMLElement;
    const canvas = container.querySelector(
      '[data-testid="timeline-canvas"]',
    ) as HTMLElement;

    expect(ruler.style.width).toBe("1040px");
    expect(canvas.style.width).toBe(ruler.style.width);
  });

  it.each([
    {
      fpsNum: 30,
      fpsDen: 1,
      oneFrameUs: 33_333,
    },
    {
      fpsNum: 60,
      fpsDen: 1,
      oneFrameUs: 16_667,
    },
  ])(
    "trims a layer down to one frame by dragging its right edge at $fpsNum/$fpsDen fps",
    async ({ fpsNum, fpsDen, oneFrameUs }) => {
      const onMutated = vi.fn().mockResolvedValue(undefined);
      const { getByText } = renderTimeline({
        selectedLayerId: layer.id,
        onMutated,
        fpsNum,
        fpsDen,
      });
      const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
      vi.spyOn(block, "getBoundingClientRect").mockReturnValue({
        left: 0,
        right: 160,
        top: 0,
        bottom: 48,
        width: 160,
        height: 48,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const oneFrameEdgeX = (oneFrameUs / 1_000_000) * 80;
      fireEvent.pointerDown(block, { button: 0, clientX: 160, clientY: 24 });
      fireEvent.pointerMove(window, { clientX: oneFrameEdgeX, clientY: 24 });

      expect(block.title).toContain("00:00:00:00 → 00:00:00:01");

      fireEvent.pointerUp(window, { clientX: oneFrameEdgeX, clientY: 24 });
      await waitFor(() => {
        expect(ipcMocks.trimLayer).toHaveBeenCalledWith(
          layer.id,
          "out",
          oneFrameUs,
          false,
        );
      });
      expect(onMutated).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      fpsNum: 30,
      fpsDen: 1,
      lastFrameStartUs: 1_966_667,
      lastFrameLabel: "00:00:01:29",
    },
    {
      fpsNum: 60,
      fpsDen: 1,
      lastFrameStartUs: 1_983_333,
      lastFrameLabel: "00:00:01:59",
    },
  ])(
    "trims a layer down to one frame by dragging its left edge at $fpsNum/$fpsDen fps",
    async ({ fpsNum, fpsDen, lastFrameStartUs, lastFrameLabel }) => {
      const onMutated = vi.fn().mockResolvedValue(undefined);
      const { getByText } = renderTimeline({
        selectedLayerId: layer.id,
        onMutated,
        fpsNum,
        fpsDen,
      });
      const block = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
      vi.spyOn(block, "getBoundingClientRect").mockReturnValue({
        left: 0,
        right: 160,
        top: 0,
        bottom: 48,
        width: 160,
        height: 48,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const lastFrameEdgeX = (lastFrameStartUs / 1_000_000) * 80;
      fireEvent.pointerDown(block, { button: 0, clientX: 0, clientY: 24 });
      fireEvent.pointerMove(window, { clientX: lastFrameEdgeX, clientY: 24 });

      expect(block.title).toContain(`${lastFrameLabel} → 00:00:02:00`);

      fireEvent.pointerUp(window, { clientX: lastFrameEdgeX, clientY: 24 });
      await waitFor(() => {
        expect(ipcMocks.trimLayer).toHaveBeenCalledWith(
          layer.id,
          "in",
          lastFrameStartUs,
          false,
        );
      });
      expect(onMutated).toHaveBeenCalledOnce();
    },
  );

  it("extends an existing one-frame clip by one frame instead of forcing 100 ms", async () => {
    const oneFrameLayer: LayerSummary = {
      ...layer,
      id: "one-frame-layer",
      label: "One frame",
      t_end_us: 33_333,
    };
    const oneFrameTrack: TrackSummary = { ...track, layers: [oneFrameLayer] };
    const { container } = renderTimeline({
      tracks: [oneFrameTrack],
      selectedLayerId: oneFrameLayer.id,
    });
    const block = container.querySelector(".timeline-layer") as HTMLElement;
    vi.spyOn(block, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 4,
      top: 0,
      bottom: 48,
      width: 4,
      height: 48,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const oneFrameWidthPx = (33_333 / 1_000_000) * 80;
    fireEvent.pointerDown(block, { button: 0, clientX: 4, clientY: 24 });
    fireEvent.pointerMove(window, {
      clientX: 4 + oneFrameWidthPx,
      clientY: 24,
    });
    expect(block.title).toContain("00:00:00:00 → 00:00:00:02");

    fireEvent.pointerUp(window, {
      clientX: 4 + oneFrameWidthPx,
      clientY: 24,
    });
    await waitFor(() => {
      expect(ipcMocks.trimLayer).toHaveBeenCalledWith(
        oneFrameLayer.id,
        "out",
        66_667,
        false,
      );
    });
  });

  it("previews every grouped layer during and immediately after a move drag", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    const { getByText } = renderTimeline({
      tracks: [groupedTrack],
      groups: [group],
      selectedLayerId: layer.id,
      onMutated,
    });

    const first = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
    const second = getByText("Clip B").closest(".timeline-layer") as HTMLElement;

    expect(first.style.left).toBe("0px");
    expect(second.style.left).toBe("160px");

    fireEvent.pointerDown(first, { button: 0, clientX: 0, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 30 });

    expect(first.style.left).toBe("80px");
    expect(second.style.left).toBe("240px");

    fireEvent.pointerUp(window, { clientX: 80, clientY: 30 });

    await waitFor(() => {
      expect(ipcMocks.moveLayer).toHaveBeenCalledWith(layer.id, track.id, 1_000_000, false);
      expect(first.style.left).toBe("80px");
      expect(second.style.left).toBe("240px");
    });
  });

  it("Alt+drag keeps a grouped source in place and duplicates only the dragged layer", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    const { getByText, container } = renderTimeline({
      tracks: [groupedTrack],
      groups: [group],
      selectedLayerId: layer.id,
      onMutated,
    });

    const source = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
    const sibling = getByText("Clip B").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(source, {
      button: 0,
      clientX: 0,
      clientY: 30,
      altKey: true,
    });
    fireEvent.pointerMove(window, { clientX: 320, clientY: 30, altKey: true });

    const preview = container.querySelector(
      '[data-duplicate-preview="true"]',
    ) as HTMLElement;
    expect(source.style.left).toBe("0px");
    expect(sibling.style.left).toBe("160px");
    expect(preview).not.toBeNull();
    expect(preview.style.left).toBe("320px");

    fireEvent.pointerUp(window, { clientX: 320, clientY: 30, altKey: true });

    await waitFor(() => {
      expect(ipcMocks.pasteLayer).toHaveBeenCalledWith(
        layer.id,
        4_000_000,
        track.id,
      );
    });
    expect(ipcMocks.moveLayer).not.toHaveBeenCalled();
  });

  it("blocks an Alt+drag duplicate that would overlap its source", () => {
    const { getByText, container } = renderTimeline({
      tracks: [track],
      selectedLayerId: layer.id,
    });
    const source = getByText("Clip A").closest(".timeline-layer") as HTMLElement;

    fireEvent.pointerDown(source, {
      button: 0,
      clientX: 0,
      clientY: 30,
      altKey: true,
    });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 30, altKey: true });

    const preview = container.querySelector(
      '[data-duplicate-preview="true"]',
    ) as HTMLElement;
    expect(source.style.left).toBe("0px");
    expect(preview.dataset.dragValidity).toBe("collision");

    fireEvent.pointerUp(window, { clientX: 80, clientY: 30, altKey: true });
    expect(ipcMocks.pasteLayer).not.toHaveBeenCalled();
    expect(ipcMocks.moveLayer).not.toHaveBeenCalled();
  });

  it("shows a collision state and blocks an existing visual clip move before IPC", () => {
    const { getByText } = renderTimeline({
      tracks: [groupedTrack],
      groups: [],
      selectedLayerId: groupedLayer.id,
    });
    const moving = getByText("Clip B").closest(".timeline-layer") as HTMLElement;

    // Move Clip B from [2s, 4s) to [1s, 3s), overlapping Clip A [0s, 2s).
    fireEvent.pointerDown(moving, { button: 0, clientX: 160, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 30 });

    expect(moving.dataset.dragValidity).toBe("collision");
    expect(
      moving.querySelector('[data-testid="layer-drag-invalid-badge"]'),
    ).not.toBeNull();

    fireEvent.pointerUp(window, { clientX: 80, clientY: 30 });
    expect(ipcMocks.moveLayer).not.toHaveBeenCalled();
  });

  it("allows an existing visual clip to move over audio on the same track", () => {
    const audio: LayerSummary = {
      ...layer,
      id: "audio-1",
      label: "Audio bed",
      kind: "Audio",
      t_start_us: 1_900_000,
      t_end_us: 2_000_000,
      params: {
        kind: "Audio",
        media_id: "media-audio",
        media_label: "audio.wav",
        src_in_us: 0,
        src_out_us: 100_000,
        gain_db: staticNum(0),
        pan: staticNum(0),
        fade_in_us: 0,
        fade_out_us: 0,
        mute: false,
        role: "music",
      },
    };
    const movingVisual: LayerSummary = {
      ...groupedLayer,
      id: "moving-visual",
      label: "Moving visual",
    };
    const mixedTrack: TrackSummary = {
      ...track,
      layers: [audio, movingVisual],
    };
    const { getByText } = renderTimeline({
      tracks: [mixedTrack],
      selectedLayerId: movingVisual.id,
    });
    const moving = getByText("Moving visual").closest(
      ".timeline-layer",
    ) as HTMLElement;

    fireEvent.pointerDown(moving, { button: 0, clientX: 160, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 30 });

    expect(moving.dataset.dragValidity).toBe("valid");
    expect(
      moving.querySelector('[data-testid="layer-drag-invalid-badge"]'),
    ).toBeNull();

    fireEvent.pointerUp(window, { clientX: 80, clientY: 30 });
    expect(ipcMocks.moveLayer).toHaveBeenCalledWith(
      movingVisual.id,
      track.id,
      1_000_000,
      false,
    );
  });

  it("marks every group ghost invalid when a sibling would collide", () => {
    const anchor: LayerSummary = {
      ...layer,
      id: "group-anchor",
      label: "Group anchor",
      t_start_us: 0,
      t_end_us: 1_000_000,
    };
    const sibling: LayerSummary = {
      ...groupedLayer,
      id: "group-sibling",
      label: "Group sibling",
      t_start_us: 2_000_000,
      t_end_us: 3_000_000,
    };
    const blocker: LayerSummary = {
      ...layer,
      id: "group-blocker",
      label: "Blocker",
      t_start_us: 4_000_000,
      t_end_us: 5_000_000,
    };
    const collisionTrack: TrackSummary = {
      ...track,
      layers: [anchor, sibling, blocker],
    };
    const collisionGroup: GroupSummary = {
      id: "collision-group",
      label: null,
      layer_ids: [anchor.id, sibling.id],
    };
    const { getByText } = renderTimeline({
      tracks: [collisionTrack],
      groups: [collisionGroup],
      selectedLayerId: anchor.id,
    });
    const anchorBlock = getByText("Group anchor").closest(
      ".timeline-layer",
    ) as HTMLElement;
    const siblingBlock = getByText(/Group siblin/).closest(
      ".timeline-layer",
    ) as HTMLElement;

    // +2s keeps the two group members adjacent, but moves the sibling onto Blocker.
    fireEvent.pointerDown(anchorBlock, { button: 0, clientX: 0, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 160, clientY: 30 });

    expect(anchorBlock.dataset.dragValidity).toBe("collision");
    expect(siblingBlock.dataset.dragValidity).toBe("collision");
    expect(
      anchorBlock.querySelector('[data-testid="layer-drag-invalid-badge"]'),
    ).not.toBeNull();
    expect(
      siblingBlock.querySelector('[data-testid="layer-drag-invalid-badge"]'),
    ).toBeNull();

    fireEvent.pointerUp(window, { clientX: 160, clientY: 30 });
    expect(ipcMocks.moveLayer).not.toHaveBeenCalled();
  });

  it.each(["AbRoll", "ShowAll"] as const)(
    "renders the same duration-sized media ghost in %s mode",
    (displayMode) => {
      useAppSettingsStore.setState((s) => ({
        settings: { ...s.settings, display_mode: displayMode },
      }));
      const payload = mediaDragPayload(sourceMedia);
      useMediaDragStore.getState().begin(payload);
      const { container } = renderTimeline({ media: [sourceMedia] });
      const lane = container.querySelector('[data-testid="track-lane"]') as HTMLElement;
      vi.spyOn(lane, "getBoundingClientRect").mockReturnValue({
        left: 0,
        right: 1040,
        top: 0,
        bottom: 64,
        width: 1040,
        height: 64,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      const dataTransfer = {
        types: [MEDIA_DRAG_TYPE],
        dropEffect: "copy",
        getData: () => JSON.stringify(payload),
      };

      // At 80 px/s this pointer maps to 3s only after subtracting the
      // 32px cursor-in-ghost offset. The 3s source therefore spans 3s→6s.
      const dragOver = createEvent.dragOver(lane, { dataTransfer });
      Object.defineProperty(dragOver, "clientX", {
        value: MEDIA_DRAG_CURSOR_OFFSET_PX + 240,
      });
      fireEvent(lane, dragOver);

      const ghost = container.querySelector(
        '[data-testid="media-drop-ghost"]',
      ) as HTMLElement;
      expect(ghost.dataset.validity).toBe("valid");
      expect(ghost.dataset.startUs).toBe("3000000");
      expect(ghost.dataset.endUs).toBe("6000000");
      expect(ghost.style.left).toBe("240px");
      expect(ghost.style.width).toBe("240px");
      expect(ghost.classList.contains("media-drop-ghost")).toBe(true);
      expect(useMediaDragStore.getState().absorptionTarget).toMatchObject({
        left: 254,
        top: 18,
        width: 36,
        height: 20,
      });
    },
  );

  it("transfers media ghost and lane focus exclusively between A-roll and B-roll", () => {
    const bRollTrack: TrackSummary = {
      ...track,
      id: "track-2",
      label: "S2",
      role: "b-roll",
      layers: [],
    };
    const payload = mediaDragPayload(sourceMedia);
    useMediaDragStore.getState().begin(payload);
    const { container } = renderTimeline({
      tracks: [track, bRollTrack],
      media: [sourceMedia],
    });
    const lanes = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="track-lane"]'),
    );
    expect(lanes).toHaveLength(2);
    const [aRollLane, bRollLane] = lanes as [HTMLElement, HTMLElement];
    vi.spyOn(aRollLane, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 1040,
      top: 0,
      bottom: 64,
      width: 1040,
      height: 64,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(bRollLane, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 1040,
      top: 64,
      bottom: 128,
      width: 1040,
      height: 64,
      x: 0,
      y: 64,
      toJSON: () => ({}),
    });
    const dataTransfer = {
      types: [MEDIA_DRAG_TYPE],
      dropEffect: "copy",
      getData: () => JSON.stringify(payload),
    };
    const dragOver = (lane: HTMLElement, clientY: number) => {
      const event = createEvent.dragOver(lane, { dataTransfer });
      Object.defineProperties(event, {
        clientX: { value: MEDIA_DRAG_CURSOR_OFFSET_PX + 240 },
        clientY: { value: clientY },
      });
      fireEvent(lane, event);
    };
    const laneStates = () =>
      lanes.map((lane) => ({
        focused:
          lane.classList.contains("outline-blue-300/80") ||
          lane.classList.contains("bg-blue-500/10"),
        ghostCount: lane.querySelectorAll('[data-testid="media-drop-ghost"]')
          .length,
      }));

    dragOver(aRollLane, 32);
    const onARoll = laneStates();

    // The incoming lane must claim the one active focus without depending on
    // the outgoing lane first receiving a trustworthy dragleave event.
    dragOver(bRollLane, 96);
    const onBRoll = laneStates();

    dragOver(aRollLane, 32);
    const backOnARoll = laneStates();

    expect([onARoll, onBRoll, backOnARoll]).toEqual([
      [
        { focused: true, ghostCount: 1 },
        { focused: false, ghostCount: 0 },
      ],
      [
        { focused: false, ghostCount: 0 },
        { focused: true, ghostCount: 1 },
      ],
      [
        { focused: true, ghostCount: 1 },
        { focused: false, ghostCount: 0 },
      ],
    ]);
  });

  it("marks a collision and blocks the drop before IPC", () => {
    const payload = mediaDragPayload(sourceMedia);
    useMediaDragStore.getState().begin(payload);
    const { container } = renderTimeline({ media: [sourceMedia] });
    const lane = container.querySelector('[data-testid="track-lane"]') as HTMLElement;
    vi.spyOn(lane, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 1040,
      top: 0,
      bottom: 64,
      width: 1040,
      height: 64,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const dataTransfer = {
      types: [MEDIA_DRAG_TYPE],
      dropEffect: "copy",
      getData: () => JSON.stringify(payload),
    };

    const dragOver = createEvent.dragOver(lane, { dataTransfer });
    // start=1s, end=4s; overlaps the existing visual clip at [0s,2s).
    Object.defineProperty(dragOver, "clientX", {
      value: MEDIA_DRAG_CURSOR_OFFSET_PX + 80,
    });
    fireEvent(lane, dragOver);
    expect(
      container.querySelector('[data-testid="media-drop-ghost"]')
        ?.getAttribute("data-validity"),
    ).toBe("collision");

    const drop = createEvent.drop(lane, { dataTransfer });
    Object.defineProperty(drop, "clientX", {
      value: MEDIA_DRAG_CURSOR_OFFSET_PX + 80,
    });
    fireEvent(lane, drop);
    expect(ipcMocks.addMediaLayer).not.toHaveBeenCalled();
  });
});
