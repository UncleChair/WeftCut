// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import "../i18n"; // initialize i18next so t(key) resolves in chrome
import type { GroupSummary, LayerSummary, TrackSummary } from "../ipc";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { Timeline } from "./Timeline";

const ipcMocks = vi.hoisted(() => ({
  moveLayer: vi.fn().mockResolvedValue(undefined),
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
    moveLayer: ipcMocks.moveLayer,
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

function renderTimeline(overrides: {
  selectedLayerId?: string | null;
  onSeek?: () => void;
  onSelect?: (id: string | null) => void;
  bladeMode?: boolean;
  tracks?: TrackSummary[];
  groups?: GroupSummary[];
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
      media={[]}
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
    ipcMocks.moveLayer.mockClear();
    ipcMocks.trimLayer.mockClear();
    ipcMocks.getWaveformPeaks.mockClear();
    // Show-All so the role-stamped track always renders regardless of the
    // default AB-roll filter.
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, display_mode: "ShowAll" },
    }));
  });
  afterEach(cleanup);

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
});
