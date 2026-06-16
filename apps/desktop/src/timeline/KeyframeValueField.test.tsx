// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";
import type { AnimTrack, TrackSummary } from "../ipc";
import { OPACITY } from "../keyframe/descriptors";
import { KeyframeValueField } from "./KeyframeValueField";
import { clearKeyframeFocus } from "../keyframe/focusStore";

afterEach(() => {
  cleanup();
  clearKeyframeFocus();
  vi.clearAllMocks();
});

const opacityTrack: AnimTrack<number> = {
  mode: "Keyframed",
  value: [{ id: "a", t_us: 0, value: 0.5, interp: { kind: "Linear" } }],
};
const oneClip = (params: Record<string, AnimTrack<number>>): TrackSummary =>
  ({ layers: [{ id: "L1", t_start_us: 0, t_end_us: 2_000_000, params }] }) as unknown as TrackSummary;

function renderField(currentTimeUs: number, onCommit = vi.fn()) {
  render(
    <KeyframeValueField
      track={oneClip({ opacity: opacityTrack })}
      desc={OPACITY}
      currentTimeUs={currentTimeUs}
      fpsNum={30}
      fpsDen={1}
      onCommitParamTrack={onCommit}
    />,
  );
  return onCommit;
}

describe("KeyframeValueField", () => {
  it("renders a number field (not a slider) showing the value at the playhead", () => {
    renderField(0);
    expect((screen.getByLabelText("Opacity") as HTMLInputElement).value).toBe("0.5");
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("commits an upserted key at the snapped playhead through onCommitParamTrack", async () => {
    const onCommit = renderField(0);
    const el = screen.getByLabelText("Opacity");
    await userEvent.clear(el);
    await userEvent.type(el, "0.8");
    await userEvent.click(document.body);
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [layerId, paramKey, next] = onCommit.mock.calls[0]!;
    expect(layerId).toBe("L1");
    expect(paramKey).toBe("opacity");
    expect(next.mode).toBe("Keyframed");
    expect(next.value[0].value).toBe(0.8);
  });

  it("places the key at the playhead's layer-local (t_start-relative, frame-snapped) time", async () => {
    const track: AnimTrack<number> = {
      mode: "Keyframed",
      value: [{ id: "a", t_us: 0, value: 0.5, interp: { kind: "Linear" } }],
    };
    const tr = {
      layers: [{ id: "L1", t_start_us: 1_000_000, t_end_us: 3_000_000, params: { opacity: track } }],
    } as unknown as TrackSummary;
    const onCommit = vi.fn();
    render(
      <KeyframeValueField
        track={tr}
        desc={OPACITY}
        currentTimeUs={1_500_000}
        fpsNum={30}
        fpsDen={1}
        onCommitParamTrack={onCommit}
      />,
    );
    const el = screen.getByLabelText("Opacity");
    await userEvent.clear(el);
    await userEvent.type(el, "0.8");
    await userEvent.click(document.body);
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [, , next] = onCommit.mock.calls[0]!;
    expect(next.mode).toBe("Keyframed");
    // local time = 1_500_000 - 1_000_000 = 500_000us, which is exactly frame 15 @30fps,
    // so a NEW key is upserted at t_us 500_000 (the original key at t_us 0 is kept).
    expect(next.value.some((k: { t_us: number; value: number }) => k.t_us === 500_000 && k.value === 0.8)).toBe(true);
    expect(next.value).toHaveLength(2);
  });

  it("disables the field off the clip span", () => {
    renderField(3_000_000); // beyond t_end_us
    expect((screen.getByLabelText("Opacity") as HTMLInputElement).disabled).toBe(true);
  });

  it("renders nothing when the target clip is ambiguous (two keyframed, none focused)", () => {
    const tr = {
      layers: [
        { id: "L1", t_start_us: 0, t_end_us: 2_000_000, params: { opacity: opacityTrack } },
        { id: "L2", t_start_us: 0, t_end_us: 2_000_000, params: { opacity: opacityTrack } },
      ],
    } as unknown as TrackSummary;
    const { container } = render(
      <KeyframeValueField track={tr} desc={OPACITY} currentTimeUs={0} fpsNum={30} fpsDen={1} onCommitParamTrack={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
