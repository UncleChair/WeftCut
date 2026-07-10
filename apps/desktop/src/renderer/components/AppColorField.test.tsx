// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { pickColor } = vi.hoisted(() => ({
  pickColor: vi.fn(async () => ({ hex: "#00ff00", source: "composition" as const })),
}));
vi.mock("../colorpick/pickColor", () => ({ pickColor }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { AppColorField } from "./AppColorField";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AppColorField", () => {
  it("emits the picked hex via onValueChange (no internal debounce)", () => {
    const onValueChange = vi.fn();
    render(<AppColorField value="#000000" onValueChange={onValueChange} ariaLabel="c" />);
    fireEvent.input(screen.getByLabelText("c"), { target: { value: "#ff0000" } });
    expect(onValueChange).toHaveBeenCalledWith("#ff0000");
  });

  it("applies the swatch skin and is disableable", () => {
    render(<AppColorField value="#fff" onValueChange={() => {}} disabled ariaLabel="c" />);
    const el = screen.getByLabelText("c") as HTMLInputElement;
    expect(el.className).toContain("app-color-swatch");
    expect(el.disabled).toBe(true);
  });

  it("eyedropper button commits a pick through onValueChange", async () => {
    const onValueChange = vi.fn();
    render(<AppColorField value="#000000" onValueChange={onValueChange} ariaLabel="c" />);
    fireEvent.click(screen.getByLabelText("colorpick.pick"));
    expect(pickColor).toHaveBeenCalled();
    await vi.waitFor(() => expect(onValueChange).toHaveBeenCalledWith("#00ff00"));
  });

  it("cancelled pick (null) commits nothing", async () => {
    pickColor.mockResolvedValueOnce(null as never);
    const onValueChange = vi.fn();
    render(<AppColorField value="#000000" onValueChange={onValueChange} ariaLabel="c" />);
    fireEvent.click(screen.getByLabelText("colorpick.pick"));
    await Promise.resolve();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("withEyeDropper=false renders the bare input", () => {
    render(
      <AppColorField value="#000000" onValueChange={() => {}} ariaLabel="c" withEyeDropper={false} />,
    );
    expect(screen.queryByLabelText("colorpick.pick")).toBeNull();
  });
});
