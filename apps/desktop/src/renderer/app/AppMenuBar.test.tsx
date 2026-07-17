// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DevMenu } from "./AppMenuBar";

describe("DevMenu", () => {
  it("renders no Dev chrome when disabled for a production build", () => {
    const { container } = render(<DevMenu enabled={false} />);

    expect(container.childElementCount).toBe(0);
    expect(screen.queryByText("Performance Monitor")).toBeNull();
  });

  it("opens the Performance Monitor from the development dropdown", async () => {
    const onOpen = vi.fn();
    render(<DevMenu enabled onOpenPerformanceMonitor={onOpen} />);

    fireEvent.click(screen.getByRole("button", { name: /Dev/ }));
    const entry = await screen.findByText("Performance Monitor");
    fireEvent.click(entry);

    expect(onOpen).toHaveBeenCalledOnce();
  });
});
