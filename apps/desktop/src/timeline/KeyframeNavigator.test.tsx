// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import "../i18n"; // initialize i18next so t(key) resolves (mirrors EasingMenu.test)
import type { AnimTrack, TrackSummary } from "../ipc";
import { KeyframeNavigator } from "./KeyframeNavigator";
import { clearKeyframeFocus } from "../keyframe/focusStore";

vi.mock("../state/playbackStore", () => ({ transportSeek: vi.fn() }));
import { transportSeek } from "../state/playbackStore";

// jsdom lacks PointerEvent; polyfill so fireEvent.pointerDown works.
if (typeof window !== "undefined" && !window.PointerEvent) {
  (window as unknown as Record<string, unknown>).PointerEvent = window.MouseEvent;
}

afterEach(() => {
  cleanup();
  clearKeyframeFocus();
  vi.clearAllMocks();
});

const opacityTrack: AnimTrack<number> = {
  mode: "Keyframed",
  value: [
    { id: "a", t_us: 0, value: 0, interp: { kind: "Linear" } },
    { id: "b", t_us: 1_000_000, value: 1, interp: { kind: "Linear" } },
  ],
};

const oneClipTrack = (params: Record<string, AnimTrack<number>>): TrackSummary =>
  ({ layers: [{ id: "L1", t_start_us: 0, t_end_us: 2_000_000, params }] }) as unknown as TrackSummary;

function renderNav(currentTimeUs: number, onCommit = vi.fn()) {
  render(
    <KeyframeNavigator
      track={oneClipTrack({ opacity: opacityTrack })}
      paramKey="opacity"
      fallback={1}
      currentTimeUs={currentTimeUs}
      fpsNum={30}
      fpsDen={1}
      onCommitParamTrack={onCommit}
    />,
  );
  return onCommit;
}

const setBtn = () => screen.getByTestId("kf-nav-set") as HTMLButtonElement;
const prevBtn = () => screen.getByTestId("kf-nav-prev") as HTMLButtonElement;
const nextBtn = () => screen.getByTestId("kf-nav-next") as HTMLButtonElement;

describe("KeyframeNavigator ◆ set button", () => {
  it("is pressed when the playhead sits on a key", () => {
    renderNav(1_000_000);
    expect(setBtn().getAttribute("aria-pressed")).toBe("true");
  });
  it("is not pressed off a key", () => {
    renderNav(500_000);
    expect(setBtn().getAttribute("aria-pressed")).toBe("false");
  });
  it("removes the key when pressed on a key", () => {
    const onCommit = renderNav(1_000_000);
    fireEvent.click(setBtn());
    expect(onCommit).toHaveBeenCalledTimes(1);
    const next = onCommit.mock.calls[0]![2] as AnimTrack<number>;
    expect(next.mode === "Keyframed" && next.value.some((k) => k.id === "b")).toBe(false);
  });
  it("adds a key at the playhead when pressed off a key in span", () => {
    const onCommit = renderNav(500_000);
    fireEvent.click(setBtn());
    const next = onCommit.mock.calls[0]![2] as AnimTrack<number>;
    expect(next.mode === "Keyframed" && next.value.some((k) => k.t_us === 500_000)).toBe(true);
  });
  it("is disabled off the clip span when not on a key", () => {
    renderNav(3_000_000); // beyond t_end_us
    expect(setBtn().disabled).toBe(true);
  });
});

describe("KeyframeNavigator ◄ ► arrows", () => {
  it("disables ◄ before the first key", () => {
    renderNav(0);
    expect(prevBtn().disabled).toBe(true);
  });
  it("disables ► after the last key", () => {
    renderNav(2_000_000);
    expect(nextBtn().disabled).toBe(true);
  });
  it("seeks to the next key in absolute time on ►", () => {
    renderNav(0);
    fireEvent.click(nextBtn());
    expect(transportSeek).toHaveBeenCalledWith(1_000_000); // t_start 0 + key b at 1_000_000
  });
});

describe("KeyframeNavigator ambiguous track", () => {
  it("disables every button when two clips are keyframed and none is focused", () => {
    const tr = {
      layers: [
        { id: "L1", t_start_us: 0, t_end_us: 2_000_000, params: { opacity: opacityTrack } },
        { id: "L2", t_start_us: 0, t_end_us: 2_000_000, params: { opacity: opacityTrack } },
      ],
    } as unknown as TrackSummary;
    render(
      <KeyframeNavigator
        track={tr}
        paramKey="opacity"
        fallback={1}
        currentTimeUs={500_000}
        fpsNum={30}
        fpsDen={1}
        onCommitParamTrack={vi.fn()}
      />,
    );
    expect(setBtn().disabled).toBe(true);
    expect(prevBtn().disabled).toBe(true);
    expect(nextBtn().disabled).toBe(true);
  });
});
