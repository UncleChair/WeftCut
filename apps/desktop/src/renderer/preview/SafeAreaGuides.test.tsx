// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import type { ProjectSummary } from "../ipc";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { useProjectStore } from "../state/projectStore";
import { clearLayerSelection } from "../state/selectionStore";
import { clearGizmoProbe, registerGizmoProbe, type GizmoProbe } from "./gizmoProbeRegistry";
import {
  ACTION_SAFE_FRACTION,
  safeAreaRect,
  SafeAreaGuidesHost,
  TITLE_SAFE_FRACTION,
} from "./SafeAreaGuides";

/// A 1280×720 composition with NO layers: the guides are a property of the
/// frame, so an empty project is a legitimate state for them.
function fixture(): ProjectSummary {
  return {
    project_id: "p1",
    name: "fixture",
    composition: {
      width: 1280,
      height: 720,
      fps_num: 30,
      fps_den: 1,
      duration_pinned: false,
      fps_locked: false,
    },
    track_count: 0,
    layer_count: 0,
    duration_us: 0,
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [],
    tracks: [],
    groups: [],
    markers: [],
    transitions: [],
    audio_roles: [],
  } as unknown as ProjectSummary;
}

/// Canvas box is HALF the composition and sits at the panel origin, so every
/// composition pixel is half a client pixel — the mapping the assertions turn on.
const probe: GizmoProbe = {
  canvasRect: () =>
    ({ left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360 }) as DOMRect,
  naturalSizeOf: () => null,
};

function setVisible(on: boolean): void {
  useAppSettingsStore.setState((s) => ({
    settings: { ...s.settings, safe_area_guides_visible: on },
  }));
}

/// The band's geometry, off the bright rect (its under-stroke twin carries the
/// same numbers).
async function band(testId: string): Promise<{ x: number; y: number; w: number; h: number }> {
  const g = await screen.findByTestId(testId);
  const rect = g.children[1]!;
  await waitFor(() => expect(g.getAttribute("style")).not.toContain("display: none"));
  return {
    x: Number(rect.getAttribute("x")),
    y: Number(rect.getAttribute("y")),
    w: Number(rect.getAttribute("width")),
    h: Number(rect.getAttribute("height")),
  };
}

beforeEach(() => {
  registerGizmoProbe(probe);
  useProjectStore.getState().apply(fixture());
  setVisible(true);
});

afterEach(() => {
  cleanup();
  clearGizmoProbe(probe);
  clearLayerSelection();
  useProjectStore.getState().apply(null);
  setVisible(false);
});

describe("safeAreaRect", () => {
  it("keeps the fraction, centred, with a symmetric margin", () => {
    expect(safeAreaRect(TITLE_SAFE_FRACTION, 1280, 720)).toEqual({
      x: 64,
      y: 36,
      w: 1152,
      h: 648,
    });
    // Title-safe is the INNER rectangle: the tighter fraction, so it must sit
    // inside action-safe on every edge.
    const title = safeAreaRect(TITLE_SAFE_FRACTION, 1280, 720);
    const action = safeAreaRect(ACTION_SAFE_FRACTION, 1280, 720);
    expect(title.x).toBeGreaterThan(action.x);
    expect(title.x + title.w).toBeLessThan(action.x + action.w);
  });

  // The margin the caption importer applies (8% per side ⇒ a 0.84 box) has to
  // land inside the drawn title-safe rectangle, or one of the two constants is
  // wrong. Asserted on the constants, since the caption box is not built yet.
  it("leaves the caption importer's 8% box inside title-safe", () => {
    expect(0.84).toBeLessThan(TITLE_SAFE_FRACTION);
  });
});

describe("SafeAreaGuidesHost", () => {
  it("draws both bands in client pixels, mapped through the canvas contain box", async () => {
    render(<SafeAreaGuidesHost />);
    // 1280×720 × 0.9 = 1152×648 at (64, 36), halved by the canvas box.
    expect(await band("safe-area-guide-title")).toEqual({ x: 32, y: 18, w: 576, h: 324 });
    // × 0.93 = 1190.4×669.6 at (44.8, 25.2), halved. Approximate because 0.93
    // is not a binary fraction — the margin arrives with a float tail.
    const action = await band("safe-area-guide-action");
    expect(action.x).toBeCloseTo(22.4);
    expect(action.y).toBeCloseTo(12.6);
    expect(action.w).toBeCloseTo(595.2);
    expect(action.h).toBeCloseTo(334.8);
  });

  it("stays up with nothing selected — a safe area is not a selection's chrome", async () => {
    clearLayerSelection();
    render(<SafeAreaGuidesHost />);
    expect(await band("safe-area-guide-title")).toMatchObject({ x: 32, y: 18 });
  });

  it("renders nothing while the preference is off", () => {
    setVisible(false);
    render(<SafeAreaGuidesHost />);
    expect(screen.queryByTestId("safe-area-guides")).toBeNull();
  });

  it("renders nothing before a composition exists", () => {
    useProjectStore.getState().apply(null);
    render(<SafeAreaGuidesHost />);
    expect(screen.queryByTestId("safe-area-guides")).toBeNull();
  });

  it("hides the bands while no probe reports a canvas", async () => {
    clearGizmoProbe(probe);
    render(<SafeAreaGuidesHost />);
    const g = await screen.findByTestId("safe-area-guide-title");
    await waitFor(() => expect(g.style.display).toBe("none"));
  });
});
