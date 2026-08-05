// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { AnimTrack, LayerParamsView, ProjectSummary } from "../ipc";
import { useProjectStore } from "../state/projectStore";
import { setPlayheadTimeUs } from "../state/playheadStore";
import { clearLayerSelection, setLayerSelection } from "../state/selectionStore";
import {
  resetTransformOverrides,
  transformOverrideFor,
} from "../render/transformOverrides";
import { clearGizmoProbe, registerGizmoProbe, type GizmoProbe } from "./gizmoProbeRegistry";
import { useAppSettingsStore } from "../settings/appSettingsStore";
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
    anchor_x: { mode: "Static", value: 0.5 },
    anchor_y: { mode: "Static", value: 0.5 },
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
/// composition pixels — the conversion the commit assertions turn on. It also
/// DOUBLES the snap radius: 12 screen px is 24 composition px here, which is why
/// snapping has to be off for the gesture-semantics tests below (see setSnap).
const probe: GizmoProbe = {
  canvasRect: () =>
    ({ left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360 }) as DOMRect,
  naturalSizeOf: () => ({ w: 640, h: 360 }),
};

/// This fixture's layer fills half the composition, so almost any tidy drag
/// distance lands one of its edges inside the default snap radius — the move
/// tests below assert exact deltas and would be measuring the snap instead of
/// the gesture. Same reason `Timeline.interaction.test.tsx` turns
/// `tail_snap_enabled` off for its drag assertions.
function setSnap(enabled: boolean, strengthPx = 12): void {
  useAppSettingsStore.setState((s) => ({
    settings: { ...s.settings, preview_snap_enabled: enabled, preview_snap_strength_px: strengthPx },
  }));
}

beforeEach(() => {
  commit.mockClear();
  registerGizmoProbe(probe);
  useProjectStore.getState().apply(fixture());
  setLayerSelection("l1", ["l1"]);
  setPlayheadTimeUs(2_500_000);
  setSnap(false);
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

/// The fixture plus a second staged VideoClip at x = 700, so the solver has a
/// LAYER target to find alongside the composition's own lines.
function twoLayerFixture(): ProjectSummary {
  const s = fixture() as unknown as {
    tracks: { layers: Array<Record<string, unknown>> }[];
  };
  const first = s.tracks[0]!.layers[0]!;
  s.tracks[0]!.layers.push({
    ...first,
    id: "l2",
    params: { ...(first.params as Record<string, unknown>), x: stat(700) },
  });
  return s as unknown as ProjectSummary;
}

function guide(axis: "x" | "y"): HTMLElement {
  return screen.getByTestId(`transform-gizmo-guide-${axis}`);
}

/// The bright line, not the dark backing — index 1 of the group.
function guideLine(axis: "x" | "y"): Element {
  return guide(axis).children[1]!;
}

// The fixture makes the arithmetic here checkable by hand: the canvas is half
// the composition, so a client delta DOUBLES into composition pixels and the
// 12 screen-px radius is 24 composition px. The layer is 640×360 at (0, 0) in a
// 1280×720 composition, so its box already sits on x=0, x=640, y=0 and y=360 —
// four of the six composition lines — before anything moves.
describe("snapping", () => {
  it("pulls the box's centre onto the composition's centre line", async () => {
    setSnap(true);
    render(<TransformGizmoHost />);
    const el = await box();
    // +310 comp px puts centreX at 630, ten short of 640. Both edges stay clear
    // of every other line, so exactly one candidate is in range.
    fireEvent.pointerDown(el, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { clientX: 155, clientY: 0 });
    expect(transformOverrideFor("l1")).toEqual({ dx: 320, dy: 0 });
    fireEvent.pointerUp(el, { clientX: 155, clientY: 0 });
    expect(commit).toHaveBeenCalledWith("l1", [
      ["x", { mode: "Static", value: 320 }],
      ["y", { mode: "Static", value: 0 }],
    ]);
  });

  it("draws one guide per axis, on the line it snapped to", async () => {
    setSnap(true);
    render(<TransformGizmoHost />);
    const el = await box();
    fireEvent.pointerDown(el, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { clientX: 155, clientY: 0 });
    // x=640 and y=0 in composition space, halved into client space by the fit.
    await waitFor(() => expect(guide("x").style.display).not.toBe("none"));
    expect(guideLine("x").getAttribute("x1")).toBe("320");
    expect(guideLine("x").getAttribute("y1")).toBe("0");
    expect(guideLine("x").getAttribute("x2")).toBe("320");
    expect(guideLine("x").getAttribute("y2")).toBe("360");
    // The top edge never left y=0, so that axis is snapped too — a horizontal
    // guide spanning the composition's width.
    expect(guide("y").style.display).not.toBe("none");
    expect(guideLine("y").getAttribute("y1")).toBe("0");
    expect(guideLine("y").getAttribute("x2")).toBe("640");
  });

  it("drops the guides when the gesture ends", async () => {
    setSnap(true);
    render(<TransformGizmoHost />);
    const el = await box();
    fireEvent.pointerDown(el, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { clientX: 155, clientY: 0 });
    await waitFor(() => expect(guide("x").style.display).not.toBe("none"));
    fireEvent.pointerUp(el, { clientX: 155, clientY: 0 });
    await waitFor(() => expect(guide("x").style.display).toBe("none"));
    expect(guide("y").style.display).toBe("none");
  });

  it("suppresses the snap while Ctrl is held, and re-arms when it is let go", async () => {
    setSnap(true);
    render(<TransformGizmoHost />);
    const el = await box();
    fireEvent.pointerDown(el, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { clientX: 155, clientY: 0, ctrlKey: true });
    // The raw 310, not the snapped 320.
    expect(transformOverrideFor("l1")).toEqual({ dx: 310, dy: 0 });
    await waitFor(() => expect(guide("x").style.display).toBe("none"));
    // Ctrl is read per move, so there is no gesture state to reset.
    fireEvent.pointerMove(el, { clientX: 155, clientY: 0 });
    expect(transformOverrideFor("l1")).toEqual({ dx: 320, dy: 0 });
  });

  it("does not snap at all when the preference is off", async () => {
    setSnap(false);
    render(<TransformGizmoHost />);
    const el = await box();
    fireEvent.pointerDown(el, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { clientX: 155, clientY: 0 });
    expect(transformOverrideFor("l1")).toEqual({ dx: 310, dy: 0 });
    expect(guide("x").style.display).toBe("none");
  });

  it("snaps to another layer's edge, and the guide names that line", async () => {
    setSnap(true);
    useProjectStore.getState().apply(twoLayerFixture());
    render(<TransformGizmoHost />);
    const el = await box();
    // +50 puts the right edge at 690, ten short of l2's left edge at 700 —
    // nearer than any composition line, so the layer target wins outright.
    fireEvent.pointerDown(el, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { clientX: 25, clientY: 0 });
    expect(transformOverrideFor("l1")).toEqual({ dx: 60, dy: 0 });
    await waitFor(() => expect(guide("x").style.display).not.toBe("none"));
    // x=700 composition ⇒ 350 client.
    expect(guideLine("x").getAttribute("x1")).toBe("350");
  });

  it("lands a linked corner resize exactly on the frame, pivot still pinned", async () => {
    setSnap(true);
    render(<TransformGizmoHost />);
    await box();
    const handle = screen.getByTestId("transform-gizmo-scale-br");
    // The `br` handle starts at (640, 360). A drag to (1260, 710) fits t ≈ 2.939,
    // which is 22.3 composition px of handle travel short of t = 3 — inside the
    // 24 px radius, so the ray solve takes it to exactly 3.
    fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(handle, { clientX: 310, clientY: 175 });
    fireEvent.pointerUp(handle, { clientX: 310, clientY: 175 });
    const [, entries] = commit.mock.calls[0] as unknown as [string, [string, AnimTrack<number>][]];
    const byKey = new Map(entries);
    // Linked, so ONE authored track fanned out to both axes (spec D6).
    expect(byKey.get("scale_x")).toEqual({ mode: "Static", value: 3 });
    expect(byKey.get("scale_y")).toEqual({ mode: "Static", value: 3 });
    // Scaling 1 → 3 about a centred anchor walks the position by −anchor·size·2.
    expect(byKey.get("x")).toEqual({ mode: "Static", value: -640 });
    expect(byKey.get("y")).toEqual({ mode: "Static", value: -360 });
    // Which is to say: the layer now fills the composition exactly. Its bottom
    // -right corner is at (-640 + 3·640, -360 + 3·360) = (1280, 720), and the
    // pivot has not moved — that is what makes the guide truthful (D23).
  });

  it("leaves a linked resize alone under Ctrl", async () => {
    setSnap(true);
    render(<TransformGizmoHost />);
    await box();
    const handle = screen.getByTestId("transform-gizmo-scale-br");
    fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(handle, { clientX: 310, clientY: 175, ctrlKey: true });
    fireEvent.pointerUp(handle, { clientX: 310, clientY: 175, ctrlKey: true });
    const [, entries] = commit.mock.calls[0] as unknown as [string, [string, AnimTrack<number>][]];
    const scaleX = new Map(entries).get("scale_x") as { value: number };
    // The un-snapped least-squares fit, not the round 3.
    expect(scaleX.value).toBeGreaterThan(2.9);
    expect(scaleX.value).toBeLessThan(3);
  });
});

/// The fixture's pivot: a 640×360 layer at (0,0) with a centered anchor is
/// centered on comp (320,180), which the half-scale canvas puts at (160,90).
const PIVOT = { x: 160, y: 90 };
/// The knob, ROTATE_GAP_PX above the box's top edge midpoint (160, 0).
const KNOB = { clientX: 160, clientY: -26 };

/// A client point at `deg` around the pivot — angles are measured clockwise
/// because screen y grows downward.
function at(deg: number, r = 100): { clientX: number; clientY: number } {
  const rad = (deg * Math.PI) / 180;
  return { clientX: PIVOT.x + Math.cos(rad) * r, clientY: PIVOT.y + Math.sin(rad) * r };
}

/// The client point a draw-loop-placed group carries in its `translate(x y)`.
function placedAt(el: HTMLElement): { clientX: number; clientY: number } {
  const [x, y] = el
    .getAttribute("transform")!
    .replace(/[^\d.\-\s]/g, "")
    .trim()
    .split(/\s+/)
    .map(Number);
  return { clientX: x!, clientY: y! };
}

async function knob(): Promise<HTMLElement> {
  const el = await screen.findByTestId("transform-gizmo-rotate");
  await waitFor(() => expect(el.getAttribute("transform")).not.toBeNull());
  return el;
}

function corners(el: HTMLElement): Array<{ x: number; y: number }> {
  return el
    .getAttribute("points")!
    .split(" ")
    .map((p) => {
      const [x, y] = p.split(",").map(Number);
      return { x: x!, y: y! };
    });
}

describe("TransformGizmo rotation handle", () => {
  it("hangs the knob off the top edge on a stalk, in screen pixels", async () => {
    render(<TransformGizmoHost />);
    await box();
    const el = await knob();
    // One translate on the group; the disc and its rotate glyph are drawn about
    // (0,0) and never turned with the box — the glyph is a label.
    expect(el.getAttribute("transform")).toBe("translate(160 -26)");
    const stalk = screen.getByTestId("transform-gizmo-stalk");
    // Root on the box's top edge, knob end coincident with the circle.
    expect(["x1", "y1", "x2", "y2"].map((a) => stalk.getAttribute(a))).toEqual([
      "160",
      "0",
      "160",
      "-26",
    ]);
  });

  it("labels the knob with an upright rotate glyph that does not steal the grab", async () => {
    render(<TransformGizmoHost />);
    await box();
    const el = await knob();
    const glyph = el.querySelector("svg.lucide-rotate-ccw");
    expect(glyph).not.toBeNull();
    // Centred on the knob by its own viewport, so placing the whole affordance
    // stays ONE translate per frame — and that translate carries no rotation,
    // which is what keeps the label readable on an upside-down box.
    expect([glyph!.getAttribute("x"), glyph!.getAttribute("y")]).toEqual(["-5.5", "-5.5"]);
    expect(el.getAttribute("transform")).not.toContain("rotate");
    // The glyph sits on top of the disc; hit-testing it would swallow the
    // pointerdown that starts the gesture.
    expect((glyph as SVGElement).style.pointerEvents).toBe("none");
  });

  it("hides the stalk and knob with the box when the playhead leaves the layer", async () => {
    setPlayheadTimeUs(9_000_000);
    render(<TransformGizmoHost />);
    // Not via `knob()`: off-span the loop hides before it ever places the knob,
    // so there is no `cx` to wait for.
    const el = await screen.findByTestId("transform-gizmo-rotate");
    await waitFor(() => expect(el.style.display).toBe("none"));
    expect(screen.getByTestId("transform-gizmo-stalk").style.display).toBe("none");
  });

  it("rotates about the anchor through the transient override, without committing", async () => {
    render(<TransformGizmoHost />);
    const el = await box();
    const rot = await knob();
    // Knob starts at −90° (straight up); dragging to 0° is a quarter turn
    // clockwise.
    fireEvent.pointerDown(rot, { button: 0, ...KNOB });
    fireEvent.pointerMove(rot, at(0));
    expect(transformOverrideFor("l1")).toEqual({ dx: 0, dy: 0, drotDeg: 90 });
    expect(commit).not.toHaveBeenCalled();
    // The box follows the gesture: the 320×180 footprint becomes 180×320 and
    // stays centered on the pivot — i.e. it turned IN PLACE. This is the
    // assertion that would fail if the box ignored the rotation override.
    await waitFor(() => {
      const pts = corners(el);
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(180, 6);
      expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(320, 6);
      expect(pts.reduce((s, p) => s + p.x, 0) / 4).toBeCloseTo(PIVOT.x, 6);
      expect(pts.reduce((s, p) => s + p.y, 0) / 4).toBeCloseTo(PIVOT.y, 6);
    });
  });

  it("commits rotation_deg ALONE in one batch on release", async () => {
    render(<TransformGizmoHost />);
    await box();
    const rot = await knob();
    fireEvent.pointerDown(rot, { button: 0, ...KNOB });
    fireEvent.pointerMove(rot, at(0));
    fireEvent.pointerUp(rot, at(0));
    // No x/y in the batch: the engine already rotates about the anchor, so
    // nothing has to compensate.
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith("l1", [
      ["rotation_deg", { mode: "Static", value: 90 }],
    ]);
  });

  it("keys a keyframed rotation at the frame-snapped playhead", async () => {
    useProjectStore.getState().apply(
      fixture({
        rotation_deg: {
          mode: "Keyframed",
          value: [{ id: "k1", t_us: 0, value: 30, interp: { kind: "Linear" } }],
        } as AnimTrack<number>,
      }),
    );
    render(<TransformGizmoHost />);
    await box();
    const rot = await knob();
    // The box is already rotated 30°, so its knob is not where it is at 0° —
    // grab the drawn position instead of assuming it.
    fireEvent.pointerDown(rot, { button: 0, ...placedAt(rot) });
    fireEvent.pointerMove(rot, at(0));
    fireEvent.pointerUp(rot, at(0));
    const [, entries] = commit.mock.calls[0] as unknown as [string, [string, AnimTrack<number>][]];
    const track = entries[0]![1];
    expect(entries).toHaveLength(1);
    expect(track.mode).toBe("Keyframed");
    // Grabbing at 30° and dragging to 0° (screen) is +60°, on top of the 30°
    // the track already resolves to. Key lands at frame 15 of 30 fps. Tolerance
    // is a fraction of a degree because a pointer's client coords are integers
    // while the knob's drawn centre is not.
    const keys = track.value as Array<{ t_us: number; value: number }>;
    expect(keys.find((k) => k.t_us === 500_000)?.value).toBeCloseTo(90, 0);
  });

  it("quantizes only the APPLIED angle while Shift is held", async () => {
    render(<TransformGizmoHost />);
    await box();
    const rot = await knob();
    fireEvent.pointerDown(rot, { button: 0, ...KNOB });
    // −90° → −14.5° is +75.5° of cursor travel; Shift snaps the result to 75.
    fireEvent.pointerMove(rot, { clientX: 276, clientY: 60, shiftKey: true });
    expect(transformOverrideFor("l1")!.drotDeg).toBe(75);
    // Same cursor position with Shift released: the true angle comes back, so
    // the layer is not stuck on the grid for the rest of the gesture.
    fireEvent.pointerMove(rot, { clientX: 276, clientY: 60 });
    expect(transformOverrideFor("l1")!.drotDeg).toBeCloseTo(75.5, 1);
  });

  it("cancels on Escape and ignores a knob click that never moved", async () => {
    render(<TransformGizmoHost />);
    await box();
    const rot = await knob();
    fireEvent.pointerDown(rot, { button: 0, ...KNOB });
    fireEvent.pointerMove(rot, at(0));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(transformOverrideFor("l1")).toBeUndefined();
    fireEvent.pointerUp(rot, at(0));
    expect(commit).not.toHaveBeenCalled();

    fireEvent.pointerDown(rot, { button: 0, ...KNOB });
    fireEvent.pointerUp(rot, KNOB);
    expect(commit).not.toHaveBeenCalled();
    expect(transformOverrideFor("l1")).toBeUndefined();
  });
});

/// Entries of the single commit batch, as `[key, value]` for Static tracks.
function committedStatics(): Array<[string, number]> {
  return batchStatics(0);
}

/// The nth commit batch, as a `key → value` map of its Static tracks.
function batchStatics(n: number): Array<[string, number]> {
  const [, entries] = commit.mock.calls[n] as unknown as [string, [string, AnimTrack<number>][]];
  return entries.map(([k, t]) => [k, (t as { mode: "Static"; value: number }).value]);
}

function committedValue(n: number, key: string): number {
  return new Map(batchStatics(n)).get(key)!;
}

async function reticle(): Promise<HTMLElement> {
  const el = await screen.findByTestId("transform-gizmo-anchor-grab");
  await waitFor(() =>
    expect(screen.getByTestId("transform-gizmo-anchor").getAttribute("transform")).not.toBeNull(),
  );
  return el;
}

describe("TransformGizmo anchor target", () => {
  it("sits on the pivot, and hides with the box off-span", async () => {
    render(<TransformGizmoHost />);
    await box();
    await reticle();
    // One translate on the group; the ring and crosshair are drawn about (0,0).
    expect(screen.getByTestId("transform-gizmo-anchor").getAttribute("transform")).toBe(
      `translate(${PIVOT.x} ${PIVOT.y})`,
    );
  });

  it("follows a keyed-off-centre anchor rather than the box centre", async () => {
    useProjectStore.getState().apply(
      fixture({ anchor_x: stat(0), anchor_y: stat(1) }),
    );
    render(<TransformGizmoHost />);
    await box();
    await reticle();
    // anchor (0,1) on a 640×360 layer at (0,0) ⇒ comp (0,360) ⇒ client (0,180).
    expect(screen.getByTestId("transform-gizmo-anchor").getAttribute("transform")).toBe(
      "translate(0 180)",
    );
  });

  it("previews the drag in normalized units, with no compensation to make", async () => {
    render(<TransformGizmoHost />);
    await box();
    const el = await reticle();
    fireEvent.pointerDown(el, { button: 0, clientX: PIVOT.x, clientY: PIVOT.y });
    // +40/+18 client ⇒ +80/+36 comp ⇒ 80/640 and 36/360 of the layer.
    fireEvent.pointerMove(el, { clientX: PIVOT.x + 40, clientY: PIVOT.y + 18 });
    expect(transformOverrideFor("l1")).toEqual({
      dx: 0,
      dy: 0,
      danchorX: 0.125,
      danchorY: 0.1,
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it("commits the anchor pair ALONE on an unrotated layer", async () => {
    render(<TransformGizmoHost />);
    await box();
    const el = await reticle();
    fireEvent.pointerDown(el, { button: 0, clientX: PIVOT.x, clientY: PIVOT.y });
    fireEvent.pointerMove(el, { clientX: PIVOT.x + 40, clientY: PIVOT.y + 18 });
    fireEvent.pointerUp(el, { clientX: PIVOT.x + 40, clientY: PIVOT.y + 18 });
    // No x/y: the picture never moved, so keying position would be noise.
    expect(commit).toHaveBeenCalledTimes(1);
    expect(committedStatics()).toEqual([
      ["anchor_x", 0.625],
      ["anchor_y", 0.6],
    ]);
  });

  it("rides compensating x/y in the SAME batch on a rotated layer", async () => {
    useProjectStore.getState().apply(fixture({ rotation_deg: stat(90) }));
    render(<TransformGizmoHost />);
    await box();
    const el = await reticle();
    fireEvent.pointerDown(el, { button: 0, clientX: PIVOT.x, clientY: PIVOT.y });
    // +40 client ⇒ +80 comp; on a 90°-rotated layer that is −80 px along its own
    // y axis, i.e. −80/360 of the anchor.
    fireEvent.pointerMove(el, { clientX: PIVOT.x + 40, clientY: PIVOT.y });
    fireEvent.pointerUp(el, { clientX: PIVOT.x + 40, clientY: PIVOT.y });
    expect(commit).toHaveBeenCalledTimes(1);
    const entries = committedStatics();
    expect(entries.map(([k]) => k)).toEqual(["anchor_x", "anchor_y", "x", "y"]);
    expect(entries[0]![1]).toBeCloseTo(0.5, 9);
    expect(entries[1]![1]).toBeCloseTo(0.5 - 80 / 360, 9);
    // (|S| − R·S)·q = (−80, −80), so the fix is (+80, +80) — the picture stays.
    expect(entries[2]![1]).toBeCloseTo(80, 9);
    expect(entries[3]![1]).toBeCloseTo(80, 9);
  });

  it("compensates a Text layer even unrotated, because its x/y IS the anchor", async () => {
    useProjectStore.getState().apply(fixture({}, "Text"));
    render(<TransformGizmoHost />);
    await box();
    const el = await reticle();
    fireEvent.pointerDown(el, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { clientX: 40, clientY: 18 });
    fireEvent.pointerUp(el, { clientX: 40, clientY: 18 });
    expect(committedStatics()).toEqual([
      ["anchor_x", 0.625],
      ["anchor_y", 0.6],
      ["x", 80],
      ["y", 36],
    ]);
  });

  it("keys a keyframed anchor at the frame-snapped playhead", async () => {
    useProjectStore.getState().apply(
      fixture({
        anchor_x: {
          mode: "Keyframed",
          value: [{ id: "k1", t_us: 0, value: 0.25, interp: { kind: "Linear" } }],
        } as AnimTrack<number>,
      }),
    );
    render(<TransformGizmoHost />);
    await box();
    const el = await reticle();
    fireEvent.pointerDown(el, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { clientX: 40, clientY: 0 });
    fireEvent.pointerUp(el, { clientX: 40, clientY: 0 });
    const [, entries] = commit.mock.calls[0] as unknown as [string, [string, AnimTrack<number>][]];
    const ax = entries[0]![1];
    expect(ax.mode).toBe("Keyframed");
    // Playhead 2.5 s − layer start 2 s = frame 15 at 30 fps; 0.25 + 0.125.
    const keys = ax.value as Array<{ t_us: number; value: number }>;
    expect(keys.find((k) => k.t_us === 500_000)?.value).toBeCloseTo(0.375, 9);
    // anchor_y was Static and stays Static — two independent tracks.
    expect(entries[1]![1]).toEqual({ mode: "Static", value: 0.5 });
  });

  it("cancels on Escape and ignores a reticle click that never moved", async () => {
    render(<TransformGizmoHost />);
    await box();
    const el = await reticle();
    fireEvent.pointerDown(el, { button: 0, clientX: PIVOT.x, clientY: PIVOT.y });
    fireEvent.pointerMove(el, { clientX: PIVOT.x + 40, clientY: PIVOT.y });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(transformOverrideFor("l1")).toBeUndefined();
    fireEvent.pointerUp(el, { clientX: PIVOT.x + 40, clientY: PIVOT.y });
    expect(commit).not.toHaveBeenCalled();

    fireEvent.pointerDown(el, { button: 0, clientX: PIVOT.x, clientY: PIVOT.y });
    fireEvent.pointerUp(el, { clientX: PIVOT.x, clientY: PIVOT.y });
    expect(commit).not.toHaveBeenCalled();
    expect(transformOverrideFor("l1")).toBeUndefined();
  });
});

/// A resize handle, once the draw loop has placed it. Returns the element and
/// the client point it was drawn at, so a gesture can grab it where it actually
/// is instead of assuming an unrotated box.
async function handle(id: string): Promise<[HTMLElement, { clientX: number; clientY: number }]> {
  const el = await screen.findByTestId(`transform-gizmo-scale-${id}`);
  await waitFor(() => expect(el.getAttribute("transform")).not.toBeNull());
  return [el, placedAt(el)];
}

/// The commit's entry keys, in order.
function committedKeys(): string[] {
  const [, entries] = commit.mock.calls[0] as unknown as [string, [string, AnimTrack<number>][]];
  return entries.map(([k]) => k);
}

describe("TransformGizmo scale handles", () => {
  it("shows only the four corners on a scale-linked layer", async () => {
    render(<TransformGizmoHost />);
    await box();
    const [br] = await handle("br");
    // 640×360 media at scale 1 in a half-scale canvas ⇒ a 320×180 box at (0,0).
    expect(br.getAttribute("transform")).toBe("translate(320 180)");
    expect(screen.getByTestId("transform-gizmo-scale-tl").getAttribute("transform")).toBe(
      "translate(0 0)",
    );
    // A linked layer cannot move one axis alone, so it is not offered a handle
    // that claims it can.
    for (const id of ["t", "r", "b", "l"]) {
      expect(screen.getByTestId(`transform-gizmo-scale-${id}`).style.display).toBe("none");
    }
  });

  it("adds the edge midpoints once the layer is unlinked", async () => {
    useProjectStore.getState().apply(fixture({ scale_linked: false }));
    render(<TransformGizmoHost />);
    await box();
    const [t, at] = await handle("t");
    expect(t.style.display).not.toBe("none");
    expect(at).toEqual({ clientX: 160, clientY: 0 });
    expect(screen.getByTestId("transform-gizmo-scale-l").getAttribute("transform")).toBe(
      "translate(0 90)",
    );
  });

  it("hides an edge handle whose edge is too short to separate it from the corners", async () => {
    // scale_y 0.05 ⇒ a 9 px tall box on screen; its left/right midpoints would
    // sit under both corners.
    useProjectStore.getState().apply(fixture({ scale_linked: false, scale_y: stat(0.05) }));
    render(<TransformGizmoHost />);
    await box();
    await handle("t");
    expect(screen.getByTestId("transform-gizmo-scale-t").style.display).not.toBe("none");
    expect(screen.getByTestId("transform-gizmo-scale-l").style.display).toBe("none");
    expect(screen.getByTestId("transform-gizmo-scale-tl").style.display).not.toBe("none");
  });

  it("hides the handles with the box when the playhead leaves the layer", async () => {
    setPlayheadTimeUs(9_000_000);
    render(<TransformGizmoHost />);
    const el = await screen.findByTestId("transform-gizmo-scale-br");
    await waitFor(() => expect(el.style.display).toBe("none"));
  });

  it("previews a corner drag as scale PLUS the x/y that pins the pivot", async () => {
    render(<TransformGizmoHost />);
    await box();
    const [br, at] = await handle("br");
    fireEvent.pointerDown(br, { button: 0, ...at });
    // +80/+45 client ⇒ +160/+90 comp: the corner goes from (640,360) to
    // (800,450), i.e. 1.5× its offset from the centred pivot on both axes.
    fireEvent.pointerMove(br, { clientX: at.clientX + 80, clientY: at.clientY + 45 });
    expect(transformOverrideFor("l1")).toEqual({
      // Growing about the centre moves the unrotated top-left by half the growth.
      dx: -160,
      dy: -90,
      dscaleX: 0.5,
      dscaleY: 0.5,
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it("keeps the pivot fixed and the grabbed corner under the cursor", async () => {
    render(<TransformGizmoHost />);
    const el = await box();
    const [br, at] = await handle("br");
    fireEvent.pointerDown(br, { button: 0, ...at });
    fireEvent.pointerMove(br, { clientX: at.clientX + 80, clientY: at.clientY + 45 });
    // The box reads the same override map the Compositor folds into the picture,
    // so this is also the assertion that box and footprint agree mid-drag.
    await waitFor(() => {
      const pts = corners(el);
      expect(pts[2]).toEqual({ x: 400, y: 225 }); // the grabbed corner = the cursor
      expect(pts.reduce((s, p) => s + p.x, 0) / 4).toBeCloseTo(PIVOT.x, 6);
      expect(pts.reduce((s, p) => s + p.y, 0) / 4).toBeCloseTo(PIVOT.y, 6);
    });
  });

  it("commits a linked layer's scale as ONE track fanned out to both axes", async () => {
    render(<TransformGizmoHost />);
    await box();
    const [br, at] = await handle("br");
    fireEvent.pointerDown(br, { button: 0, ...at });
    fireEvent.pointerMove(br, { clientX: at.clientX + 80, clientY: at.clientY + 45 });
    fireEvent.pointerUp(br, { clientX: at.clientX + 80, clientY: at.clientY + 45 });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(committedStatics()).toEqual([
      ["scale_x", 1.5],
      ["scale_y", 1.5],
      ["x", -160],
      ["y", -90],
    ]);
  });

  it("hands the hidden twin a COPY of the authored track, not its own history", async () => {
    // A linked layer whose scale_y has drifted (a repaired-on-load flag, or a
    // pre-link edit). Fanning out overwrites the drift; two independent writes
    // would preserve it and the main-side twin check would clear scale_linked.
    useProjectStore.getState().apply(
      fixture({
        scale_x: {
          mode: "Keyframed",
          value: [{ id: "k1", t_us: 0, value: 1, interp: { kind: "Linear" } }],
        } as AnimTrack<number>,
        scale_y: {
          mode: "Keyframed",
          value: [
            { id: "k2", t_us: 0, value: 1, interp: { kind: "Linear" } },
            { id: "k3", t_us: 900_000, value: 9, interp: { kind: "Linear" } },
          ],
        } as AnimTrack<number>,
      }),
    );
    render(<TransformGizmoHost />);
    await box();
    const [br, at] = await handle("br");
    fireEvent.pointerDown(br, { button: 0, ...at });
    fireEvent.pointerMove(br, { clientX: at.clientX + 80, clientY: at.clientY + 45 });
    fireEvent.pointerUp(br, { clientX: at.clientX + 80, clientY: at.clientY + 45 });
    const [, entries] = commit.mock.calls[0] as unknown as [string, [string, AnimTrack<number>][]];
    const [x, y] = [entries[0]![1], entries[1]![1]];
    const times = (t: AnimTrack<number>) =>
      (t.value as Array<{ t_us: number; value: number }>).map((k) => [k.t_us, k.value]);
    expect(times(y)).toEqual(times(x));
    // The original key at 0 plus one at frame 15 of 30 fps (playhead 2.5 s −
    // layer start 2 s) — and scale_y's stray 900 ms key is GONE, which is what
    // separates a fan-out from two independent writes.
    expect(times(x).map(([t]) => t)).toEqual([0, 500_000]);
  });

  it("scales the axes independently on an unlinked layer, keying only what moved", async () => {
    useProjectStore.getState().apply(fixture({ scale_linked: false }));
    render(<TransformGizmoHost />);
    await box();
    const [br, at] = await handle("br");
    // Horizontal only: scale_y and its compensation are untouched, so neither
    // is written.
    fireEvent.pointerDown(br, { button: 0, ...at });
    fireEvent.pointerMove(br, { clientX: at.clientX + 80, clientY: at.clientY });
    fireEvent.pointerUp(br, { clientX: at.clientX + 80, clientY: at.clientY });
    expect(committedStatics()).toEqual([
      ["scale_x", 1.5],
      ["x", -160],
    ]);
  });

  it("constrains an unlinked layer's proportions while Shift is held", async () => {
    useProjectStore.getState().apply(fixture({ scale_linked: false }));
    render(<TransformGizmoHost />);
    await box();
    const [br, at] = await handle("br");
    fireEvent.pointerDown(br, { button: 0, ...at });
    fireEvent.pointerMove(br, { clientX: at.clientX + 80, clientY: at.clientY, shiftKey: true });
    const d = transformOverrideFor("l1")!;
    // The cursor projected onto the corner's own diagonal: b = (320,180),
    // v = (480,180) ⇒ t = (320·480 + 180·180)/(320² + 180²).
    const t = (320 * 480 + 180 * 180) / (320 * 320 + 180 * 180);
    expect(d.dscaleX).toBeCloseTo(t - 1, 9);
    expect(d.dscaleY).toBeCloseTo(t - 1, 9);
  });

  it("drives ONE axis from an edge handle", async () => {
    useProjectStore.getState().apply(fixture({ scale_linked: false }));
    render(<TransformGizmoHost />);
    await box();
    const [r, at] = await handle("r");
    fireEvent.pointerDown(r, { button: 0, ...at });
    // The vertical component is ignored — that is the whole point of an edge.
    fireEvent.pointerMove(r, { clientX: at.clientX + 80, clientY: at.clientY - 200 });
    fireEvent.pointerUp(r, { clientX: at.clientX + 80, clientY: at.clientY - 200 });
    expect(committedStatics()).toEqual([
      ["scale_x", 1.5],
      ["x", -160],
    ]);
  });

  it("reads the drag in the layer's own frame when it is rotated", async () => {
    useProjectStore.getState().apply(fixture({ scale_linked: false, rotation_deg: stat(90) }));
    render(<TransformGizmoHost />);
    await box();
    const [br, at] = await handle("br");
    // 90° clockwise: the layer's own +x runs DOWN the screen, so a purely
    // vertical drag is a pure scale_x change. Grabbing the handle where it is
    // drawn is what makes this a real gesture rather than an arithmetic check.
    fireEvent.pointerDown(br, { button: 0, ...at });
    fireEvent.pointerMove(br, { clientX: at.clientX, clientY: at.clientY + 90 });
    fireEvent.pointerUp(br, { clientX: at.clientX, clientY: at.clientY + 90 });
    const entries = committedStatics();
    expect(entries.map(([k]) => k)).toEqual(["scale_x", "x"]);
    // +90 client ⇒ +180 comp along the layer's local x: 320 → 500 of lever.
    expect(entries[0]![1]).toBeCloseTo(500 / 320, 9);
    expect(entries[1]![1]).toBeCloseTo(320 * (1 - 500 / 320), 9);
  });

  it("writes no position fix for Text, whose x/y IS the pivot", async () => {
    useProjectStore.getState().apply(fixture({ scale_linked: false }, "Text"));
    render(<TransformGizmoHost />);
    await box();
    const [br, at] = await handle("br");
    fireEvent.pointerDown(br, { button: 0, ...at });
    fireEvent.pointerMove(br, { clientX: at.clientX + 80, clientY: at.clientY + 45 });
    fireEvent.pointerUp(br, { clientX: at.clientX + 80, clientY: at.clientY + 45 });
    expect(committedKeys()).toEqual(["scale_x", "scale_y"]);
  });

  it("keys a keyframed scale at the frame-snapped playhead", async () => {
    useProjectStore.getState().apply(
      fixture({
        scale_x: {
          mode: "Keyframed",
          value: [{ id: "k1", t_us: 0, value: 1, interp: { kind: "Linear" } }],
        } as AnimTrack<number>,
      }),
    );
    render(<TransformGizmoHost />);
    await box();
    const [br, at] = await handle("br");
    fireEvent.pointerDown(br, { button: 0, ...at });
    fireEvent.pointerMove(br, { clientX: at.clientX + 80, clientY: at.clientY + 45 });
    fireEvent.pointerUp(br, { clientX: at.clientX + 80, clientY: at.clientY + 45 });
    const [, entries] = commit.mock.calls[0] as unknown as [string, [string, AnimTrack<number>][]];
    const sx = entries[0]![1];
    expect(sx.mode).toBe("Keyframed");
    const keys = sx.value as Array<{ t_us: number; value: number }>;
    expect(keys.find((k) => k.t_us === 500_000)?.value).toBeCloseTo(1.5, 9);
  });

  it("cancels on Escape and ignores a handle click that never moved", async () => {
    render(<TransformGizmoHost />);
    await box();
    const [br, at] = await handle("br");
    fireEvent.pointerDown(br, { button: 0, ...at });
    fireEvent.pointerMove(br, { clientX: at.clientX + 80, clientY: at.clientY + 45 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(transformOverrideFor("l1")).toBeUndefined();
    fireEvent.pointerUp(br, { clientX: at.clientX + 80, clientY: at.clientY + 45 });
    expect(commit).not.toHaveBeenCalled();

    fireEvent.pointerDown(br, { button: 0, ...at });
    fireEvent.pointerUp(br, { ...at });
    expect(commit).not.toHaveBeenCalled();
    expect(transformOverrideFor("l1")).toBeUndefined();
  });
});

/// Drain a commit's promise tail. That is where the in-flight count drops, and
/// the in-flight count is what decides whether an arriving summary retires the
/// gizmo's ledger of committed-but-unreflected tracks or leaves it standing.
async function settleCommit(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// A gesture commits an ABSOLUTE track built from `base + delta`, and the base
// comes from the project mirror — which does not refresh until
// commit → `project:changed` → refetch → re-render, TWO IPC round trips later.
// These tests are that window: `commit` is mocked, so NO new summary is ever
// applied between the gestures, and every base read has to come from the
// gizmo's own ledger instead. Before the ledger existed, the second gesture in
// each pair read the pre-commit base and its commit REPLACED the first one.
describe("a second gesture inside the commit round trip", () => {
  it("stacks the move instead of overwriting the first commit", async () => {
    render(<TransformGizmoHost />);
    const el = await box();
    fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(el, { clientX: 120, clientY: 110 });
    fireEvent.pointerUp(el, { clientX: 120, clientY: 110 });
    expect(committedStatics()).toEqual([
      ["x", 40],
      ["y", 20],
    ]);
    // The override holds the carry, so the box stays where the gesture left it
    // rather than falling back to the mirror's pre-commit x/y.
    await waitFor(() => expect(el.getAttribute("points")).toBe("20,10 340,10 340,190 20,190"));

    fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(el, { clientX: 110, clientY: 100 });
    // 20 comp px of NEW gesture on top of the 40 already committed. Without the
    // carry this reads {dx: 20} — a visible 40 px snap back on the first move,
    // because `setTransformOverride` replaces rather than merges.
    expect(transformOverrideFor("l1")).toMatchObject({ dx: 60, dy: 20 });
    fireEvent.pointerUp(el, { clientX: 110, clientY: 100 });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(batchStatics(1)).toEqual([
      ["x", 60],
      ["y", 20],
    ]);
  });

  it("measures the Shift rotation grid from the angle actually on screen", async () => {
    render(<TransformGizmoHost />);
    await box();
    const rot = await knob();
    fireEvent.pointerDown(rot, { button: 0, ...KNOB });
    fireEvent.pointerMove(rot, at(0));
    fireEvent.pointerUp(rot, at(0));
    expect(committedStatics()).toEqual([["rotation_deg", 90]]);
    // The knob rides the rotated box: 116 px above the pivot turns into 116 px
    // to its right. Waiting for it is also waiting for the carry to be drawn.
    await waitFor(() => expect(rot.getAttribute("transform")).not.toBe("translate(160 -26)"));

    const grab = placedAt(rot);
    const a0 = (Math.atan2(grab.clientY - PIVOT.y, grab.clientX - PIVOT.x) * 180) / Math.PI;
    fireEvent.pointerDown(rot, { button: 0, ...grab });
    // +12° of cursor travel from 90° is 102°, which the grid rounds to 105.
    // Read against the stale mirror the same gesture would be 0° + 12° → 15°,
    // i.e. Shift would drag the layer BACKWARDS off its own committed angle.
    fireEvent.pointerMove(rot, { ...at(a0 + 12, 140), shiftKey: true });
    expect(transformOverrideFor("l1")!.drotDeg).toBeCloseTo(105, 6);
    fireEvent.pointerUp(rot, at(a0 + 12, 140));
    expect(committedValue(1, "rotation_deg")).toBeCloseTo(105, 6);
  });

  it("stacks a linked resize, compensation included", async () => {
    render(<TransformGizmoHost />);
    const el = await box();
    const br = screen.getByTestId("transform-gizmo-scale-br");
    // +160/+90 comp takes the br corner's offset from the centred pivot to 1.5×.
    fireEvent.pointerDown(br, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(br, { clientX: 80, clientY: 45 });
    fireEvent.pointerUp(br, { clientX: 80, clientY: 45 });
    // Top-left of a centre-pivoted 640×360 layer at scale s is 320 − 320s.
    expect(committedStatics()).toEqual([
      ["scale_x", 1.5],
      ["scale_y", 1.5],
      ["x", -160],
      ["y", -90],
    ]);
    // The box must be DRAWN at 1.5× before the next grab: `beginScale` reads the
    // handle's start position out of the last drawn frame.
    await waitFor(() => expect(el.getAttribute("points")).toBe("-80,-45 400,-45 400,225 -80,225"));

    // Another +240/+135 comp along the same diagonal ⇒ 2.25× overall.
    fireEvent.pointerDown(br, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(br, { clientX: 120, clientY: 67.5 });
    fireEvent.pointerUp(br, { clientX: 120, clientY: 67.5 });
    expect(commit).toHaveBeenCalledTimes(2);
    // 2.25, not 1.75: the gesture is worth +0.75 over the 1.5 already committed.
    // The x/y compensation stacks with it — read off the mirror it would land at
    // −240 and the layer would jump on the next repaint.
    expect(committedValue(1, "scale_x")).toBeCloseTo(2.25, 6);
    expect(committedValue(1, "scale_y")).toBeCloseTo(2.25, 6);
    expect(committedValue(1, "x")).toBeCloseTo(-400, 6);
    expect(committedValue(1, "y")).toBeCloseTo(-225, 6);
  });

  it("lifts the override when the summary carrying the commit lands", async () => {
    render(<TransformGizmoHost />);
    const el = await box();
    fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(el, { clientX: 120, clientY: 110 });
    fireEvent.pointerUp(el, { clientX: 120, clientY: 110 });
    await settleCommit();
    expect(transformOverrideFor("l1")).toMatchObject({ dx: 40, dy: 20 });
    // The refetch arrives. The ledger track and the mirror track now resolve to
    // the same value, so the carry is zero and the override lifts itself — no
    // one has to decide when the round trip "finished".
    act(() => {
      useProjectStore.getState().apply(fixture({ x: stat(40), y: stat(20) }));
    });
    await waitFor(() => expect(transformOverrideFor("l1")).toBeUndefined());
    // And the box is unmoved across the hand-off — the whole point of holding
    // the override past the commit.
    expect(el.getAttribute("points")).toBe("20,10 340,10 340,190 20,190");
  });

  it("hands authority back to an external writer once nothing is outstanding", async () => {
    render(<TransformGizmoHost />);
    const el = await box();
    fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(el, { clientX: 120, clientY: 110 });
    fireEvent.pointerUp(el, { clientX: 120, clientY: 110 });
    await settleCommit();
    // An undo (or an inspector edit, or an MCP agent) publishes something that
    // is NEITHER our write nor the value we wrote over. With no commit still in
    // flight the ledger is retired, so it wins — a ledger that outlived its
    // burst would resurrect the drag the user just undid.
    act(() => {
      useProjectStore.getState().apply(fixture({ x: stat(500), y: stat(0) }));
    });
    await waitFor(() => expect(transformOverrideFor("l1")).toBeUndefined());
    fireEvent.pointerDown(el, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { clientX: 10, clientY: 0 });
    fireEvent.pointerUp(el, { clientX: 10, clientY: 0 });
    expect(batchStatics(1)).toEqual([
      ["x", 520],
      ["y", 0],
    ]);
  });

  it("keeps the carry through an Escape that cancels only the live gesture", async () => {
    render(<TransformGizmoHost />);
    const el = await box();
    fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(el, { clientX: 120, clientY: 110 });
    fireEvent.pointerUp(el, { clientX: 120, clientY: 110 });
    fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(el, { clientX: 200, clientY: 100 });
    fireEvent.keyDown(window, { key: "Escape" });
    // Back to the committed position, NOT to the mirror's pre-commit one.
    expect(transformOverrideFor("l1")).toMatchObject({ dx: 40, dy: 20 });
    fireEvent.pointerUp(el, { clientX: 200, clientY: 100 });
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
