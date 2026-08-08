// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, render, fireEvent } from "@testing-library/react";
import "../i18n"; // initialize i18next so the procedural badge label resolves
import type { AnimTrack, Interpolation } from "../ipc";
import { clearEasingPreview, setEasingPreview } from "../keyframe/easingPreviewStore";
import { KeyframeCurveGraph } from "./KeyframeCurveGraph";

// jsdom 25 does not implement PointerEvent; polyfill it so fireEvent.pointerDown
// creates a MouseEvent-compatible object with a usable .button property.
if (typeof window !== "undefined" && !window.PointerEvent) {
  (window as unknown as Record<string, unknown>).PointerEvent = window.MouseEvent;
}

afterEach(() => {
  cleanup();
  clearEasingPreview();
});

const track: Extract<AnimTrack<number>, { mode: "Keyframed" }> = {
  mode: "Keyframed",
  value: [
    { id: "k0", t_us: 0, value: 0, interp: { kind: "Bezier", p1: [0.42, 0], p2: [0.58, 1] } },
    { id: "k1", t_us: 1_000_000, value: 1, interp: { kind: "Linear" } },
  ],
};

function renderGraph(over: Partial<React.ComponentProps<typeof KeyframeCurveGraph>> = {}) {
  return render(
    <KeyframeCurveGraph
      track={track}
      layerTStartUs={0}
      clipDurationUs={1_000_000}
      pxPerSec={100}
      height={72}
      editable={true}
      selectedKfId={null}
      onSelectSeek={vi.fn()}
      onRetime={vi.fn()}
      onSetInterp={vi.fn()}
      onOpenMenu={vi.fn()}
      {...over}
    />,
  );
}

describe("KeyframeCurveGraph", () => {
  it("renders one dot per keyframe with the e2e contract class + data-kf-id", () => {
    const { container } = renderGraph();
    const dots = container.querySelectorAll(".kf-sublane-diamond");
    expect(dots.length).toBe(2);
    expect(dots[0]!.getAttribute("data-kf-id")).toBe("k0");
  });
  it("renders a curve polyline", () => {
    const { container } = renderGraph();
    expect(container.querySelectorAll("polyline").length).toBeGreaterThanOrEqual(1);
  });
  it("shows tangent handles only when editable", () => {
    expect(renderGraph({ editable: true }).container.querySelectorAll('[data-testid="kf-handle"]').length)
      .toBeGreaterThan(0);
    cleanup();
    expect(renderGraph({ editable: false }).container.querySelectorAll('[data-testid="kf-handle"]').length)
      .toBe(0);
  });
  it("right-click on a dot opens the menu", () => {
    const onOpenMenu = vi.fn();
    const { container } = renderGraph({ onOpenMenu });
    fireEvent.contextMenu(container.querySelector('.kf-sublane-diamond[data-kf-id="k0"]')!, { clientX: 42, clientY: 17 });
    expect(onOpenMenu).toHaveBeenCalledWith(42, 17, "k0");
  });
  it("left-click on a dot selects+seeks it", () => {
    const onSelectSeek = vi.fn();
    const { container } = renderGraph({ onSelectSeek });
    fireEvent.pointerDown(container.querySelector('.kf-sublane-diamond[data-kf-id="k0"]')!, { button: 0 });
    expect(onSelectSeek).toHaveBeenCalledWith("k0");
  });
  it("marks the selected keyframe", () => {
    const { container } = renderGraph({ selectedKfId: "k1" });
    expect(container.querySelector('.kf-sublane-diamond[data-kf-id="k1"]')!.className)
      .toContain("is-selected");
  });
  it("right-click on a segment opens the menu for that segment's owner keyframe", () => {
    const onOpenMenu = vi.fn();
    const { container } = renderGraph({ onOpenMenu });
    const hit = container.querySelector('[data-testid="kf-segment-hit"]')!;
    fireEvent.contextMenu(hit, { clientX: 5, clientY: 6 });
    // the test track has keys k0 (owns the only segment) -> k1
    expect(onOpenMenu).toHaveBeenCalledWith(5, 6, "k0");
  });
  it("commits a tangent-handle drag as a single deferred onSetInterp (one undo step)", () => {
    const onSetInterp = vi.fn();
    const { container } = renderGraph({ onSetInterp });
    const handle = container.querySelector('[data-testid="kf-handle"]')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 20, clientY: 40 });
    fireEvent.pointerMove(window, { clientX: 30, clientY: 35 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 25 });
    // No commit mid-drag.
    expect(onSetInterp).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
    // Exactly one commit on release → one undo step, carrying the final coeffs.
    expect(onSetInterp).toHaveBeenCalledTimes(1);
    expect(onSetInterp.mock.calls[0]![0]).toBe("k0");
    expect(onSetInterp.mock.calls[0]![1].kind).toBe("Bezier");
  });
});

/// Same two keys as `track` with k0's interp swapped — each case states only
/// the segment class under test.
function trackWith(interp: Interpolation): Extract<AnimTrack<number>, { mode: "Keyframed" }> {
  return {
    mode: "Keyframed",
    value: [
      { id: "k0", t_us: 0, value: 0, interp },
      { id: "k1", t_us: 1_000_000, value: 1, interp: { kind: "Linear" } },
    ],
  };
}

const ELASTIC: Interpolation = { kind: "Elastic", dir: "Out", amplitude: 1, period: 0.3 };
const BOUNCE: Interpolation = { kind: "Bounce", dir: "InOut" };

/// The visible curve strokes (each segment renders a transparent hit polyline
/// first, then the painted one).
function strokes(container: HTMLElement): string[] {
  return [...container.querySelectorAll("polyline")]
    .map((p) => p.getAttribute("stroke")!)
    .filter((s) => s !== "transparent");
}

describe("KeyframeCurveGraph — procedural segment class (Elastic/Bounce)", () => {
  it("shows no tangent handles on a procedural segment even when editable", () => {
    for (const interp of [ELASTIC, BOUNCE]) {
      const { container } = renderGraph({ track: trackWith(interp), editable: true });
      expect(container.querySelectorAll('[data-testid="kf-handle"]').length).toBe(0);
      cleanup();
    }
  });
  it("tints a procedural curve with the --keyframe token; spline keeps --ring", () => {
    expect(strokes(renderGraph({ track: trackWith(ELASTIC) }).container))
      .toEqual(["var(--keyframe, #facc15)"]);
    cleanup();
    expect(strokes(renderGraph().container)).toEqual(["var(--ring, #9a9aff)"]);
  });
  it("badges a procedural segment in the expanded editor only", () => {
    const { container } = renderGraph({ track: trackWith(BOUNCE), editable: true });
    expect(container.querySelectorAll('[data-testid="kf-procedural-badge"]').length).toBe(1);
    cleanup();
    const collapsed = renderGraph({ track: trackWith(BOUNCE), editable: false });
    expect(collapsed.container.querySelectorAll('[data-testid="kf-procedural-badge"]').length).toBe(0);
  });
  it("never badges a spline (Bezier) segment", () => {
    const { container } = renderGraph({ editable: true });
    expect(container.querySelectorAll('[data-testid="kf-procedural-badge"]').length).toBe(0);
  });
  it("redraws live from an easingPreviewStore entry for one of its keys", () => {
    // Committed Linear; the popover's slider preview swaps in an Elastic —
    // the segment must re-render as procedural without any commit.
    const { container } = renderGraph({ track: trackWith({ kind: "Linear" }), editable: true });
    expect(container.querySelectorAll('[data-testid="kf-procedural-badge"]').length).toBe(0);
    act(() => setEasingPreview("k0", ELASTIC));
    expect(container.querySelectorAll('[data-testid="kf-procedural-badge"]').length).toBe(1);
    expect(strokes(container)).toEqual(["var(--keyframe, #facc15)"]);
  });
  it("ignores a preview keyed to a keyframe it does not render", () => {
    const { container } = renderGraph({ track: trackWith({ kind: "Linear" }), editable: true });
    act(() => setEasingPreview("not-our-key", ELASTIC));
    expect(container.querySelectorAll('[data-testid="kf-procedural-badge"]').length).toBe(0);
  });
});

describe("KeyframeCurveGraph — interp glyph coding on dots", () => {
  const dotClass = (container: HTMLElement, id: string) =>
    container.querySelector(`.kf-sublane-diamond[data-kf-id="${id}"]`)!.className;

  it("an eased keyframe renders as a circle (kf-interp-eased)", () => {
    // The default track's k0 is Bezier — eased glyph; k1 is Linear — bare diamond.
    const { container } = renderGraph();
    expect(dotClass(container, "k0")).toContain("kf-interp-eased");
    expect(dotClass(container, "k1")).not.toContain("kf-interp-eased");
    expect(dotClass(container, "k1")).not.toContain("kf-interp-hold");
  });
  it("a Hold keyframe renders as a square (kf-interp-hold)", () => {
    const { container } = renderGraph({ track: trackWith({ kind: "Hold" }) });
    expect(dotClass(container, "k0")).toContain("kf-interp-hold");
  });
  it("procedural kinds carry the eased glyph too", () => {
    for (const interp of [ELASTIC, BOUNCE]) {
      const { container } = renderGraph({ track: trackWith(interp) });
      expect(dotClass(container, "k0")).toContain("kf-interp-eased");
      cleanup();
    }
  });
});
