// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StringPropField } from "./PropertyPanel";

afterEach(cleanup);

const spec = { type: "string" as const, default: "", max_length: 50 };

describe("StringPropField", () => {
  it("commits the current text when Enter is pressed", async () => {
    const onCommit = vi.fn();
    render(<StringPropField label="Title" spec={spec} value="" onCommit={onCommit} />);
    const el = screen.getByRole("textbox");
    await userEvent.type(el, "hello");
    expect(onCommit).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledWith("hello");
  });

  it("still commits on blur", async () => {
    const onCommit = vi.fn();
    render(<StringPropField label="Title" spec={spec} value="" onCommit={onCommit} />);
    await userEvent.type(screen.getByRole("textbox"), "world");
    await userEvent.click(document.body); // blur
    expect(onCommit).toHaveBeenCalledWith("world");
  });
});
