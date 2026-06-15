// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import "../i18n"; // initialize i18next with en-US translations so t(key) resolves
import type { AnimTrack } from "../ipc";
import { EasingMenu } from "./EasingMenu";

afterEach(cleanup);

const track: AnimTrack<number> = {
  mode: "Keyframed",
  value: [
    { id: "k0", t_us: 0, value: 0, interp: { kind: "Linear" } },
    { id: "k1", t_us: 1_000_000, value: 1, interp: { kind: "Linear" } },
  ],
};

describe("EasingMenu", () => {
  it("clicking a preset commits that interp on the keyframe and closes", () => {
    const onCommit = vi.fn();
    const onClose = vi.fn();
    render(<EasingMenu x={10} y={10} track={track} kfId="k0" onCommit={onCommit} onClose={onClose} />);
    fireEvent.click(screen.getByText("Ease In-Out"));
    const next = onCommit.mock.calls[0]![0] as AnimTrack<number>;
    const k0 = (next as Extract<AnimTrack<number>, { mode: "Keyframed" }>).value.find((k) => k.id === "k0")!;
    expect(k0.interp.kind).toBe("Bezier");
    expect(onClose).toHaveBeenCalled();
  });
  it("Smooth is disabled on a Hold keyframe", () => {
    const hold: AnimTrack<number> = {
      mode: "Keyframed",
      value: [{ id: "k0", t_us: 0, value: 0, interp: { kind: "Hold" } },
              { id: "k1", t_us: 1_000_000, value: 1, interp: { kind: "Linear" } }],
    };
    render(<EasingMenu x={0} y={0} track={hold} kfId="k0" onCommit={() => {}} onClose={() => {}} />);
    expect((screen.getByTestId("easing-smooth") as HTMLButtonElement).disabled).toBe(true);
  });
});
