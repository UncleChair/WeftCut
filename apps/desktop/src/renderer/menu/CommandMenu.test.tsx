// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Real i18n (same side-effect import AppMenuBar pulls in): the assertions
// below run against the en-US strings, so a missing key fails here.
import "../i18n";
import {
  registerCommandProvider,
  type CommandDef,
} from "../commands/registry";
import { CommandMenu } from "./CommandMenu";
import type { MenuSection } from "./menuSpec";

// A real-id section (the entry type is locked to the command-id union). The
// provider below deliberately omits `redo` to exercise the absent-id policy.
const SECTION: MenuSection = {
  titleKey: "menu.edit",
  entries: [
    "undo",
    "redo",
    "---",
    "selectTool",
    { id: "openMotifPicker", hintKey: "actions.motifs_hint" },
  ],
};

const unregisters: Array<() => void> = [];

function provide(defs: CommandDef[]): void {
  unregisters.push(registerCommandProvider(() => defs));
}

afterEach(() => {
  cleanup();
  for (const un of unregisters.splice(0)) un();
});

async function openMenu(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
  await screen.findByRole("menu");
}

describe("CommandMenu", () => {
  it("projects registry commands: label, disabled, checked, accelerator, hint", async () => {
    provide([
      {
        id: "undo",
        actionId: "undo",
        labelKey: "actions.undo",
        enabled: () => false,
        run: () => {},
      },
      {
        id: "selectTool",
        actionId: "selectTool",
        labelKey: "actions.select_tool",
        checked: () => true,
        run: () => {},
      },
      { id: "openMotifPicker", labelKey: "actions.motifs", run: () => {} },
    ]);
    render(<CommandMenu section={SECTION} />);
    await openMenu();

    // Label from the catalog's labelKey; disabled from the enabled() gate.
    const undo = screen.getByText("Undo").closest('[role="menuitem"]')!;
    expect(undo.getAttribute("aria-disabled")).toBe("true");
    // Accelerator derives from the effective binding for the actionId
    // (catalogue default Mod+Z; jsdom is not macOS, hence text form).
    expect(undo.textContent).toContain("Ctrl+Z");

    // checked() renders the check glyph.
    const tool = screen.getByText("Selection tool").closest('[role="menuitem"]')!;
    expect(tool.querySelector(".app-menu-item-check svg")).not.toBeNull();

    // Object-form entries carry a tooltip; ids without one carry none.
    const motifs = screen.getByText("Motifs…").closest('[role="menuitem"]')!;
    expect(motifs.getAttribute("title")).toBeTruthy();
    expect(undo.getAttribute("title")).toBeNull();

    // "---" renders a separator row.
    expect(screen.getByRole("separator")).not.toBeNull();

    // `redo` is in the spec but not registered: omitted, not disabled —
    // same policy as the native menu's absent-id projection.
    expect(screen.queryByText("Redo")).toBeNull();
  });

  it("runs the command on activation", async () => {
    const run = vi.fn();
    provide([{ id: "openMotifPicker", labelKey: "actions.motifs", run }]);
    render(<CommandMenu section={SECTION} />);
    await openMenu();

    fireEvent.click(screen.getByText("Motifs…"));
    expect(run).toHaveBeenCalledOnce();
  });

  it("fills in when a provider registers after first render", async () => {
    render(<CommandMenu section={SECTION} />);
    await openMenu();
    expect(screen.queryByText("Undo")).toBeNull();

    // App's provider lands in a post-paint effect; the registry
    // subscription must re-render the open menu when it arrives.
    act(() => {
      provide([
        { id: "undo", actionId: "undo", labelKey: "actions.undo", run: () => {} },
      ]);
    });
    expect(screen.getByText("Undo")).not.toBeNull();
  });
});
