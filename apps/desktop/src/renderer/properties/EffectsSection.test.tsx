// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { addEffect, updateEffect, moveEffect, removeEffect, getDescriptor } = vi.hoisted(() => ({
  addEffect: vi.fn(async () => "new-id"),
  updateEffect: vi.fn(async () => {}),
  moveEffect: vi.fn(async () => {}),
  removeEffect: vi.fn(async () => {}),
  getDescriptor: vi.fn((): unknown => null),
}));
const { updateLayerParamTracks } = vi.hoisted(() => ({
  updateLayerParamTracks: vi.fn(async (_layerId: string, _entries: [string, unknown][]) => {}),
}));
vi.mock("../ipc", () => ({ addEffect, updateEffect, moveEffect, removeEffect, updateLayerParamTracks }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k }),
}));
vi.mock("../render/effects/effectRegistry", () => ({
  listEffects: () => [{ kind: "blur", nameI18nKey: "effects.blur.name" }],
  getDescriptor,
}));
vi.mock("./EffectParamField", () => ({ EffectParamFields: () => null }));
const { pickColor } = vi.hoisted(() => ({
  pickColor: vi.fn(async () => ({ hex: "#0000ff", source: "composition" as const })),
}));
vi.mock("../colorpick/pickColor", () => ({ pickColor }));
const { setTransientOverrides, clearTransientOverrides } = vi.hoisted(() => ({
  setTransientOverrides: vi.fn(),
  clearTransientOverrides: vi.fn(),
}));
vi.mock("../render/effects/effectOverrides", () => ({ setTransientOverrides, clearTransientOverrides }));
// Mock AppSwitch to a plain button so jsdom never hits Base UI's PointerEvent
// constructor (which jsdom doesn't implement). EffectsSection tests cover the
// wiring, not the switch widget itself.
vi.mock("../components/AppSwitch", () => ({
  AppSwitch: ({ checked, onCheckedChange, "data-testid": testId }: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    "data-testid"?: string;
  }) => (
    <button
      role="switch"
      aria-checked={checked}
      data-testid={testId}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));

import { EffectsSection } from "./EffectsSection";
import type { EffectView, LayerSummary } from "../ipc";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function layerWith(effects: EffectView[]): LayerSummary {
  return { id: "L1", effects } as unknown as LayerSummary;
}
const blur = (id: string, enabled = true): EffectView => ({
  id,
  kind: "blur",
  enabled,
  params: { strength: { mode: "Static", value: 8 } },
});
const onMutated = vi.fn(async () => {});

describe("EffectsSection", () => {
  it("renders one row per effect, named from the catalog", () => {
    render(<EffectsSection layer={layerWith([blur("E1")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    // effects.blur.name has no translation in the mock → falls back to defaultValue "blur".
    // Scope to the row so we don't accidentally match the select trigger's label.
    expect(within(screen.getByTestId("effect-row-0")).getByText("blur")).toBeTruthy();
  });

  it("clicking Add calls addEffect with the selected (default) kind", async () => {
    render(<EffectsSection layer={layerWith([])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    await userEvent.click(screen.getByTestId("effect-add"));
    expect(addEffect).toHaveBeenCalledWith("L1", "blur");
  });

  it("toggling enable calls updateEffect with the negated flag", async () => {
    render(<EffectsSection layer={layerWith([blur("E1", true)])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    await userEvent.click(screen.getByTestId("effect-enable-0"));
    expect(updateEffect).toHaveBeenCalledWith("L1", "E1", { enabled: false });
  });

  it("remove calls removeEffect", async () => {
    render(<EffectsSection layer={layerWith([blur("E1")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    await userEvent.click(screen.getByTestId("effect-remove-0"));
    expect(removeEffect).toHaveBeenCalledWith("L1", "E1");
  });

  it("up is disabled at index 0; down moves to index+1", async () => {
    render(
      <EffectsSection layer={layerWith([blur("E1"), blur("E2")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />,
    );
    expect((screen.getByTestId("effect-up-0") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId("effect-down-0"));
    expect(moveEffect).toHaveBeenCalledWith("L1", "E1", 1);
  });
});

describe("effect color pick", () => {
  const chroma = (id: string): EffectView => ({
    id,
    kind: "chromakey",
    enabled: true,
    params: {},
  });
  const chromaDescriptor = {
    kind: "chromakey",
    colorGroups: [{ params: ["keyR", "keyG", "keyB"] }],
    params: {
      keyR: { default: 0 },
      keyG: { default: 1 },
      keyB: { default: 0 },
    },
  };

  it("commits a pick as ONE batched three-track write", async () => {
    getDescriptor.mockReturnValue(chromaDescriptor);
    render(<EffectsSection layer={layerWith([chroma("E1")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    await userEvent.click(screen.getByTestId("effect-colorpick-0"));
    expect(pickColor).toHaveBeenCalledWith(
      expect.objectContaining({ excludeEffectId: "E1" }),
    );
    expect(clearTransientOverrides).toHaveBeenCalledWith("E1");
    expect(updateLayerParamTracks).toHaveBeenCalledTimes(1);
    const [layerId, entries] = updateLayerParamTracks.mock.calls[0]!;
    expect(layerId).toBe("L1");
    expect(entries).toEqual([
      ["effects[E1].params[keyR]", { mode: "Static", value: 0 }],
      ["effects[E1].params[keyG]", { mode: "Static", value: 0 }],
      ["effects[E1].params[keyB]", { mode: "Static", value: 1 }],
    ]);
  });

  it("hover routes through transient overrides", async () => {
    getDescriptor.mockReturnValue(chromaDescriptor);
    pickColor.mockImplementationOnce((async (opts?: { onHover?: (hex: string) => void }) => {
      opts?.onHover?.("#ff0000");
      return null; // then cancel
    }) as never);
    render(<EffectsSection layer={layerWith([chroma("E1")])} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);
    await userEvent.click(screen.getByTestId("effect-colorpick-0"));
    expect(setTransientOverrides).toHaveBeenCalledWith("E1", { keyR: 1, keyG: 0, keyB: 0 });
    expect(clearTransientOverrides).toHaveBeenCalledWith("E1");
    expect(updateLayerParamTracks).not.toHaveBeenCalled();
  });
});
