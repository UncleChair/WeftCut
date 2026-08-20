// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../i18n";

const settings = vi.hoisted(() => ({
  displayMode: "AbRoll" as "AbRoll" | "ShowAll",
  markersVisible: true,
}));

vi.mock("../settings/appSettingsStore", () => ({
  useDisplayMode: () => settings.displayMode,
  useMarkersVisible: () => settings.markersVisible,
}));

vi.mock("../ipc", async (importActual) => ({
  ...(await importActual<typeof import("../ipc")>()),
  logEmit: vi.fn(() => Promise.resolve()),
}));

import { logEmit } from "../ipc";
import { registerCommandProvider, type CommandDef } from "../commands/registry";
import { setTool, useToolStore } from "../state/toolStore";
import {
  clearRange,
  hasMarkedRange,
  setRangeIn,
  useRangeStore,
} from "../state/rangeStore";
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
  settings.markersVisible = true;
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

  it("runs the registry command behind a button and logs one Shortcut row", () => {
    vi.mocked(logEmit).mockClear();
    render(<QuickActionsPanel geometry={geometry(400, 44)} />);
    fireEvent.click(button("toggleBladeMode"));
    expect(runs).toEqual(["toggleBladeMode"]);
    // The strip is a command surface: a button press must log exactly like
    // the chord that would have run it (registry funnel).
    expect(logEmit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logEmit).mock.calls[0]![0]).toMatchObject({
      category: { kind: "Shortcut" },
      message: "Shortcut: toggleBladeMode",
    });
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

  // The state-bearing glyph has to survive the trip through `resolveIcon` into
  // the DOM — a catalogue-only test would still pass if the panel had kept
  // rendering the static `icon`.
  it("renders the folded glyph pressed and the unfolded one unpressed", () => {
    const glyphClasses = () =>
      button("toggleDisplayMode").querySelector("svg")?.classList;
    render(<QuickActionsPanel geometry={geometry(400, 44)} />);
    expect(glyphClasses()?.contains("lucide-fold-vertical")).toBe(true);
    cleanup();
    settings.displayMode = "ShowAll";
    render(<QuickActionsPanel geometry={geometry(400, 44)} />);
    expect(glyphClasses()?.contains("lucide-unfold-vertical")).toBe(true);
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

    // Docked, the shape is not the authority: a bar beside the Timeline gets a
    // wide, short cell and still has to run as a column, because width is the
    // only axis its splitter moves.
    it("runs the way it is docked, however its own box is shaped", () => {
      const geo = geometry(718, 210);
      render(<QuickActionsPanel geometry={geo} docked="vertical" />);
      expect(screen.getByRole("toolbar").dataset.orientation).toBe("vertical");
      geo.resize(1_000, 44);
      expect(screen.getByRole("toolbar").dataset.orientation).toBe("vertical");
    });

    // Without a deadband, resizing through square would flip the axis on every
    // frame. Only reachable with no dock position to read.
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

  // The in/out section is the strip's first `command` section: momentary
  // actions, no pressed state. Registered separately so the authored-order and
  // button-count cases above keep describing the stateful sections alone.
  describe("in/out section", () => {
    let unregisterRange: (() => void) | null = null;

    beforeEach(() => {
      useRangeStore.setState({ inUs: null, outUs: null });
      const defs: CommandDef[] = [
        { id: "markIn", actionId: "markIn", labelKey: "actions.mark_in", run: () => {
          runs.push("markIn");
          setRangeIn(1_000_000);
        } },
        { id: "markOut", actionId: "markOut", labelKey: "actions.mark_out", run: () => {
          runs.push("markOut");
        } },
        {
          id: "clearRange",
          actionId: "clearRange",
          labelKey: "actions.clear_range",
          // Mirrors `appCommands.ts` — the point of the case below is that the
          // live store read reaches the rendered button.
          enabled: () => hasMarkedRange(),
          run: () => {
            runs.push("clearRange");
            clearRange();
          },
        },
      ];
      unregisterRange = registerCommandProvider(() => defs);
    });

    afterEach(() => {
      unregisterRange?.();
      unregisterRange = null;
      useRangeStore.setState({ inUs: null, outUs: null });
    });

    // A one-shot action carrying `aria-pressed` would be narrated as an off
    // switch — a state it does not have. That is what `mode: "command"` buys.
    it("reports no pressed or checked state", () => {
      render(<QuickActionsPanel geometry={geometry(400, 44)} />);
      for (const id of ["markIn", "markOut", "clearRange"]) {
        expect(button(id).getAttribute("role")).not.toBe("radio");
        expect(button(id).hasAttribute("aria-pressed")).toBe(false);
        expect(button(id).hasAttribute("aria-checked")).toBe(false);
      }
    });

    it("marks the in point from the strip", () => {
      render(<QuickActionsPanel geometry={geometry(400, 44)} />);
      fireEvent.click(button("markIn"));
      expect(runs).toEqual(["markIn"]);
      expect(hasMarkedRange()).toBe(true);
    });

    // The subscription is load-bearing: `enabled` is evaluated during render,
    // so without it the button would stay greyed out until something unrelated
    // re-rendered the strip.
    it("enables Clear as soon as a range exists", () => {
      render(<QuickActionsPanel geometry={geometry(400, 44)} />);
      expect(button("clearRange").disabled).toBe(true);
      fireEvent.click(button("markIn"));
      expect(button("clearRange").disabled).toBe(false);
      fireEvent.click(button("clearRange"));
      expect(button("clearRange").disabled).toBe(true);
    });

    it("explains why Clear is unavailable, then names the action", () => {
      render(<QuickActionsPanel geometry={geometry(400, 44)} />);
      expect(button("clearRange").getAttribute("aria-label")).toBe(
        "No in/out points marked",
      );
      fireEvent.click(button("markIn"));
      expect(button("clearRange").getAttribute("aria-label")).toBe(
        "Clear in/out points",
      );
    });

    // The whole discoverability argument for putting in/out on the strip: the
    // button teaches the key.
    it("teaches the I / O bindings through the tooltip", () => {
      render(<QuickActionsPanel geometry={geometry(400, 44)} />);
      expect(button("markIn").title).toContain("I");
      expect(button("markOut").title).toContain("O");
    });
  });

  // A button whose command carries no binding, so its tooltip has no
  // accelerator half. Registered separately so the authored-order case above
  // keeps describing the buttons it already covers.
  describe("marker toggle", () => {
    let unregisterMarkers: (() => void) | null = null;

    beforeEach(() => {
      unregisterMarkers = registerCommandProvider(() => [
        {
          id: "toggleMarkersVisible",
          labelKey: "actions.toggle_markers_visible",
          run: () => {
            runs.push("toggleMarkersVisible");
          },
        },
      ]);
    });

    afterEach(() => {
      unregisterMarkers?.();
      unregisterMarkers = null;
    });

    it("runs the command and reports pressed state while markers show", () => {
      render(<QuickActionsPanel geometry={geometry(400, 44)} />);
      expect(button("toggleMarkersVisible").getAttribute("aria-pressed")).toBe("true");
      expect(button("toggleMarkersVisible").dataset.active).toBe("true");
      fireEvent.click(button("toggleMarkersVisible"));
      expect(runs).toEqual(["toggleMarkersVisible"]);
    });

    it("reads as unpressed once the markers are hidden", () => {
      settings.markersVisible = false;
      render(<QuickActionsPanel geometry={geometry(400, 44)} />);
      expect(button("toggleMarkersVisible").getAttribute("aria-pressed")).toBe("false");
      expect(button("toggleMarkersVisible").dataset.active).toBe("false");
    });

    it("states the current state and what a click will do, both ways", () => {
      render(<QuickActionsPanel geometry={geometry(400, 44)} />);
      expect(button("toggleMarkersVisible").getAttribute("aria-label")).toBe(
        "Showing timeline markers. Click to hide.",
      );
      cleanup();
      settings.markersVisible = false;
      render(<QuickActionsPanel geometry={geometry(400, 44)} />);
      expect(button("toggleMarkersVisible").getAttribute("aria-label")).toBe(
        "Timeline markers hidden. Click to show.",
      );
    });

    // The command has no action id, so the effective-binding lookup returns
    // nothing for it and the tooltip must be the hint alone — never a trailing
    // empty "( )".
    it("shows no accelerator in its tooltip", () => {
      render(<QuickActionsPanel geometry={geometry(400, 44)} />);
      expect(button("toggleMarkersVisible").title).toBe(
        "Showing timeline markers. Click to hide.",
      );
    });
  });

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
