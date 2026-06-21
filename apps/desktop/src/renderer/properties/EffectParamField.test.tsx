// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { updateLayerParamTrack } = vi.hoisted(() => ({
  updateLayerParamTrack: vi.fn(async () => {}),
}));
vi.mock("../ipc", () => ({ updateLayerParamTrack }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k }),
}));
// Isolate from KeyframeField internals: a stub that surfaces the wired props
// and lets the test fire onCommitTrack.
vi.mock("../components/KeyframeField", () => ({
  KeyframeField: (props: {
    paramKey: string;
    label: string;
    track: { mode: string; value: number };
    onCommitTrack: (k: string, t: { mode: "Static"; value: number }) => void;
  }) => (
    <button
      data-testid={`kf-${props.paramKey}`}
      onClick={() => props.onCommitTrack(props.paramKey, { mode: "Static", value: 42 })}
    >
      {props.label}:{props.track.mode === "Static" ? props.track.value : "kf"}
    </button>
  ),
}));

import { EffectParamFields } from "./EffectParamField";
import type { EffectView, LayerSummary } from "../ipc";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const layer = { id: "L1" } as unknown as LayerSummary;
const onMutated = vi.fn(async () => {});

describe("EffectParamFields", () => {
  it("renders a row per registry param, reading the effect's current value", () => {
    const effect: EffectView = { id: "E1", kind: "blur", enabled: true, params: { strength: { mode: "Static", value: 8 } } };
    render(<EffectParamFields layer={layer} effect={effect} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    // label "strength" (defaultValue) : value 8
    expect(screen.getByText("strength:8")).toBeTruthy();
  });

  it("falls back to the registry default when the param slot is absent", () => {
    const effect: EffectView = { id: "E1", kind: "blur", enabled: true, params: {} };
    render(<EffectParamFields layer={layer} effect={effect} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    expect(screen.getByText("strength:8")).toBeTruthy(); // blur default
  });

  it("commits to the nested effects[id].params[key] track key", async () => {
    const effect: EffectView = { id: "E1", kind: "blur", enabled: true, params: {} };
    render(<EffectParamFields layer={layer} effect={effect} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    await userEvent.click(screen.getByTestId("kf-effects[E1].params[strength]"));
    expect(updateLayerParamTrack).toHaveBeenCalledWith("L1", "effects[E1].params[strength]", { mode: "Static", value: 42 });
  });

  it("renders nothing for an unknown kind", () => {
    const effect: EffectView = { id: "E1", kind: "mystery", enabled: true, params: {} };
    const { container } = render(
      <EffectParamFields layer={layer} effect={effect} tInLayerUs={0} playheadInSpan onMutated={onMutated} />,
    );
    expect(container.querySelector("[data-testid^='kf-']")).toBeNull();
  });
});
