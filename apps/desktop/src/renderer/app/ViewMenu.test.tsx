// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  }),
}));

vi.mock("../settings/appSettingsStore", () => ({
  useDisplayMode: () => "AbRoll",
  useMediaPoolDrawerOpen: () => false,
  toggleDisplayMode: vi.fn(),
  setMediaPoolDrawerOpen: vi.fn(),
}));

import { ViewMenu } from "./ViewMenu";
import {
  EMPTY_DOCK_WORKSPACE_SNAPSHOT,
  type DockWorkspaceController,
} from "../workspace/dockWorkspaceAdapter";

function controller(): DockWorkspaceController {
  return {
    getSnapshot: vi.fn(() => EMPTY_DOCK_WORKSPACE_SNAPSHOT),
    subscribe: vi.fn(() => () => {}),
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    closeActivePanel: vi.fn(),
    focusNextPanel: vi.fn(),
    focusPreviousPanel: vi.fn(),
    setHoveredPanel: vi.fn(),
    toggleMaximize: vi.fn(),
    restoreMaximizedPanel: vi.fn(),
    resetWorkspace: vi.fn(),
  };
}

describe("ViewMenu workspace controls", () => {
  it("focuses or reopens singleton Panels and exposes close/reset recovery", async () => {
    const workspaceController = controller();
    render(
      <ViewMenu
        workspaceController={workspaceController}
        workspaceSnapshot={{
          openPanels: new Set(["preview", "timeline"]),
          activePanel: "preview",
          maximizedPanel: null,
          empty: false,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /View/ }));
    fireEvent.click(await screen.findByText("Caption"));
    expect(workspaceController.openPanel).toHaveBeenCalledWith("caption");

    fireEvent.click(screen.getByRole("button", { name: /View/ }));
    fireEvent.click(await screen.findByText("Close Active Panel"));
    expect(workspaceController.closeActivePanel).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: /View/ }));
    fireEvent.click(await screen.findByText("Reset Workspace"));
    expect(workspaceController.resetWorkspace).toHaveBeenCalledOnce();
  });
});
