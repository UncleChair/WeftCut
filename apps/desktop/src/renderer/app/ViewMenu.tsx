import { useTranslation } from "react-i18next";

import { Menu, MenuHeading, MenuItem, MenuSeparator, SubMenu } from "../menu/Menu";
import {
  toggleDisplayMode,
  toggleFollowPlayhead,
  toggleMarkersVisible,
  useDisplayMode,
  useFollowPlayheadEnabled,
  useMarkersVisible,
} from "../settings/appSettingsStore";
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
/// are disabled for the immutable built-in Default Layout profile; Save As is
/// always available. Save As + Rename raise a name dialog owned by App, so
/// their menu handlers take no name here.
export interface ViewMenuWorkspaces {
  profiles: WorkspaceProfileInfo[];
  activeId: string;
  /** True when the active profile is the immutable built-in Default Layout profile. */
  activeIsBuiltin: boolean;
  onSwitch: (id: string) => void;
  onSave: () => void;
  onSaveAs: () => void;
  onReset: () => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
}

/// The View menu — Panels (open/focus/close) flat at the top, Workspace
/// profiles + management under the Workspaces submenu (low-frequency ops stay
/// one level down), then the A/B-roll vs Show-All track-display radio, the
/// follow-playhead and marker-display toggles, and the Agent-mode entry. Every
/// checkmark here reads the app-pref store, so it stays in sync however the
/// value changed — whether from `T` / `Shift+F`, the Quick Actions strip, or the
/// search palette.
interface ViewMenuProps {
  workspaceController: DockWorkspaceController | null;
  workspaceSnapshot: DockWorkspaceSnapshot;
  workspaceProfiles: ViewMenuWorkspaces | null;
  /// Local agent-mode entry. While a session is active the whole menu bar
  /// is swapped out for AgentMode, so this item is the enter path only —
  /// exit stays on AgentMode's "Exit to editor" button.
  onEnterAgentMode: () => void;
}

export function ViewMenu({
  workspaceController,
  workspaceSnapshot,
  workspaceProfiles,
  onEnterAgentMode,
}: ViewMenuProps) {
  const { t } = useTranslation();
  const mode = useDisplayMode();
  const followPlayhead = useFollowPlayheadEnabled();
  const markersVisible = useMarkersVisible();
  // Reset is a Workspace op (restore the active profile's saved baseline) when
  // profiles are wired; before they load it falls back to the adapter's built-in
  // rebuild so recovery is never dead.
  const onReset =
    workspaceProfiles?.onReset ??
    (workspaceController ? () => workspaceController.resetWorkspace() : undefined);
  return (
    <Menu label={t("menu.view", { defaultValue: "View" })}>
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
      <SubMenu
        label={t("view.workspaces_heading", { defaultValue: "Workspaces" })}
      >
        {(workspaceProfiles?.profiles ?? []).map((profile) => (
          <MenuItem
            key={profile.id}
            label={
              profile.isBuiltin
                ? t("view.workspace_editing", { defaultValue: "Default Layout" })
                : profile.name
            }
            checked={profile.id === workspaceProfiles?.activeId}
            onSelect={() => workspaceProfiles?.onSwitch(profile.id)}
          />
        ))}
        <MenuSeparator />
        <MenuItem
          label={t("view.save_workspace", { defaultValue: "Save Workspace" })}
          disabled={!workspaceProfiles || workspaceProfiles.activeIsBuiltin}
          onSelect={() => workspaceProfiles?.onSave()}
        />
        <MenuItem
          label={t("view.save_workspace_as", {
            defaultValue: "Save as New Workspace…",
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
        {/* Reset is layout recovery, not profile management — and the only op
            available on the built-in profile — so it sits below its own
            separator. */}
        <MenuSeparator />
        <MenuItem
          label={t("view.reset_workspace", { defaultValue: "Reset Workspace" })}
          disabled={!onReset}
          onSelect={() => onReset?.()}
        />
      </SubMenu>
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
      <MenuSeparator />
      <MenuItem
        actionId="toggleFollowPlayhead"
        label={t("view.follow_playhead", {
          defaultValue: "Follow playhead",
        })}
        checked={followPlayhead}
        onSelect={() => void toggleFollowPlayhead()}
      />
      {/* Directly below Follow playhead, and with no `actionId`: the marker
          toggle has no binding on purpose (`M` is reserved for
          add-marker-at-playhead), so there is no accelerator to right-align. */}
      <MenuItem
        label={t("view.show_markers", { defaultValue: "Show markers" })}
        checked={markersVisible}
        onSelect={() => void toggleMarkersVisible()}
      />
      <MenuSeparator />
      <MenuItem
        label={t("view.enter_agent_mode", { defaultValue: "Enter Agent Mode" })}
        onSelect={onEnterAgentMode}
      />
    </Menu>
  );
}
