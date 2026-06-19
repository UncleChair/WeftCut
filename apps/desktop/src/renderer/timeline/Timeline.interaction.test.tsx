// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import "../i18n"; // initialize i18next so t(key) resolves in chrome
import type { LayerSummary, TrackSummary } from "../ipc";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { Timeline } from "./Timeline";

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
    viewStateGet: vi
      .fn()
      .mockResolvedValue({ timeline_px_per_sec: 50, track_heights: {}, expanded_tracks: [] }),
    viewStateSet: vi.fn().mockResolvedValue(undefined),
  };
});

const layer: LayerSummary = {
  id: "layer-1",
  label: "Clip A",
  t_start_us: 0,
  t_end_us: 2_000_000,
  kind: "Subtitles",
  color_hint: "#4488cc",
  enabled: true,
  locked: false,
  params: { kind: "Subtitles", source_kind: "InlineSrt", source_value: "" },
};

const track: TrackSummary = {
  id: "track-1",
  kind: "Subtitle",
  label: "S1",
  enabled: true,
  locked: false,
  muted: false,
  solo: false,
  role: "a-roll",
  transient: false,
  layers: [layer],
};

function renderTimeline(overrides: {
  selectedLayerId?: string | null;
  onSeek?: () => void;
  onSelect?: (id: string | null) => void;
}) {
  const onSeek = overrides.onSeek ?? vi.fn();
  const onSelect = overrides.onSelect ?? vi.fn();
  return render(
    <Timeline
      tracks={[track]}
      groups={[]}
      durationUs={5_000_000}
      currentTimeUs={0}
      selectedLayerId={overrides.selectedLayerId ?? null}
      keybindings={{}}
      fpsNum={30}
      fpsDen={1}
      bladeMode={false}
      media={[]}
      importing={new Set()}
      proxyState={new Map()}
      previewDecodable={new Set()}
      onExitBlade={vi.fn()}
      onSelect={onSelect}
      onSeek={onSeek}
      onMutated={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

describe("Timeline seek/selection coupling", () => {
  beforeEach(() => {
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
});
