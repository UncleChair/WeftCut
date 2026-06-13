// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppNumberField } from "./AppNumberField";

afterEach(cleanup);

describe("AppNumberField", () => {
  it("emits live numeric changes via onValueChange", async () => {
    const onValueChange = vi.fn();
    render(<AppNumberField value={0} onValueChange={onValueChange} ariaLabel="x" />);
    await userEvent.type(screen.getByLabelText("x"), "5");
    expect(onValueChange).toHaveBeenLastCalledWith(5);
  });

  it("fires onCommit on blur, not on every keystroke", async () => {
    const onCommit = vi.fn();
    render(<AppNumberField value={0} onValueChange={() => {}} onCommit={onCommit} ariaLabel="x" />);
    const el = screen.getByLabelText("x");
    await userEvent.type(el, "12");
    expect(onCommit).not.toHaveBeenCalled();
    el.blur();
    expect(onCommit).toHaveBeenCalledWith(12);
  });

  it("does not emit null onValueChange when the field is cleared", async () => {
    const onValueChange = vi.fn();
    render(<AppNumberField value={3} onValueChange={onValueChange} ariaLabel="x" />);
    await userEvent.clear(screen.getByLabelText("x"));
    expect(onValueChange).not.toHaveBeenCalledWith(null);
  });

  it("disables the input", () => {
    render(<AppNumberField value={1} onValueChange={() => {}} disabled ariaLabel="x" />);
    expect((screen.getByLabelText("x") as HTMLInputElement).disabled).toBe(true);
  });
});
