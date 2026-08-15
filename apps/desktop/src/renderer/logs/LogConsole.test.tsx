// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// Real i18n: the sash is queried by its accessible name below, so a
// missing key fails here.
import "../i18n";

// jsdom does not implement PointerEvent; alias it to MouseEvent so
// fireEvent.pointerDown carries a usable .clientY (same shim
// TransformGizmo.test.tsx uses).
if (typeof window !== "undefined" && !window.PointerEvent) {
  (window as unknown as Record<string, unknown>).PointerEvent = window.MouseEvent;
}

vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return {
    ...actual,
    logClear: vi.fn(async () => {}),
    logDirPath: vi.fn(async () => "/tmp/logs"),
  };
});
vi.mock("@/bridge/shell", () => ({ open: vi.fn(async () => {}) }));

import { LogConsole, clearLogConsoleHeightMemory } from "./LogConsole";

afterEach(() => {
  cleanup();
  clearLogConsoleHeightMemory();
});

/// jsdom has no layout, so the console's rendered height reads as 0.
/// Pin `offsetHeight` to a known value — the drag math measures from it.
function mount(startHeight = 400): { root: HTMLElement; sash: HTMLElement } {
  render(<LogConsole onClose={() => {}} />);
  const root = screen.getByRole("log");
  Object.defineProperty(root, "offsetHeight", {
    value: startHeight,
    configurable: true,
  });
  const sash = screen.getByRole("separator", {
    name: "Resize console height",
  });
  return { root, sash };
}

describe("LogConsole resize sash", () => {
  it("drags the top edge: up grows, down shrinks, both clamped", () => {
    const { root, sash } = mount(400);

    // Up 120 px → 520 px.
    fireEvent.pointerDown(sash, { clientY: 500 });
    fireEvent.pointerMove(sash, { clientY: 380 });
    expect(root.style.height).toBe("520px");

    // Far past the top → clamped to 80 % of the 768 px jsdom viewport.
    fireEvent.pointerMove(sash, { clientY: -400 });
    expect(root.style.height).toBe(`${Math.round(768 * 0.8)}px`);

    // Far past the bottom → clamped to the 200 px floor.
    fireEvent.pointerMove(sash, { clientY: 900 });
    expect(root.style.height).toBe("200px");

    // Release detaches the move listener: further moves change nothing.
    fireEvent.pointerUp(sash, { clientY: 900 });
    fireEvent.pointerMove(sash, { clientY: 380 });
    expect(root.style.height).toBe("200px");
  });

  it("resizes from the keyboard: arrows step, shift steps bigger", () => {
    const { root, sash } = mount(400);

    fireEvent.keyDown(sash, { key: "ArrowUp" });
    expect(root.style.height).toBe("416px");
    fireEvent.keyDown(sash, { key: "ArrowDown", shiftKey: true });
    expect(root.style.height).toBe("352px");
  });

  it("remembers the dragged height across close/reopen within the session", () => {
    const first = mount(400);
    fireEvent.pointerDown(first.sash, { clientY: 500 });
    fireEvent.pointerMove(first.sash, { clientY: 400 });
    fireEvent.pointerUp(first.sash, { clientY: 400 });
    expect(first.root.style.height).toBe("500px");
    cleanup();

    render(<LogConsole onClose={() => {}} />);
    expect(screen.getByRole("log").style.height).toBe("500px");
  });
});
