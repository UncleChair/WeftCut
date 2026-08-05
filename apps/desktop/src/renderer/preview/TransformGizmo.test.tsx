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
  const [, entries] = commit.mock.calls[0] as unknown as [string, [string, AnimTrack<number>][]];
  return entries.map(([k, t]) => [k, (t as { mode: "Static"; value: number }).value]);
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
