// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppColorField } from "./AppColorField";

afterEach(cleanup);

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
});
