// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

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

vi.mock("../settings/appSettingsStore", () => ({
  useDisplayMode: () => "AbRoll",
  toggleDisplayMode: vi.fn(),
}));

import { ViewMenu, type ViewMenuWorkspaces } from "./ViewMenu";
import {
  EMPTY_DOCK_WORKSPACE_SNAPSHOT,
  type DockWorkspaceController,
} from "../workspace/dockWorkspaceAdapter";
import { EDITING_WORKSPACE_ID } from "../../shared/workspace";

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
        onEnterAgentMode={vi.fn()}
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
        onEnterAgentMode={vi.fn()}
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
        onEnterAgentMode={vi.fn()}
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
