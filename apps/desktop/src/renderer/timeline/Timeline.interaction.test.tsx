// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
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

const ipcMocks = vi.hoisted(() => ({
  addMediaLayer: vi.fn().mockResolvedValue(undefined),
  moveLayer: vi.fn().mockResolvedValue(undefined),
  pasteLayer: vi.fn().mockResolvedValue("duplicated-layer"),
  trimLayer: vi.fn().mockResolvedValue(undefined),
  getWaveformPeaks: vi.fn().mockRejectedValue("not_ready"),
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
  onSelect?: (id: string | null) => void;
  bladeMode?: boolean;
  tracks?: TrackSummary[];
  groups?: GroupSummary[];
  media?: MediaSummary[];
  onMutated?: () => Promise<void>;
}) {
  const onSeek = overrides.onSeek ?? vi.fn();
  const onSelect = overrides.onSelect ?? vi.fn();
  return render(
    <Timeline
      tracks={overrides.tracks ?? [track]}
      groups={overrides.groups ?? []}
      durationUs={5_000_000}
      selectedLayerId={overrides.selectedLayerId ?? null}
      keybindings={{}}
      fpsNum={30}
      fpsDen={1}
      bladeMode={overrides.bladeMode ?? false}
      media={overrides.media ?? []}
      importing={new Set()}
      proxyState={new Map()}
      previewDecodable={new Set()}
      onExitBlade={vi.fn()}
      onSelect={onSelect}
      onSeek={onSeek}
      onMutated={overrides.onMutated ?? vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

describe("Timeline seek/selection coupling", () => {
  beforeEach(() => {
    ipcMocks.addMediaLayer.mockClear();
    ipcMocks.moveLayer.mockClear();
    ipcMocks.pasteLayer.mockClear();
    ipcMocks.trimLayer.mockClear();
    ipcMocks.getWaveformPeaks.mockClear();
    // Show-All so the role-stamped track always renders regardless of the
    // default AB-roll filter.
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, display_mode: "ShowAll" },
    }));
  });
  afterEach(() => {
    useMediaDragStore.getState().end();
    cleanup();
  });

  it("clicking the ruler seeks AND keeps the selected clip selected", () => {
    const onSeek = vi.fn();
    const onSelect = vi.fn();
    const { container } = renderTimeline({ selectedLayerId: layer.id, onSeek, onSelect });
    const ruler = container.querySelector('[data-testid="timeline-ruler"]')!;
    fireEvent.pointerDown(ruler, { button: 0, clientX: 200 });
    fireEvent.pointerUp(window, { clientX: 200 });
    fireEvent.click(ruler);
    expect(onSeek).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clicking empty lane background deselects and does NOT seek", () => {
    const onSeek = vi.fn();
    const onSelect = vi.fn();
    const { container } = renderTimeline({ selectedLayerId: layer.id, onSeek, onSelect });
    const lane = container.querySelector('[data-testid="track-lane"]')!;
    fireEvent.pointerDown(lane, { button: 0, clientX: 200 });
    fireEvent.pointerUp(window, { clientX: 200 });
    fireEvent.click(lane);
    expect(onSeek).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("clicking a clip selects it without seeking", () => {
    const onSeek = vi.fn();
    const onSelect = vi.fn();
    const { container } = renderTimeline({ selectedLayerId: null, onSeek, onSelect });
    const block = container.querySelector(".timeline-layer")!;
    fireEvent.pointerDown(block, { button: 0, clientX: 50 });
    fireEvent.pointerUp(window, { clientX: 50 });
    fireEvent.click(block);
    expect(onSelect).toHaveBeenCalledWith(layer.id);
    expect(onSeek).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalledWith(null);
  });

  it("clicking the content preview overlay still selects without seeking", () => {
    const onSeek = vi.fn();
    const onSelect = vi.fn();
    const { container } = renderTimeline({ selectedLayerId: null, onSeek, onSelect });
    const preview = container.querySelector('[data-testid="timeline-visual-preview"]')!;
    fireEvent.pointerDown(preview, { button: 0, clientX: 50 });
    fireEvent.pointerUp(window, { clientX: 50 });
    fireEvent.click(preview);
    expect(onSelect).toHaveBeenCalledWith(layer.id);
    expect(onSeek).not.toHaveBeenCalled();
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
    const onSelect = vi.fn();
    const { container } = renderTimeline({ selectedLayerId: layer.id, onSeek, onSelect });
    const ruler = container.querySelector('[data-testid="timeline-ruler"]')!;
    fireEvent.pointerDown(ruler, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 300 });
    fireEvent.pointerUp(window, { clientX: 300 });
    // pointerdown seeks once; the drag-scrub pointermove seeks again.
    expect(onSeek.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onSelect).not.toHaveBeenCalled();
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
