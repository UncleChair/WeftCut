// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ??
      ({
        "dock_workspace.panels.media": "Media Pool",
        "dock_workspace.panels.preview": "Preview",
        "dock_workspace.panels.timeline": "Timeline",
        "dock_workspace.panels.attribute": "Attribute",
        "dock_workspace.panels.caption": "Caption",
        "dock_workspace.panels.role-mixer": "Role Mixer",
        "dock_workspace.panels.effect": "Effect",
        "dock_workspace.panels.nearby": "Nearby",
      } as Record<string, string>)[key] ??
      key,
  }),
}));

const prefs = vi.hoisted(() => ({
  markersVisible: true,
  safeAreaGuides: false,
}));

vi.mock("../settings/appSettingsStore", () => ({
  useDisplayMode: () => "AbRoll",
  useFollowPlayheadEnabled: () => true,
  useMarkersVisible: () => prefs.markersVisible,
  useSafeAreaGuidesVisible: () => prefs.safeAreaGuides,
}));

vi.mock("../ipc", async (importActual) => ({
  ...(await importActual<typeof import("../ipc")>()),
  logEmit: vi.fn(() => Promise.resolve()),
}));

import { logEmit } from "../ipc";
import { registerCommandProvider, type CommandDef } from "../commands/registry";
import { ViewMenu, type ViewMenuWorkspaces } from "./ViewMenu";
import {
  EMPTY_DOCK_WORKSPACE_SNAPSHOT,
  type DockWorkspaceController,
} from "../workspace/dockWorkspaceAdapter";
import { EDITING_WORKSPACE_ID } from "../../shared/workspace";

const unregisters: Array<() => void> = [];

function provide(defs: CommandDef[]): void {
  unregisters.push(registerCommandProvider(() => defs));
}

afterEach(() => {
  cleanup();
  for (const un of unregisters.splice(0)) un();
  vi.mocked(logEmit).mockClear();
});

function controller(): DockWorkspaceController {
  return {
    getSnapshot: vi.fn(() => EMPTY_DOCK_WORKSPACE_SNAPSHOT),
    subscribe: vi.fn(() => () => {}),
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    closeActivePanel: vi.fn(),
    focusNextPanel: vi.fn(),
    focusPreviousPanel: vi.fn(),
    openTabsOverflowMenu: vi.fn(),
    setHoveredPanel: vi.fn(),
    toggleMaximize: vi.fn(),
    restoreMaximizedPanel: vi.fn(),
    resetWorkspace: vi.fn(),
    serialize: vi.fn(() => ({ version: 1, empty: true, dockview: null, placements: {} })),
    restore: vi.fn(() => true),
  };
}

function workspaceProfiles(
  overrides: Partial<ViewMenuWorkspaces> = {},
): ViewMenuWorkspaces {
  return {
    profiles: [
      { id: EDITING_WORKSPACE_ID, name: "Default Layout", isBuiltin: true },
      { id: "ws-1", name: "Cutting", isBuiltin: false },
    ],
    activeId: "ws-1",
    activeIsBuiltin: false,
    onSwitch: vi.fn(),
    onSave: vi.fn(),
    onSaveAs: vi.fn(),
    onReset: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

const openView = () =>
  fireEvent.click(screen.getByRole("button", { name: /View/ }));

// Workspace controls live one level down under the Workspaces submenu.
const openWorkspaces = async () => {
  openView();
  fireEvent.click(await screen.findByText("Workspaces"));
};

describe("ViewMenu workspace controls", () => {
  it("focuses or reopens singleton Panels and exposes close/reset recovery", async () => {
    const workspaceController = controller();
    render(
      <ViewMenu
        workspaceController={workspaceController}
        workspaceProfiles={null}
        workspaceSnapshot={{
          openPanels: new Set(["preview", "timeline"]),
          activePanel: "preview",
          maximizedPanel: null,
          empty: false,
        }}
      />,
    );

    openView();
    fireEvent.click(await screen.findByText("Caption"));
    expect(workspaceController.openPanel).toHaveBeenCalledWith("caption");

    openView();
    fireEvent.click(await screen.findByText("Media Pool"));
    expect(workspaceController.openPanel).toHaveBeenCalledWith("media");

    openView();
    fireEvent.click(await screen.findByText("Close Active Panel"));
    expect(workspaceController.closeActivePanel).toHaveBeenCalledOnce();

    // With no profiles wired yet, Reset falls back to the adapter's built-in rebuild.
    await openWorkspaces();
    fireEvent.click(await screen.findByText("Reset Workspace"));
    expect(workspaceController.resetWorkspace).toHaveBeenCalledOnce();
  });

  it("lists Default Layout + custom Workspaces and drives switch, save, save-as, rename, delete, reset", async () => {
    const profiles = workspaceProfiles();
    render(
      <ViewMenu
        workspaceController={controller()}
        workspaceProfiles={profiles}
        workspaceSnapshot={EMPTY_DOCK_WORKSPACE_SNAPSHOT}
      />,
    );

    // Both workspaces are listed; switching activates the other one.
    await openWorkspaces();
    expect(await screen.findByText("Cutting")).toBeTruthy(); // custom profile listed
    fireEvent.click(await screen.findByText("Default Layout"));
    expect(profiles.onSwitch).toHaveBeenCalledWith(EDITING_WORKSPACE_ID);

    await openWorkspaces();
    fireEvent.click(await screen.findByText("Save Workspace"));
    expect(profiles.onSave).toHaveBeenCalledOnce();

    await openWorkspaces();
    fireEvent.click(await screen.findByText("Save as New Workspace…"));
    expect(profiles.onSaveAs).toHaveBeenCalledOnce();

    await openWorkspaces();
    fireEvent.click(await screen.findByText("Rename Workspace…"));
    expect(profiles.onRename).toHaveBeenCalledWith("ws-1");

    await openWorkspaces();
    fireEvent.click(await screen.findByText("Delete Workspace"));
    expect(profiles.onDelete).toHaveBeenCalledWith("ws-1");

    // Reset now goes through the profiles API (restore the saved baseline).
    await openWorkspaces();
    fireEvent.click(await screen.findByText("Reset Workspace"));
    expect(profiles.onReset).toHaveBeenCalledOnce();
  });

  it("disables Save / Rename / Delete while the built-in Default Layout profile is active", async () => {
    const profiles = workspaceProfiles({ activeId: EDITING_WORKSPACE_ID, activeIsBuiltin: true });
    render(
      <ViewMenu
        workspaceController={controller()}
        workspaceProfiles={profiles}
        workspaceSnapshot={EMPTY_DOCK_WORKSPACE_SNAPSHOT}
      />,
    );

    await openWorkspaces();
    // Base UI renders disabled items with aria-disabled; clicks must be inert.
    for (const label of ["Save Workspace", "Rename Workspace…", "Delete Workspace"]) {
      const item = await screen.findByText(label);
      expect(item.closest('[aria-disabled="true"]')).not.toBeNull();
    }
    // Save As stays available on the built-in Workspace.
    expect(
      (await screen.findByText("Save as New Workspace…")).closest('[aria-disabled="true"]'),
    ).toBeNull();
  });
});

// The marker toggle sits with the other timeline view preferences, and is the
// one item here that carries no accelerator.
describe("ViewMenu marker display", () => {
  const renderMenu = () =>
    render(
      <ViewMenu
        workspaceController={controller()}
        workspaceProfiles={null}
        workspaceSnapshot={EMPTY_DOCK_WORKSPACE_SNAPSHOT}
      />,
    );

  afterEach(() => {
    prefs.markersVisible = true;
  });

  it("sits immediately below Follow playhead", async () => {
    renderMenu();
    openView();
    await screen.findByText("Show markers");
    // Read off the label spans, not the rows: a row's textContent also carries
    // its accelerator, and Follow playhead has one (`Shift+F`) where this
    // deliberately does not.
    const labels = screen
      .getAllByRole("menuitem")
      .map((item) => item.querySelector(".app-menu-item-label")?.textContent ?? "");
    expect(labels.indexOf("Show markers")).toBe(labels.indexOf("Follow playhead") + 1);
    expect(labels).toContain("Follow playhead");
  });

  it("flips the setting through the registry command and reflects it, both ways", async () => {
    const run = vi.fn();
    provide([
      {
        id: "toggleMarkersVisible",
        labelKey: "actions.toggle_markers_visible",
        run,
      },
    ]);
    renderMenu();
    openView();
    const item = await screen.findByText("Show markers");
    // Base UI puts the check glyph in the item's own leading slot.
    expect(
      item.closest('[role="menuitem"]')?.querySelector(".app-menu-item-check svg"),
    ).not.toBeNull();
    fireEvent.click(item);
    expect(run).toHaveBeenCalledOnce();

    cleanup();
    prefs.markersVisible = false;
    renderMenu();
    openView();
    const off = await screen.findByText("Show markers");
    expect(
      off.closest('[role="menuitem"]')?.querySelector(".app-menu-item-check svg"),
    ).toBeNull();
  });
});

// The preview's safe-area overlay: the same bindingless-toggle shape as the
// marker item, one row further down (it annotates the preview, not the
// timeline), and OFF by default.
describe("ViewMenu safe areas", () => {
  const renderMenu = () =>
    render(
      <ViewMenu
        workspaceController={controller()}
        workspaceProfiles={null}
        workspaceSnapshot={EMPTY_DOCK_WORKSPACE_SNAPSHOT}
      />,
    );

  afterEach(() => {
    prefs.safeAreaGuides = false;
  });

  it("sits immediately below Show markers, unchecked by default", async () => {
    renderMenu();
    openView();
    const item = await screen.findByText("Show safe areas");
    const labels = screen
      .getAllByRole("menuitem")
      .map((row) => row.querySelector(".app-menu-item-label")?.textContent ?? "");
    expect(labels.indexOf("Show safe areas")).toBe(labels.indexOf("Show markers") + 1);
    expect(
      item.closest('[role="menuitem"]')?.querySelector(".app-menu-item-check svg"),
    ).toBeNull();
  });

  it("flips the preference through the registry command and reflects it", async () => {
    const run = vi.fn();
    provide([
      {
        id: "toggleSafeAreaGuides",
        labelKey: "actions.toggle_safe_area_guides",
        run,
      },
    ]);
    prefs.safeAreaGuides = true;
    renderMenu();
    openView();
    const item = await screen.findByText("Show safe areas");
    expect(
      item.closest('[role="menuitem"]')?.querySelector(".app-menu-item-check svg"),
    ).not.toBeNull();
    fireEvent.click(item);
    expect(run).toHaveBeenCalledOnce();
  });
});

// The registry funnel: an item with a command form must log the same
// `Shortcut` row the chord would (commands/registry.ts).
describe("ViewMenu registry dispatch", () => {
  const renderMenu = () =>
    render(
      <ViewMenu
        workspaceController={controller()}
        workspaceProfiles={null}
        workspaceSnapshot={EMPTY_DOCK_WORKSPACE_SNAPSHOT}
      />,
    );

  it("dispatches a toggle through the registry: one run, one Shortcut row", async () => {
    const run = vi.fn();
    provide([
      {
        id: "toggleFollowPlayhead",
        actionId: "toggleFollowPlayhead",
        labelKey: "actions.toggle_follow_playhead",
        run,
      },
    ]);
    renderMenu();
    openView();

    fireEvent.click(await screen.findByText("Follow playhead"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(logEmit).toHaveBeenCalledTimes(1);
    expect(logEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        category: { kind: "Shortcut" },
        message: "Shortcut: toggleFollowPlayhead",
      }),
    );
  });

  it("an unregistered command id is a silent no-op (absent-id policy)", async () => {
    renderMenu();
    openView();

    // No provider registered: same stand-down as the native menu's absent-id
    // projection — no throw, no row.
    fireEvent.click(await screen.findByText("Show markers"));
    expect(logEmit).not.toHaveBeenCalled();
  });
});
