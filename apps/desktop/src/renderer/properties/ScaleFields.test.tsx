// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { setScaleLinked, logEmit } = vi.hoisted(() => ({
  setScaleLinked: vi.fn(async () => {}),
  logEmit: vi.fn(async () => {}),
}));
vi.mock("../ipc", () => ({ setScaleLinked, logEmit }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  // tryMutate's import chain pulls ../i18n, whose init `.use()`s this plugin.
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
// Isolate from the real field stack: surface which descriptor got rendered.
vi.mock("./InspectorAnimField", () => ({
  InspectorAnimField: ({ desc }: { desc: { paramKey: string; labelKey: string } }) => (
    <div data-testid={`field-${desc.labelKey}`} />
  ),
}));

import { ScaleFields } from "./ScaleFields";
import type { LayerSummary } from "../ipc";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const layer = { id: "L1" } as unknown as LayerSummary;
const onMutated = vi.fn(async () => {});
const renderScale = (scaleLinked: boolean) =>
  render(<ScaleFields layer={layer} scaleLinked={scaleLinked} tInLayerUs={0} playheadInSpan onMutated={onMutated} />);

describe("ScaleFields", () => {
  it("linked: ONE composite Scale row + a lit chain", () => {
    renderScale(true);
    expect(screen.getByTestId("field-property_panel.scale")).toBeTruthy();
    expect(screen.queryByTestId("field-property_panel.scale_x")).toBeNull();
    expect(screen.queryByTestId("field-property_panel.scale_y")).toBeNull();
    const chain = screen.getByRole("button", { name: "property_panel.scale_unlink" });
    expect(chain.getAttribute("aria-pressed")).toBe("true");
  });

  it("unlinked: the Scale X / Scale Y rows + an unlit chain", () => {
    renderScale(false);
    expect(screen.queryByTestId("field-property_panel.scale")).toBeNull();
    expect(screen.getByTestId("field-property_panel.scale_x")).toBeTruthy();
    expect(screen.getByTestId("field-property_panel.scale_y")).toBeTruthy();
    const chain = screen.getByRole("button", { name: "property_panel.scale_link" });
    expect(chain.getAttribute("aria-pressed")).toBe("false");
  });

  it("chain click toggles the flag through set_scale_linked (silent, no confirm)", async () => {
    renderScale(true);
    await userEvent.click(screen.getByRole("button", { name: "property_panel.scale_unlink" }));
    expect(setScaleLinked).toHaveBeenCalledWith("L1", false);
    expect(logEmit).not.toHaveBeenCalled();

    cleanup();
    renderScale(false);
    await userEvent.click(screen.getByRole("button", { name: "property_panel.scale_link" }));
    expect(setScaleLinked).toHaveBeenCalledWith("L1", true);
  });

  // Gates the tryMutate wiring this batch added across the inspector: a
  // refused direct commit lands one Project/User row instead of console.warn.
  it("a refused toggle logs one Project row through the tryMutate funnel", async () => {
    setScaleLinked.mockRejectedValueOnce(new Error("nope"));
    renderScale(true);
    await userEvent.click(screen.getByRole("button", { name: "property_panel.scale_unlink" }));
    expect(logEmit).toHaveBeenCalledTimes(1);
    expect(logEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        category: { kind: "Project" },
        source: { kind: "User" },
        message: "Toggle scale link failed: Error: nope",
      }),
    );
  });
});
