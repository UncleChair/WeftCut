// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { AnimTrack, LayerParamsView, ProjectSummary } from "../ipc";
import { useProjectStore } from "../state/projectStore";
import { setPlayheadTimeUs } from "../state/playheadStore";
import { clearLayerSelection, setLayerSelection } from "../state/selectionStore";
import {
  resetTransformOverrides,
  transformOverrideFor,
} from "../render/transformOverrides";
import { clearGizmoProbe, registerGizmoProbe, type GizmoProbe } from "./gizmoProbeRegistry";
import { TransformGizmoHost } from "./TransformGizmo";

// jsdom does not implement PointerEvent; alias it to MouseEvent so
// fireEvent.pointerDown carries a usable .button / .clientX (same shim
// Timeline.interaction.test.tsx uses).
if (typeof window !== "undefined" && !window.PointerEvent) {
  (window as unknown as Record<string, unknown>).PointerEvent = window.MouseEvent;
}

const commit = vi.fn(async () => {});
vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return { ...actual, updateLayerParamTracks: (...args: unknown[]) => commit(...(args as [])) };
});

const stat = (value: number): AnimTrack<number> => ({ mode: "Static", value });

/// 1280×720 30 fps comp; one clip on [2 s, 4 s) whose media is 640×360.
function fixture(params?: Partial<Record<string, unknown>>, kind = "VideoClip"): ProjectSummary {
  const base = {
    kind,
    media_id: "m1",
    media_label: "a.mp4",
    src_in_us: 0,
    src_out_us: 2_000_000,
    x: stat(0),
    y: stat(0),
    scale_x: stat(1),
    scale_y: stat(1),
    scale_linked: true,
    rotation_deg: stat(0),
    anchor_x: 0.5,
    anchor_y: 0.5,
    opacity: stat(1),
    speed: 1,
    flip_h: false,
    flip_v: false,
    fade_in_us: 0,
    fade_out_us: 0,
    ...params,
  };
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
    track_count: 1,
    layer_count: 1,
    duration_us: 10_000_000,
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [],
    tracks: [
      {
        id: "t1",
        kind: "Video",
        label: "A-Roll",
        enabled: true,
        locked: false,
        muted: false,
        solo: false,
        role: "a-roll",
        transient: false,
        layers: [
          {
            id: "l1",
            label: null,
            t_start_us: 2_000_000,
            t_end_us: 4_000_000,
            kind,
            color_hint: "",
            enabled: true,
            locked: false,
            effects: [],
            params: base as unknown as LayerParamsView,
          },
        ],
      },
    ],
    groups: [],
    markers: [],
    transitions: [],
    audio_roles: [],
  } as unknown as ProjectSummary;
}

/// Canvas box is HALF the composition, so every client delta doubles in
/// composition pixels — the conversion the commit assertions turn on.
const probe: GizmoProbe = {
  canvasRect: () =>
    ({ left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360 }) as DOMRect,
  naturalSizeOf: () => ({ w: 640, h: 360 }),
};

beforeEach(() => {
  commit.mockClear();
  registerGizmoProbe(probe);
  useProjectStore.getState().apply(fixture());
  setLayerSelection("l1", ["l1"]);
  setPlayheadTimeUs(2_500_000);
});

afterEach(() => {
  cleanup();
  clearGizmoProbe(probe);
  clearLayerSelection();
  resetTransformOverrides();
  useProjectStore.getState().apply(null);
});

async function box(): Promise<HTMLElement> {
  const el = await screen.findByTestId("transform-gizmo-box");
  await waitFor(() => expect(el.getAttribute("points")).not.toBe(""));
  return el;
}

describe("TransformGizmoHost", () => {
  it("draws the layer footprint in client pixels", async () => {
    render(<TransformGizmoHost />);
    const el = await box();
    // 640×360 media at scale 1 in a half-scale canvas ⇒ a 320×180 box at (0,0).
    expect(el.getAttribute("points")).toBe("0,0 320,0 320,180 0,180");
  });

  it("renders nothing for a kind without a transform", () => {
    useProjectStore.getState().apply(fixture({}, "Color"));
    render(<TransformGizmoHost />);
    expect(screen.queryByTestId("transform-gizmo-box")).toBeNull();
  });

  it("renders nothing with no selection", () => {
    clearLayerSelection();
    render(<TransformGizmoHost />);
    expect(screen.queryByTestId("transform-gizmo-box")).toBeNull();
  });

  it("hides the box when the playhead is off the layer", async () => {
    setPlayheadTimeUs(9_000_000);
    render(<TransformGizmoHost />);
    const el = await screen.findByTestId("transform-gizmo-box");
    await waitFor(() => expect(el.style.display).toBe("none"));
  });

  it("previews a drag through the transient override, without committing", async () => {
    render(<TransformGizmoHost />);
    const el = await box();
    fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(el, { clientX: 120, clientY: 110 });
    expect(transformOverrideFor("l1")).toEqual({ dx: 40, dy: 20 });
    expect(commit).not.toHaveBeenCalled();
  });

  it("commits x and y in ONE batch on release", async () => {
    render(<TransformGizmoHost />);
    const el = await box();
    fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(el, { clientX: 120, clientY: 110 });
    fireEvent.pointerUp(el, { clientX: 120, clientY: 110 });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith("l1", [
      ["x", { mode: "Static", value: 40 }],
      ["y", { mode: "Static", value: 20 }],
    ]);
  });

  it("keys a keyframed track at the frame-snapped playhead instead of flattening it", async () => {
    useProjectStore.getState().apply(
      fixture({
        x: {
          mode: "Keyframed",
          value: [{ id: "k1", t_us: 0, value: 10, interp: { kind: "Linear" } }],
        } as AnimTrack<number>,
      }),
    );
    render(<TransformGizmoHost />);
    const el = await box();
    fireEvent.pointerDown(el, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { clientX: 5, clientY: 0 });
    fireEvent.pointerUp(el, { clientX: 5, clientY: 0 });
    const [, entries] = commit.mock.calls[0] as unknown as [string, [string, AnimTrack<number>][]];
    const x = entries[0]![1];
    expect(x.mode).toBe("Keyframed");
    // Playhead 2.5 s − layer start 2 s = 0.5 s = frame 15 at 30 fps.
    const keys = x.value as Array<{ t_us: number; value: number }>;
    expect(keys.find((k) => k.t_us === 500_000)?.value).toBe(20);
    // y was Static and stays Static — one gesture, two independent tracks.
    expect(entries[1]![1]).toEqual({ mode: "Static", value: 0 });
  });

  it("cancels on Escape: override dropped, nothing committed", async () => {
    render(<TransformGizmoHost />);
    const el = await box();
    fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(el, { clientX: 200, clientY: 100 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(transformOverrideFor("l1")).toBeUndefined();
    fireEvent.pointerUp(el, { clientX: 200, clientY: 100 });
    expect(commit).not.toHaveBeenCalled();
  });

  it("ignores a click that never moved", async () => {
    render(<TransformGizmoHost />);
    const el = await box();
    fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(el, { clientX: 100, clientY: 100 });
    expect(commit).not.toHaveBeenCalled();
    expect(transformOverrideFor("l1")).toBeUndefined();
  });
});
