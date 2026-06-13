// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppInput } from "./AppInput";

afterEach(cleanup);

describe("AppInput", () => {
  it("emits each keystroke via onValueChange", async () => {
    const onValueChange = vi.fn();
    render(<AppInput value="" onValueChange={onValueChange} ariaLabel="name" />);
    await userEvent.type(screen.getByLabelText("name"), "ab");
    expect(onValueChange).toHaveBeenCalledTimes(2);
    expect(onValueChange).toHaveBeenLastCalledWith("b"); // controlled value stays "" → last char only
  });

  it("applies the shared skin and modifier classes", () => {
    render(
      <AppInput value="x" onValueChange={() => {}} ariaLabel="f" invalid mono align="center" />,
    );
    const el = screen.getByLabelText("f");
    expect(el.className).toContain("app-input");
    expect(el.className).toContain("app-input--invalid");
    expect(el.className).toContain("app-input--mono");
    expect(el.className).toContain("app-input--center");
  });

  it("forwards onBlur and onKeyDown to the input", async () => {
    const onBlur = vi.fn();
    const onKeyDown = vi.fn();
    render(
      <AppInput value="x" onValueChange={() => {}} ariaLabel="f" onBlur={onBlur} onKeyDown={onKeyDown} />,
    );
    const el = screen.getByLabelText("f");
    el.focus();
    await userEvent.keyboard("{Enter}");
    expect(onKeyDown).toHaveBeenCalled();
    el.blur();
    expect(onBlur).toHaveBeenCalled();
  });

  it("clearable search shows a clear button only when non-empty and clears to ''", async () => {
    const onValueChange = vi.fn();
    const { rerender } = render(
      <AppInput type="search" clearable value="" onValueChange={onValueChange} ariaLabel="s" />,
    );
    expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
    rerender(<AppInput type="search" clearable value="hi" onValueChange={onValueChange} ariaLabel="s" />);
    await userEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(onValueChange).toHaveBeenLastCalledWith("");
  });
});
