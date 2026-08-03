// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../i18n";

const settings = vi.hoisted(() => ({ displayMode: "AbRoll" as "AbRoll" | "ShowAll" }));

vi.mock("../settings/appSettingsStore", () => ({
  useDisplayMode: () => settings.displayMode,
}));

import { registerCommandProvider, type CommandDef } from "../commands/registry";
import { setTool, useToolStore } from "../state/toolStore";
import { QuickActionsPanel } from "./QuickActionsPanel";

/** A `StripGeometry` whose dimensions the test drives directly. */
function geometry(width: number, height: number) {
  const listeners = new Set<(e: { width: number; height: number }) => void>();
  return {
    width,
    height,
    onDidDimensionsChange(listener: (e: { width: number; height: number }) => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    /// Dockview emits this event outside React's event system, so the state
    /// update it triggers must be wrapped in `act` for the commit to land.
    resize(nextWidth: number, nextHeight: number) {
      this.width = nextWidth;
      this.height = nextHeight;
      act(() => {
        for (const listener of listeners) {
          listener({ width: nextWidth, height: nextHeight });
        }
      });
    },
  };
}

const runs: string[] = [];
let bladeEnabled = true;

function provideCommands(): () => void {
  const defs: CommandDef[] = [
    {
      id: "selectTool",
      actionId: "selectTool",
      labelKey: "actions.select_tool",
      run: () => {
        runs.push("selectTool");
        setTool("select");
      },
    },
    {
      id: "toggleBladeMode",
      actionId: "toggleBladeMode",
      labelKey: "actions.toggle_blade_mode",
      enabled: () => bladeEnabled,
      run: () => {
        runs.push("toggleBladeMode");
        setTool("blade");
      },
    },
    {
      id: "toggleDisplayMode",
      actionId: "toggleDisplayMode",
      labelKey: "actions.toggle_display_mode",
      run: () => {
        runs.push("toggleDisplayMode");
      },
    },
  ];
  return registerCommandProvider(() => defs);
}

let unregister: (() => void) | null = null;

beforeEach(() => {
  runs.length = 0;
  bladeEnabled = true;
  settings.displayMode = "AbRoll";
  useToolStore.setState({ tool: "select" });
  unregister = provideCommands();
});

afterEach(() => {
  unregister?.();
  unregister = null;
  cleanup();
});

function buttons(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("button[data-quick-action]"),
  );
}

function button(id: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(
    `button[data-quick-action="${id}"]`,
  );
  if (!found) throw new Error(`no strip button for "${id}"`);
  return found;
}

describe("QuickActionsPanel", () => {
  it("renders one button per catalogued command, in authored order", () => {
    render(<QuickActionsPanel geometry={geometry(400, 44)} />);
    expect(buttons().map((b) => b.dataset.quickAction)).toEqual([
      "selectTool",
      "toggleBladeMode",
      "toggleDisplayMode",
    ]);
  });

  it("runs the registry command behind a button", () => {
    render(<QuickActionsPanel geometry={geometry(400, 44)} />);
    fireEvent.click(button("toggleBladeMode"));
    expect(runs).toEqual(["toggleBladeMode"]);
  });

  // Tool buttons are radios inside a radiogroup; the display toggle is an
  // independent pressed-state button. That distinction IS the section split.
  it("reports radio state for tools and pressed state for toggles", () => {
    render(<QuickActionsPanel geometry={geometry(400, 44)} />);
    expect(button("selectTool").getAttribute("role")).toBe("radio");
    expect(button("selectTool").getAttribute("aria-checked")).toBe("true");
    expect(button("toggleBladeMode").getAttribute("aria-checked")).toBe("false");
    expect(button("toggleDisplayMode").getAttribute("role")).not.toBe("radio");
    expect(button("toggleDisplayMode").getAttribute("aria-pressed")).toBe("true");
  });

  it("follows the armed tool", () => {
    render(<QuickActionsPanel geometry={geometry(400, 44)} />);
    fireEvent.click(button("toggleBladeMode"));
    expect(button("toggleBladeMode").dataset.active).toBe("true");
    expect(button("selectTool").dataset.active).toBe("false");
  });

  it("follows the display mode", () => {
    settings.displayMode = "ShowAll";
    render(<QuickActionsPanel geometry={geometry(400, 44)} />);
    expect(button("toggleDisplayMode").dataset.active).toBe("false");
    expect(button("toggleDisplayMode").getAttribute("aria-pressed")).toBe("false");
  });

  // `canBlade` is false on an empty project. The button must grey out rather
  // than accept a click that does nothing.
  it("disables a button whose command reports itself unavailable", () => {
    bladeEnabled = false;
    render(<QuickActionsPanel geometry={geometry(400, 44)} />);
    expect(button("toggleBladeMode").disabled).toBe(true);
    fireEvent.click(button("toggleBladeMode"));
    expect(runs).toEqual([]);
  });

  it("carries the state-bearing hint for the display toggle", () => {
    render(<QuickActionsPanel geometry={geometry(400, 44)} />);
    expect(button("toggleDisplayMode").getAttribute("aria-label")).toBe(
      "Showing A/B-roll tracks only. Click to show all.",
    );
    cleanup();
    settings.displayMode = "ShowAll";
    render(<QuickActionsPanel geometry={geometry(400, 44)} />);
    expect(button("toggleDisplayMode").getAttribute("aria-label")).toBe(
      "Showing all tracks. Click to filter to A/B-roll only.",
    );
  });

  it("shows the effective binding in the tooltip", () => {
    render(<QuickActionsPanel geometry={geometry(400, 44)} />);
    expect(button("toggleBladeMode").title).toContain("Blade tool");
    expect(button("toggleBladeMode").title).toContain("C");
  });

  describe("orientation", () => {
    it("runs horizontally when wider than tall", () => {
      render(<QuickActionsPanel geometry={geometry(400, 44)} />);
      expect(screen.getByRole("toolbar").dataset.orientation).toBe("horizontal");
      expect(screen.getByRole("toolbar").getAttribute("aria-orientation")).toBe(
        "horizontal",
      );
    });

    it("runs vertically when taller than wide", () => {
      render(<QuickActionsPanel geometry={geometry(44, 400)} />);
      expect(screen.getByRole("toolbar").dataset.orientation).toBe("vertical");
    });

    it("flips when the panel is resized past square", () => {
      const geo = geometry(400, 44);
      render(<QuickActionsPanel geometry={geo} />);
      expect(screen.getByRole("toolbar").dataset.orientation).toBe("horizontal");
      geo.resize(44, 400);
      expect(screen.getByRole("toolbar").dataset.orientation).toBe("vertical");
    });

    // Without a deadband, dragging a splitter through square would flip the
    // axis on every frame.
    it("holds its axis inside the near-square deadband", () => {
      const geo = geometry(400, 44);
      render(<QuickActionsPanel geometry={geo} />);
      geo.resize(100, 110);
      expect(screen.getByRole("toolbar").dataset.orientation).toBe("horizontal");
      geo.resize(100, 140);
      expect(screen.getByRole("toolbar").dataset.orientation).toBe("vertical");
    });
  });

  describe("roving focus", () => {
    it("keeps one Tab stop for the whole strip", () => {
      render(<QuickActionsPanel geometry={geometry(400, 44)} />);
      expect(buttons().map((b) => b.tabIndex)).toEqual([0, -1, -1]);
    });

    it("moves along the strip's own axis", () => {
      render(<QuickActionsPanel geometry={geometry(400, 44)} />);
      const toolbar = screen.getByRole("toolbar");
      buttons()[0]?.focus();
      fireEvent.keyDown(toolbar, { key: "ArrowRight" });
      expect(document.activeElement).toBe(button("toggleBladeMode"));
      fireEvent.keyDown(toolbar, { key: "End" });
      expect(document.activeElement).toBe(button("toggleDisplayMode"));
      fireEvent.keyDown(toolbar, { key: "Home" });
      expect(document.activeElement).toBe(button("selectTool"));
    });

    it("clamps at the ends instead of wrapping", () => {
      render(<QuickActionsPanel geometry={geometry(400, 44)} />);
      const toolbar = screen.getByRole("toolbar");
      buttons()[0]?.focus();
      fireEvent.keyDown(toolbar, { key: "ArrowLeft" });
      expect(document.activeElement).toBe(button("selectTool"));
    });

    it("accepts the vertical arrows once the strip is a column", () => {
      render(<QuickActionsPanel geometry={geometry(44, 400)} />);
      const toolbar = screen.getByRole("toolbar");
      buttons()[0]?.focus();
      fireEvent.keyDown(toolbar, { key: "ArrowDown" });
      expect(document.activeElement).toBe(button("toggleBladeMode"));
    });
  });

  // Chromium maps the wheel to horizontal scrolling only under Shift, so a
  // horizontal strip must forward deltaY itself or it looks jammed.
  describe("wheel forwarding", () => {
    function overflowing(element: HTMLElement) {
      // jsdom reports every dimension as 0, so scrollLeft can't move on its
      // own — stub the scroll state the handler reads and writes.
      let scrollLeft = 0;
      Object.defineProperty(element, "scrollLeft", {
        configurable: true,
        get: () => scrollLeft,
        set: (value: number) => {
          scrollLeft = Math.max(0, Math.min(120, value));
        },
      });
    }

    it("turns vertical wheel into horizontal scroll when horizontal", () => {
      render(<QuickActionsPanel geometry={geometry(400, 44)} />);
      const toolbar = screen.getByRole("toolbar");
      overflowing(toolbar);
      fireEvent.wheel(toolbar, { deltaY: 40 });
      expect(toolbar.scrollLeft).toBe(40);
    });

    it("leaves the wheel alone when vertical", () => {
      render(<QuickActionsPanel geometry={geometry(44, 400)} />);
      const toolbar = screen.getByRole("toolbar");
      overflowing(toolbar);
      fireEvent.wheel(toolbar, { deltaY: 40 });
      expect(toolbar.scrollLeft).toBe(0);
    });

    it("leaves Shift+wheel to the browser", () => {
      render(<QuickActionsPanel geometry={geometry(400, 44)} />);
      const toolbar = screen.getByRole("toolbar");
      overflowing(toolbar);
      fireEvent.wheel(toolbar, { deltaY: 40, shiftKey: true });
      expect(toolbar.scrollLeft).toBe(0);
    });
  });
});
