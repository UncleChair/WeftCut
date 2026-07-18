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
import type { WorkspaceProfileInfo } from "../workspace/useWorkspacePersistence";

/// The View-menu Workspace controls, backed by the app-level Workspace document
/// (main-process store). The active-profile operations (Save / Rename / Delete)
/// are disabled for the immutable built-in Editing profile; Save As is always
/// available. Save As + Rename raise a name dialog owned by App, so their menu
/// handlers take no name here.
export interface ViewMenuWorkspaces {
  profiles: WorkspaceProfileInfo[];
  activeId: string;
  /** True when the active profile is the immutable built-in Editing profile. */
  activeIsBuiltin: boolean;
  onSwitch: (id: string) => void;
  onSave: () => void;
  onSaveAs: () => void;
  onReset: () => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
}

/// The View menu — Workspace profiles (switch / save / save-as / rename /
/// delete / reset), Panel recovery (open/focus/close), and the A/B-roll vs
/// Show-All track-display radio. The display setting is the same one the inline
/// pill + `T` shortcut drive; the checkmark reads the app-pref store so it stays
/// in sync however it changed.
interface ViewMenuProps {
  workspaceController: DockWorkspaceController | null;
  workspaceSnapshot: DockWorkspaceSnapshot;
  workspaceProfiles: ViewMenuWorkspaces | null;
}

export function ViewMenu({
  workspaceController,
  workspaceSnapshot,
  workspaceProfiles,
}: ViewMenuProps) {
  const { t } = useTranslation();
  const mode = useDisplayMode();
  // Reset is a Workspace op (restore the active profile's saved baseline) when
  // profiles are wired; before they load it falls back to the adapter's built-in
  // rebuild so recovery is never dead.
  const onReset =
    workspaceProfiles?.onReset ??
    (workspaceController ? () => workspaceController.resetWorkspace() : undefined);
  return (
    <Menu label={t("menu.view", { defaultValue: "View" })}>
      <MenuHeading
        label={t("view.workspaces_heading", { defaultValue: "Workspaces" })}
      />
      {(workspaceProfiles?.profiles ?? []).map((profile) => (
        <MenuItem
          key={profile.id}
          label={
            profile.isBuiltin
              ? t("view.workspace_editing", { defaultValue: "Editing" })
              : profile.name
          }
          checked={profile.id === workspaceProfiles?.activeId}
          onSelect={() => workspaceProfiles?.onSwitch(profile.id)}
        />
      ))}
      <MenuItem
        label={t("view.save_workspace", { defaultValue: "Save Workspace" })}
        disabled={!workspaceProfiles || workspaceProfiles.activeIsBuiltin}
        onSelect={() => workspaceProfiles?.onSave()}
      />
      <MenuItem
        label={t("view.save_workspace_as", {
          defaultValue: "Save Workspace As…",
        })}
        disabled={!workspaceProfiles}
        onSelect={() => workspaceProfiles?.onSaveAs()}
      />
      <MenuItem
        label={t("view.rename_workspace", { defaultValue: "Rename Workspace…" })}
        disabled={!workspaceProfiles || workspaceProfiles.activeIsBuiltin}
        onSelect={() => {
          if (workspaceProfiles) workspaceProfiles.onRename(workspaceProfiles.activeId);
        }}
      />
      <MenuItem
        label={t("view.delete_workspace", { defaultValue: "Delete Workspace" })}
        disabled={!workspaceProfiles || workspaceProfiles.activeIsBuiltin}
        onSelect={() => {
          if (workspaceProfiles) workspaceProfiles.onDelete(workspaceProfiles.activeId);
        }}
      />
      <MenuItem
        label={t("view.reset_workspace", { defaultValue: "Reset Workspace" })}
        disabled={!onReset}
        onSelect={() => onReset?.()}
      />
      <MenuSeparator />
      <MenuHeading
        label={t("view.panels_heading", { defaultValue: "Panels" })}
      />
      {PANEL_KINDS.map((kind) => (
        <MenuItem
          key={kind}
          label={t(PANEL_REGISTRY[kind].titleKey)}
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
