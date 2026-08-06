// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, fireEvent } from "@testing-library/react";
import type { AnimTrack } from "../ipc";
import { KeyframeCurveGraph } from "./KeyframeCurveGraph";

// jsdom 25 does not implement PointerEvent; polyfill it so fireEvent.pointerDown
// creates a MouseEvent-compatible object with a usable .button property.
if (typeof window !== "undefined" && !window.PointerEvent) {
  (window as unknown as Record<string, unknown>).PointerEvent = window.MouseEvent;
}

afterEach(cleanup);

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
