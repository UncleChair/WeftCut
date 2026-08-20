// @vitest-environment jsdom
// The Transitions panel: card inventory, the no-target disabled state, and
// that a card click dispatches the SAME apply kernel as the palette command —
// exact (kind, direction) wire args, frame-snapped default duration, and the
// select-the-result feedback. Target-resolution math is unit-tested in
// transitions.test.ts; this covers the wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "../i18n"; // initialize i18next so t(key) resolves in chrome
import type { LayerSummary, ProjectSummary, TrackSummary } from "../ipc";
import { useProjectStore } from "../state/projectStore";
import { useSelectionStore } from "../state/selectionStore";
import { setPlayheadTimeUs } from "../state/playheadStore";
import { TransitionsPanel } from "./TransitionsPanel";

const ipcMocks = vi.hoisted(() => ({
  addTransition: vi.fn().mockResolvedValue("new-transition"),
  logEmit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return {
    ...actual,
    addTransition: ipcMocks.addTransition,
    logEmit: ipcMocks.logEmit,
  };
});

function colorLayer(id: string, tStartUs: number, tEndUs: number): LayerSummary {
  return {
    id,
    label: id,
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

function makeTrack(id: string, layers: LayerSummary[]): TrackSummary {
  return {
    id,
    kind: "Video",
    label: id,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers,
  };
}

function seed(tracks: TrackSummary[]): void {
  const summary: ProjectSummary = {
    project_id: "p",
    name: "p",
    composition: {
      width: 640, height: 360, fps_num: 30, fps_den: 1,
      duration_pinned: false, fps_locked: false,
    },
    track_count: tracks.length,
    layer_count: tracks.reduce((n, t) => n + t.layers.length, 0),
    duration_us: 0,
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [], tracks, markers: [], transitions: [], groups: [], audio_roles: [],
  };
  useProjectStore.getState().apply(summary);
}

// Adjacent hard cut at 2s.
const seedWithCut = () =>
  seed([
    makeTrack("t1", [colorLayer("layer-a", 0, 2_000_000), colorLayer("layer-b", 2_000_000, 4_000_000)]),
  ]);

beforeEach(() => {
  ipcMocks.addTransition.mockClear();
  setPlayheadTimeUs(0);
});
afterEach(() => {
  cleanup();
  useProjectStore.getState().apply(null);
});

describe("TransitionsPanel", () => {
  it("renders all nine kind × direction cards", () => {
    seedWithCut();
    render(<TransitionsPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByTestId("transition-card-crossfade")).toBeTruthy();
    for (const kind of ["wipe", "slide"]) {
      for (const direction of ["left", "right", "up", "down"]) {
        expect(screen.getByTestId(`transition-card-${kind}-${direction}`)).toBeTruthy();
      }
    }
  });

  it("disables every card and explains the precondition when no cut exists", () => {
    seed([makeTrack("t1", [colorLayer("lone", 0, 2_000_000)])]);
    render(<TransitionsPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);
    const card = screen.getByTestId("transition-card-crossfade") as HTMLButtonElement;
    expect(card.disabled).toBe(true);
    // The empty-state teaching line names the precondition for newcomers —
    // the panel's whole audience.
    expect(screen.getByText("Place two visual clips back-to-back on a track, then pick a style below.")).toBeTruthy();
    expect(ipcMocks.addTransition).not.toHaveBeenCalled();
  });

  it("a directional card applies that exact kind+direction at the resolved cut, frame-snapped 1 s", async () => {
    seedWithCut();
    const onMutated = vi.fn().mockResolvedValue(undefined);
    render(<TransitionsPanel onMutated={onMutated} />);
    fireEvent.click(screen.getByTestId("transition-card-wipe-left"));
    await waitFor(() => expect(ipcMocks.addTransition).toHaveBeenCalledTimes(1));
    expect(ipcMocks.addTransition).toHaveBeenCalledWith({
      fromLayerId: "layer-a",
      toLayerId: "layer-b",
      durationUs: 1_000_000, // 30 whole frames @ 30fps
      kind: "Wipe",
      direction: "left",
    });
    await waitFor(() => expect(onMutated).toHaveBeenCalledTimes(1));
    // Selecting the result is the panel's only success feedback (no toasts):
    // the chip highlights and the inspector flips to the transition.
    expect(useSelectionStore.getState().selectedTransitionId).toBe("new-transition");
  });

  it("the crossfade card omits direction from the wire args", async () => {
    seedWithCut();
    render(<TransitionsPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByTestId("transition-card-crossfade"));
    await waitFor(() => expect(ipcMocks.addTransition).toHaveBeenCalledTimes(1));
    expect(ipcMocks.addTransition).toHaveBeenCalledWith({
      fromLayerId: "layer-a",
      toLayerId: "layer-b",
      durationUs: 1_000_000,
      kind: "Crossfade",
    });
  });
});
