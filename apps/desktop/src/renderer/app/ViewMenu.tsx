import { useTranslation } from "react-i18next";

import { Menu, MenuHeading, MenuItem, MenuSeparator } from "../menu/Menu";
import { toggleDisplayMode, useDisplayMode } from "../settings/appSettingsStore";
import {
  PANEL_KINDS,
  PANEL_REGISTRY,
} from "../workspace/panelRegistry";
import type {
  DockWorkspaceController,
  DockWorkspaceSnapshot,
} from "../workspace/dockWorkspaceAdapter";

/// `docs/data-model.md` R.8: View menu — radio between A/B-roll and
/// Show-All. Same setting the inline pill + `T` shortcut drive. Reads
/// the current value from the app-pref store so the checkmark stays in
/// sync regardless of how it changed.
interface ViewMenuProps {
  workspaceController: DockWorkspaceController | null;
  workspaceSnapshot: DockWorkspaceSnapshot;
}

export function ViewMenu({
  workspaceController,
  workspaceSnapshot,
}: ViewMenuProps) {
  const { t } = useTranslation();
  const mode = useDisplayMode();
  return (
    <Menu label={t("menu.view", { defaultValue: "View" })}>
      <MenuHeading
        label={t("view.panels_heading", { defaultValue: "Panels" })}
      />
      {PANEL_KINDS.map((kind) => (
        <MenuItem
          key={kind}
          label={PANEL_REGISTRY[kind].title}
          checked={workspaceSnapshot.openPanels.has(kind)}
          disabled={!workspaceController}
          onSelect={() => workspaceController?.openPanel(kind)}
        />
      ))}
      <MenuItem
        label={t("view.close_active_panel", {
          defaultValue: "Close Active Panel",
        })}
        disabled={!workspaceController || workspaceSnapshot.activePanel === null}
        onSelect={() => workspaceController?.closeActivePanel()}
      />
      <MenuItem
        label={t("view.reset_workspace", { defaultValue: "Reset Workspace" })}
        disabled={!workspaceController}
        onSelect={() => workspaceController?.resetWorkspace()}
      />
      <MenuSeparator />
      <MenuHeading
        label={t("view.display_mode_heading", {
          defaultValue: "Track display",
        })}
      />
      <MenuItem
        actionId="toggleDisplayMode"
        label={t("view.display_ab", {
          defaultValue: "Display: A/B Roll only",
        })}
        checked={mode === "AbRoll"}
        onSelect={() => {
          if (mode !== "AbRoll") void toggleDisplayMode();
        }}
      />
      <MenuItem
        label={t("view.display_all", {
          defaultValue: "Display: Show all tracks",
        })}
        checked={mode === "ShowAll"}
        onSelect={() => {
          if (mode !== "ShowAll") void toggleDisplayMode();
        }}
      />
    </Menu>
  );
}
