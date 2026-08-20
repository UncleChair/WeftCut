// @vitest-environment jsdom
// Timeline transition UI: chip render/selection/Delete, the chip's two-edge
// drag (spec D6), the cut context menu, and the insufficient-handle error
// surface. Geometry math is unit-tested in transitions.test.ts (+ the golden
// pair); this covers the wiring (same style as Timeline.interaction.test.tsx).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "../i18n"; // initialize i18next so t(key) resolves in chrome
import type { LayerSummary, TrackSummary, TransitionSummary } from "../ipc";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { Timeline } from "./Timeline";
import {
  clearLayerSelection,
  setLayerSelection,
  useSelectionStore,
} from "../state/selectionStore";
import { setActiveRegion } from "../focus/focusRegionStore";
import { registerTransport, releaseTransport } from "../state/playbackStore";
import { playheadTimeUs, setPlayheadTimeUs } from "../state/playheadStore";

const ipcMocks = vi.hoisted(() => ({
  addTransition: vi.fn().mockResolvedValue("new-transition"),
  updateTransition: vi.fn().mockResolvedValue(undefined),
  removeTransition: vi.fn().mockResolvedValue(undefined),
  // Layer mutations mocked only to PIN that chip gestures never reach them
  // (the window-capture contract).
  moveLayer: vi.fn().mockResolvedValue(undefined),
  trimLayer: vi.fn().mockResolvedValue(undefined),
  getWaveformPeaks: vi.fn().mockRejectedValue("not_ready"),
  logEmit: vi.fn().mockResolvedValue(undefined),
  viewStateGet: vi
    .fn()
    .mockResolvedValue({ timeline_px_per_sec: 80, track_heights: {}, expanded_tracks: [] }),
  viewStateSet: vi.fn().mockResolvedValue(undefined),
}));

// jsdom does not implement PointerEvent; alias it to MouseEvent (same shim
// as Timeline.interaction.test.tsx).
if (typeof window !== "undefined" && !window.PointerEvent) {
  (window as unknown as Record<string, unknown>).PointerEvent = window.MouseEvent;
}

vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return {
    ...actual,
    addTransition: ipcMocks.addTransition,
    updateTransition: ipcMocks.updateTransition,
    removeTransition: ipcMocks.removeTransition,
    moveLayer: ipcMocks.moveLayer,
    trimLayer: ipcMocks.trimLayer,
    getWaveformPeaks: ipcMocks.getWaveformPeaks,
    logEmit: ipcMocks.logEmit,
    viewStateGet: ipcMocks.viewStateGet,
    viewStateSet: ipcMocks.viewStateSet,
  };
});

function colorLayer(id: string, label: string, tStartUs: number, tEndUs: number): LayerSummary {
  return {
    id,
    label,
    t_start_us: tStartUs,
    t_end_us: tEndUs,
    kind: "Color",
    color_hint: "#4488cc",
    enabled: true,
    locked: false,
    params: {
      kind: "Color",
      color: { mode: "Static", value: { r: 0, g: 0, b: 0, a: 255 } },
      width: 1920,
      height: 1080,
    },
    effects: [],
  };
}

function makeTrack(layers: LayerSummary[]): TrackSummary {
  return {
    id: "track-1",
    kind: "Video",
    label: "S1",
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: "a-roll",
    transient: false,
    layers,
  };
}

// Adjacent hard cut at 2s (no transition yet).
const layerA = colorLayer("layer-a", "Clip A", 0, 2_000_000);
const layerB = colorLayer("layer-b", "Clip B", 2_000_000, 4_000_000);

// Post-add state under EXTEND placement (reachable via placement:'extend' /
// the chip's right edge): A borrowed 0.5s of tail, the transition rides it.
const extendedA = colorLayer("layer-a", "Clip A", 0, 2_500_000);
const transition: TransitionSummary = {
  id: "tr-1",
  from_layer: "layer-a",
  to_layer: "layer-b",
  duration_us: 500_000,
  kind: { kind: "Wipe", direction: "left" },
  extended_us: 500_000,
};

function renderTimeline(overrides: {
  tracks?: TrackSummary[];
  transitions?: TransitionSummary[];
  onMutated?: () => Promise<void>;
}) {
  return render(
    <Timeline
      tracks={overrides.tracks ?? [makeTrack([layerA, layerB])]}
      groups={[]}
      {...(overrides.transitions ? { transitions: overrides.transitions } : {})}
      durationUs={5_000_000}
      keybindings={{}}
      fpsNum={30}
      fpsDen={1}
      bladeMode={false}
      media={[]}
      importing={new Set()}
      proxyState={new Map()}
      previewDecodable={new Set()}
      onExitBlade={vi.fn()}
      onSeek={vi.fn()}
      onMutated={overrides.onMutated ?? vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

beforeEach(() => {
  clearLayerSelection();
  // No region by default: a leaked one would arm the chip's Delete preemptor
  // for tests that never meant to exercise the keyboard.
  setActiveRegion(null);
  ipcMocks.addTransition.mockClear();
  ipcMocks.updateTransition.mockClear();
  ipcMocks.removeTransition.mockClear();
  ipcMocks.moveLayer.mockClear();
  ipcMocks.trimLayer.mockClear();
  ipcMocks.logEmit.mockClear();
  useAppSettingsStore.setState((s) => ({
    settings: { ...s.settings, display_mode: "ShowAll" },
  }));
});
afterEach(cleanup);

describe("transition chip", () => {
  it("renders over the incoming layer's head: left at the cut, width = duration", () => {
    const { container } = renderTimeline({
      tracks: [makeTrack([extendedA, layerB])],
      transitions: [transition],
    });
    const chip = container.querySelector(
      '[data-testid="transition-chip"]',
    ) as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.dataset.transitionId).toBe("tr-1");
    // 80 px/s: cut at 2s → 160px; 0.5s duration → 40px.
    expect(chip.style.left).toBe("160px");
    expect(chip.style.width).toBe("40px");
  });

  it("click selects the chip and deselects layers; lane background click deselects the chip", () => {
    const { container } = renderTimeline({
      tracks: [makeTrack([extendedA, layerB])],
      transitions: [transition],
    });
    setLayerSelection("layer-a", ["layer-a"]);
    const chip = container.querySelector(
      '[data-testid="transition-chip"]',
    ) as HTMLElement;

    fireEvent.pointerDown(chip, { button: 0 });
    fireEvent.click(chip);
    expect(useSelectionStore.getState().selectedTransitionId).toBe("tr-1");
    expect(useSelectionStore.getState().primaryLayerId).toBeNull();
    expect(useSelectionStore.getState().selectedLayerIds.size).toBe(0);

    // Selecting a layer evicts the chip selection (mutual exclusion).
    setLayerSelection("layer-b", ["layer-b"]);
    expect(useSelectionStore.getState().selectedTransitionId).toBeNull();
  });

  it("Delete key removes the selected chip via remove_transition", async () => {
    // The chip's Delete preemptor stands down unless the timeline region owns
    // the keyboard (`subSelectionDeleteYields`), and this harness renders
    // Timeline outside the dock Panel that would BE that region.
    setActiveRegion("timeline");
    const onMutated = vi.fn().mockResolvedValue(undefined);
    const { container } = renderTimeline({
      tracks: [makeTrack([extendedA, layerB])],
      transitions: [transition],
      onMutated,
    });
    const chip = container.querySelector(
      '[data-testid="transition-chip"]',
    ) as HTMLElement;
    fireEvent.pointerDown(chip, { button: 0 });
    expect(useSelectionStore.getState().selectedTransitionId).toBe("tr-1");

    fireEvent.keyDown(window, { key: "Delete" });
    await waitFor(() => {
      expect(ipcMocks.removeTransition).toHaveBeenCalledWith("tr-1");
      expect(onMutated).toHaveBeenCalled();
    });
    expect(useSelectionStore.getState().selectedTransitionId).toBeNull();
  });

  it("Delete does nothing when no chip is selected", () => {
    renderTimeline({
      tracks: [makeTrack([extendedA, layerB])],
      transitions: [transition],
    });
    fireEvent.keyDown(window, { key: "Delete" });
    expect(ipcMocks.removeTransition).not.toHaveBeenCalled();
  });
});

describe("chip two-edge drag (spec D6)", () => {
  // Extend fixture (top of file): window [2M, 2.5M] at 80 px/s → chip left
  // 160px, width 40px; A [0, 2.5M], B [2M, 4M], e = 500k → S = 2M. Color
  // participants → infinite tail (the finite-tail clamp is golden-pinned).
  // The drag maps by pointer DELTA, so no getBoundingClientRect mock is needed
  // (zones are real children; jsdom's zero-rects never enter the math).
  const zone = (container: HTMLElement, side: "left" | "right") =>
    container.querySelector(
      `[data-testid="transition-chip-edge-${side}"]`,
    ) as HTMLElement;
  const chipEl = (container: HTMLElement) =>
    container.querySelector('[data-testid="transition-chip"]') as HTMLElement;

  it("left edge commits ONCE with (d′ = A.end − L, current e explicit) — and no layer mutation ever fires", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    const { container } = renderTimeline({
      tracks: [makeTrack([extendedA, layerB])],
      transitions: [transition],
      onMutated,
    });
    // Grabbing "B's head" (the 6px band at the window start) gets the chip's
    // left edge — the window-capture contract for bare participant edges.
    fireEvent.pointerDown(zone(container, "left"), { button: 0, clientX: 160 });
    fireEvent.pointerMove(window, { clientX: 140, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 120, clientY: 30 }); // L → 1.5M (frame 45)
    fireEvent.pointerUp(window, { clientX: 120, clientY: 30 });
    await waitFor(() => {
      expect(ipcMocks.updateTransition).toHaveBeenCalledTimes(1);
      expect(onMutated).toHaveBeenCalled();
    });
    expect(ipcMocks.updateTransition).toHaveBeenCalledWith({
      transitionId: "tr-1",
      durationUs: 1_000_000, // A.end 2.5M − L 1.5M
      extendedUs: 500_000, // the CURRENT e — what pins A.end
    });
    expect(ipcMocks.trimLayer).not.toHaveBeenCalled();
    expect(ipcMocks.moveLayer).not.toHaveBeenCalled();
    expect(useSelectionStore.getState().selectedTransitionId).toBe("tr-1");
    expect(useSelectionStore.getState().primaryLayerId).toBeNull();
  });

  it("right edge dragged right commits ONCE with the explicit borrow (R − B.start, R − S)", async () => {
    const { container } = renderTimeline({
      tracks: [makeTrack([extendedA, layerB])],
      transitions: [transition],
    });
    fireEvent.pointerDown(zone(container, "right"), { button: 0, clientX: 200 });
    fireEvent.pointerMove(window, { clientX: 240, clientY: 30 }); // R → 3M (frame 90)
    fireEvent.pointerUp(window, { clientX: 240, clientY: 30 });
    await waitFor(() => {
      expect(ipcMocks.updateTransition).toHaveBeenCalledTimes(1);
    });
    expect(ipcMocks.updateTransition).toHaveBeenCalledWith({
      transitionId: "tr-1",
      durationUs: 1_000_000, // R 3M − B.start 2M
      extendedUs: 1_000_000, // R − S(2M): the borrow grows
    });
    expect(ipcMocks.trimLayer).not.toHaveBeenCalled();
  });

  it("right edge dragged left past S sends a NEGATIVE extendedUs — the genuine tail trim rides the same commit", async () => {
    // Overlap fixture: pure placement, window [1M, 2M], S = A.end = 2M.
    const overlapA = colorLayer("layer-a", "Clip A", 0, 2_000_000);
    const overlapB = colorLayer("layer-b", "Clip B", 1_000_000, 3_000_000);
    const overlapTr: TransitionSummary = {
      ...transition,
      duration_us: 1_000_000,
      extended_us: 0,
    };
    const { container } = renderTimeline({
      tracks: [makeTrack([overlapA, overlapB])],
      transitions: [overlapTr],
    });
    fireEvent.pointerDown(zone(container, "right"), { button: 0, clientX: 160 });
    fireEvent.pointerMove(window, { clientX: 136, clientY: 30 }); // R → 1.7M (frame 51)
    fireEvent.pointerUp(window, { clientX: 136, clientY: 30 });
    await waitFor(() => {
      expect(ipcMocks.updateTransition).toHaveBeenCalledTimes(1);
    });
    expect(ipcMocks.updateTransition).toHaveBeenCalledWith({
      transitionId: "tr-1",
      durationUs: 700_000, // R 1.7M − B.start 1M
      extendedUs: -300_000, // R − S(2M) < 0: trim A's real tail
    });
  });

  it("the ghost never exceeds the clamps: a far-left left-edge drag renders at min(len_A, len_B) and commits the clamp", async () => {
    const { container } = renderTimeline({
      tracks: [makeTrack([extendedA, layerB])],
      transitions: [transition],
    });
    fireEvent.pointerDown(zone(container, "left"), { button: 0, clientX: 160 });
    fireEvent.pointerMove(window, { clientX: -240, clientY: 30 }); // raw L = −3M
    // Clamped ghost: L = A.end − min(2.5M, 2M) = 0.5M → left 40px, width 160px.
    expect(chipEl(container).style.left).toBe("40px");
    expect(chipEl(container).style.width).toBe("160px");
    fireEvent.pointerUp(window, { clientX: -240, clientY: 30 });
    await waitFor(() => {
      expect(ipcMocks.updateTransition).toHaveBeenCalledWith({
        transitionId: "tr-1",
        durationUs: 2_000_000,
        extendedUs: 500_000,
      });
    });
    // Gesture over: the ghost collapses back to summary geometry.
    expect(chipEl(container).style.left).toBe("160px");
    expect(chipEl(container).style.width).toBe("40px");
  });

  it("a stationary pointer never commits — pointerup without movement and a sub-frame wiggle are both no-ops", () => {
    const { container } = renderTimeline({
      tracks: [makeTrack([extendedA, layerB])],
      transitions: [transition],
    });
    fireEvent.pointerDown(zone(container, "right"), { button: 0, clientX: 200 });
    fireEvent.pointerUp(window, { clientX: 200, clientY: 30 });
    // +1px = 12.5ms — rounds back to the starting frame boundary.
    fireEvent.pointerDown(zone(container, "right"), { button: 0, clientX: 200 });
    fireEvent.pointerMove(window, { clientX: 201, clientY: 30 });
    fireEvent.pointerUp(window, { clientX: 201, clientY: 30 });
    expect(ipcMocks.updateTransition).not.toHaveBeenCalled();
  });

  it("pointerdown on the chip BODY over the window swallows the gesture: no layer trim/move/select, no commit", () => {
    const { container } = renderTimeline({
      tracks: [makeTrack([extendedA, layerB])],
      transitions: [transition],
    });
    // 180px = mid-window, over B's head material; the chip sits above both
    // blocks, so only IT sees the pointer.
    fireEvent.pointerDown(chipEl(container), { button: 0, clientX: 180 });
    fireEvent.pointerMove(window, { clientX: 260, clientY: 30 });
    fireEvent.pointerUp(window, { clientX: 260, clientY: 30 });
    expect(ipcMocks.updateTransition).not.toHaveBeenCalled();
    expect(ipcMocks.trimLayer).not.toHaveBeenCalled();
    expect(ipcMocks.moveLayer).not.toHaveBeenCalled();
    expect(useSelectionStore.getState().selectedTransitionId).toBe("tr-1");
    expect(useSelectionStore.getState().primaryLayerId).toBeNull();
  });

  it("right edge drives the monitor to the LAST KEPT frame from the first effective move and restores on release", async () => {
    const seek = vi.fn();
    const pause = vi.fn();
    const transport = { play() {}, pause, seek, isPlaying: () => false };
    registerTransport(transport);
    setPlayheadTimeUs(300_000);
    const { container } = renderTimeline({
      tracks: [makeTrack([extendedA, layerB])],
      transitions: [transition],
    });
    fireEvent.pointerDown(zone(container, "right"), { button: 0, clientX: 200 });
    fireEvent.pointerMove(window, { clientX: 240, clientY: 30 }); // R → 3M
    // Out-style boundary: show the last kept frame (89 @ 30fps), not R itself.
    expect(pause).toHaveBeenCalled();
    expect(seek).toHaveBeenCalledWith(2_966_667);
    fireEvent.pointerUp(window, { clientX: 240, clientY: 30 });
    // Playhead line AND monitor return to the park position.
    expect(playheadTimeUs()).toBe(300_000);
    expect(seek).toHaveBeenLastCalledWith(300_000);
    await waitFor(() => expect(ipcMocks.updateTransition).toHaveBeenCalled());
    releaseTransport(transport);
  });

  it("left edge drives the monitor to the boundary frame itself (in-style)", () => {
    const seek = vi.fn();
    const transport = { play() {}, pause() {}, seek, isPlaying: () => false };
    registerTransport(transport);
    setPlayheadTimeUs(300_000);
    const { container } = renderTimeline({
      tracks: [makeTrack([extendedA, layerB])],
      transitions: [transition],
    });
    fireEvent.pointerDown(zone(container, "left"), { button: 0, clientX: 160 });
    fireEvent.pointerMove(window, { clientX: 120, clientY: 30 }); // L → 1.5M
    expect(seek).toHaveBeenCalledWith(1_500_000);
    fireEvent.pointerUp(window, { clientX: 120, clientY: 30 });
    expect(playheadTimeUs()).toBe(300_000);
    releaseTransport(transport);
  });

  it("blade mode makes the whole chip — zones included — transparent to pointer events", () => {
    const { container } = render(
      <Timeline
        tracks={[makeTrack([extendedA, layerB])]}
        groups={[]}
        transitions={[transition]}
        durationUs={5_000_000}
        keybindings={{}}
        fpsNum={30}
        fpsDen={1}
        bladeMode
        media={[]}
        importing={new Set()}
        proxyState={new Map()}
        previewDecodable={new Set()}
        onExitBlade={vi.fn()}
        onSeek={vi.fn()}
        onMutated={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const chip = chipEl(container);
    expect(chip.className).toContain("pointer-events-none");
  });
});

describe("cut context menu", () => {
  it("right-click near the seam offers Add transition; crossfade dispatches with the frame-snapped 1s default", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    const { getByText } = renderTimeline({ onMutated });
    const blockA = getByText("Clip A").closest(".timeline-layer") as HTMLElement;

    // Seam at 2s = 160px at 80 px/s (canvas rect is 0 in jsdom).
    fireEvent.contextMenu(blockA, { clientX: 160, clientY: 30 });

    const crossfadeItem = await screen.findByText("Add crossfade");
    expect(screen.getByText("Add wipe · Left")).toBeTruthy();
    expect(screen.getByText("Add slide · Down")).toBeTruthy();

    fireEvent.click(crossfadeItem);
    await waitFor(() => {
      expect(ipcMocks.addTransition).toHaveBeenCalledWith({
        fromLayerId: "layer-a",
        toLayerId: "layer-b",
        durationUs: 1_000_000, // 30 whole frames at 30 fps
        kind: "Crossfade",
      });
      expect(onMutated).toHaveBeenCalled();
    });
  });

  it("wipe entries carry their direction", async () => {
    const { getByText } = renderTimeline({});
    const blockA = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
    fireEvent.contextMenu(blockA, { clientX: 160, clientY: 30 });

    fireEvent.click(await screen.findByText("Add wipe · Up"));
    await waitFor(() => {
      expect(ipcMocks.addTransition).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "Wipe", direction: "up" }),
      );
    });
  });

  it("right-click away from the seam shows no Add transition entries", async () => {
    const { getByText } = renderTimeline({});
    const blockA = getByText("Clip A").closest(".timeline-layer") as HTMLElement;

    // 80px = 1s — far outside the 6px tolerance band around the 160px seam.
    fireEvent.contextMenu(blockA, { clientX: 80, clientY: 30 });

    await screen.findByText("Rename"); // menu is open
    expect(screen.queryByText("Add crossfade")).toBeNull();
  });

  it("a seam whose participant is too short for the default duration offers no Add transition entries", async () => {
    // Outgoing clip is 0.5s < the 1s default at 30 fps — the kernel's
    // eligibility (`d ≤ min(len_A, len_B)`) drops the cut, so the menu never
    // dangles an add the mutation would refuse. Prevention first (#18).
    const shortA = colorLayer("layer-a", "Clip A", 0, 500_000);
    const longB = colorLayer("layer-b", "Clip B", 500_000, 4_000_000);
    // Right-click the LONG clip (the 40px-wide short one renders no label to
    // grab): the hit test runs against the whole track, so the seam at its
    // head is reachable from either side.
    const { getByText } = renderTimeline({ tracks: [makeTrack([shortA, longB])] });
    const blockB = getByText("Clip B").closest(".timeline-layer") as HTMLElement;

    // Seam at 0.5s = 40px at 80 px/s.
    fireEvent.contextMenu(blockB, { clientX: 40, clientY: 30 });

    await screen.findByText("Rename"); // menu is open
    expect(screen.queryByText("Add crossfade")).toBeNull();
    expect(ipcMocks.addTransition).not.toHaveBeenCalled();
  });

  it("TransitionInsufficientHandle surfaces available_us through the status log — never a silent clamp", async () => {
    ipcMocks.addTransition.mockRejectedValueOnce(
      new Error(
        '{"error":"TransitionInsufficientHandle","layer":"layer-a","available_us":433333}',
      ),
    );
    const { getByText } = renderTimeline({});
    const blockA = getByText("Clip A").closest(".timeline-layer") as HTMLElement;
    fireEvent.contextMenu(blockA, { clientX: 160, clientY: 30 });

    fireEvent.click(await screen.findByText("Add crossfade"));
    await waitFor(() => {
      expect(ipcMocks.logEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "error",
          // 433_333 µs rendered as seconds by the curated refusal copy
          // (errors/formatCommandError.ts).
          message: expect.stringContaining("0.43s"),
        }),
      );
    });
  });
});

describe("chip context menu", () => {
  // Fixture: `transition` is Wipe·left, 0.5 s, at the 2 s cut (see top of
  // file).
  //
  // Coverage split: submenu CONTENT interactions are not exercised here —
  // Base UI opens a submenu through hover-intent machinery (pointerType
  // detection → the parent popup's `allowMouseEnter` → open delay) that jsdom
  // cannot drive. The pick semantics live as pure functions in transitions.ts
  // (`transitionKindUpdateArgs` & co.), unit-tested in transitions.test.ts;
  // this suite pins what the menu SHOWS and the flat-item paths.
  function openChipMenu(container: HTMLElement) {
    const chip = container.querySelector(
      '[data-testid="transition-chip"]',
    ) as HTMLElement;
    fireEvent.contextMenu(chip, { clientX: 170, clientY: 30 });
  }

  it("right-click opens the chip menu (not the layer menu) with all four entries", async () => {
    const { container } = renderTimeline({
      tracks: [makeTrack([extendedA, layerB])],
      transitions: [transition],
    });
    openChipMenu(container);

    await screen.findByTestId("transition-chip-menu");
    expect(useSelectionStore.getState().selectedTransitionId).toBe("tr-1");
    // Swallowed before the layer surface underneath saw it.
    expect(screen.queryByText("Rename")).toBeNull();
    expect(screen.getByText("Kind")).toBeTruthy();
    expect(screen.getByText("Direction")).toBeTruthy();
    expect(screen.getByText("Duration")).toBeTruthy();
    expect(screen.getByText("Delete transition")).toBeTruthy();
  });

  it("hides the Direction submenu entirely for a Crossfade transition", async () => {
    const crossfadeTr: TransitionSummary = {
      ...transition,
      kind: { kind: "Crossfade" },
    };
    const { container } = renderTimeline({
      tracks: [makeTrack([extendedA, layerB])],
      transitions: [crossfadeTr],
    });
    openChipMenu(container);

    await screen.findByTestId("transition-chip-menu");
    expect(screen.getByText("Kind")).toBeTruthy();
    expect(screen.queryByText("Direction")).toBeNull();
  });

  it("Delete transition removes and clears the chip selection", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    const { container } = renderTimeline({
      tracks: [makeTrack([extendedA, layerB])],
      transitions: [transition],
      onMutated,
    });
    openChipMenu(container);

    fireEvent.click(await screen.findByText("Delete transition"));
    await waitFor(() => {
      expect(ipcMocks.removeTransition).toHaveBeenCalledWith("tr-1");
      expect(onMutated).toHaveBeenCalled();
    });
    expect(useSelectionStore.getState().selectedTransitionId).toBeNull();
  });

  it("the menu closes when the timeline scrolls under it", async () => {
    const { container } = renderTimeline({
      tracks: [makeTrack([extendedA, layerB])],
      transitions: [transition],
    });
    openChipMenu(container);
    await screen.findByTestId("transition-chip-menu");

    fireEvent.scroll(window);
    await waitFor(() => {
      expect(screen.queryByTestId("transition-chip-menu")).toBeNull();
    });
    // Closing must not have committed anything.
    expect(ipcMocks.updateTransition).not.toHaveBeenCalled();
    expect(ipcMocks.removeTransition).not.toHaveBeenCalled();
  });
});

