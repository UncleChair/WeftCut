// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";
import type { AnimTrack } from "../ipc";
import { KeyframeField } from "./KeyframeField";

afterEach(cleanup);

const keyed = (t_us: number, value: number): AnimTrack<number> => ({
  mode: "Keyframed",
  value: [{ id: "a", t_us, value, interp: { kind: "Linear" } }],
});

describe("KeyframeField (no stopwatch / timeline mode)", () => {
  it("commits an upserted key at tInLayerUs on blur", async () => {
    const onCommitTrack = vi.fn();
    render(
      <KeyframeField
        layerId="L1" paramKey="x" label="x" track={keyed(0, 0)} fallback={0}
        tInLayerUs={0} playheadInSpan onCommitTrack={onCommitTrack}
        widgets={["number"]} step={1} showStopwatch={false}
      />,
    );
    await userEvent.type(screen.getByLabelText("x"), "120");
    await userEvent.click(document.body); // blur → commit
    expect(onCommitTrack).toHaveBeenCalledTimes(1);
    const [paramKey, next] = onCommitTrack.mock.calls[0]!;
    expect(paramKey).toBe("x");
    expect(next.mode === "Keyframed" && next.value[0].value).toBe(120);
  });

  it("disables the input off-span when there is no stopwatch", () => {
    render(
      <KeyframeField
        layerId="L1" paramKey="x" label="x" track={keyed(0, 0)} fallback={0}
        tInLayerUs={-100} playheadInSpan={false} onCommitTrack={vi.fn()}
        widgets={["number"]} showStopwatch={false}
      />,
    );
    expect((screen.getByLabelText("x") as HTMLInputElement).disabled).toBe(true);
  });

  it("idle display follows the evaluated value (shown) when not editing", () => {
    const { rerender } = render(
      <KeyframeField
        layerId="L1" paramKey="x" label="x" track={keyed(0, 10)} fallback={0}
        tInLayerUs={0} playheadInSpan onCommitTrack={vi.fn()}
        widgets={["number"]} showStopwatch={false}
      />,
    );
    expect((screen.getByLabelText("x") as HTMLInputElement).value).toBe("10");
    rerender(
      <KeyframeField
        layerId="L1" paramKey="x" label="x" track={keyed(0, 42)} fallback={0}
        tInLayerUs={0} playheadInSpan onCommitTrack={vi.fn()}
        widgets={["number"]} showStopwatch={false}
      />,
    );
    expect((screen.getByLabelText("x") as HTMLInputElement).value).toBe("42");
  });
});

describe("KeyframeField widget composition", () => {
  it("renders a readout span next to a slider", () => {
    render(
      <KeyframeField
        layerId="L1" paramKey="opacity" label="opacity" track={keyed(0, 0.5)} fallback={1}
        tInLayerUs={0} playheadInSpan onCommitTrack={vi.fn()}
        widgets={["slider", "readout"]} step={0.01} min={0} max={1} showStopwatch={false}
      />,
    );
    expect(screen.getByRole("slider")).toBeTruthy();
    expect(screen.getByText("0.50")).toBeTruthy();
  });

  it("renders a slider AND a number field bound to the same value", () => {
    render(
      <KeyframeField
        layerId="L1" paramKey="opacity" label="opacity" track={keyed(0, 0.5)} fallback={1}
        tInLayerUs={0} playheadInSpan onCommitTrack={vi.fn()}
        widgets={["slider", "number"]} step={0.01} min={0} max={1} showStopwatch={false}
      />,
    );
    expect(screen.getByRole("slider")).toBeTruthy();
    // AppSlider also renders a visually-hidden <input type="range" aria-label>,
    // so getByLabelText("opacity") matches two inputs in jsdom. Scope to the
    // number field's input (type="text", aria-roledescription="Number field");
    // both inputs share the one draft value, so 0.5 still asserts the binding.
    const numberInput = screen
      .getAllByLabelText("opacity")
      .find((el) => (el as HTMLInputElement).type === "text") as HTMLInputElement;
    expect(numberInput.value).toBe("0.5");
  });
});

describe("KeyframeField (stopwatch / inspector mode)", () => {
  it("renders the stopwatch toggle when showStopwatch is set", () => {
    render(
      <KeyframeField
        layerId="L1" paramKey="x" label="x" track={keyed(0, 0)} fallback={0}
        tInLayerUs={0} playheadInSpan onCommitTrack={vi.fn()}
        widgets={["number"]} showStopwatch onMutated={async () => {}}
      />,
    );
    expect(document.querySelector(".anim-stopwatch")).toBeTruthy();
  });
});
