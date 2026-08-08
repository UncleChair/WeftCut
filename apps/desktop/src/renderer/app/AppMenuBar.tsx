import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { GlobeIcon, SearchIcon } from "lucide-react";

import { WindowControls } from "../components/WindowControls";
import { Menu, MenuBar, MenuItem } from "../menu/Menu";
import { CommandMenu } from "../menu/CommandMenu";
import { EDIT_MENU, FILE_MENU, INSERT_MENU } from "../menu/menuSpec";
import { resolveAccelerator } from "../shortcuts/match";
import { useEffectiveBindings } from "../shortcuts/bindings-context";
import {
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  type Locale,
} from "../i18n";
import { setLocale } from "../settings/appSettingsStore";
import { ViewMenu, type ViewMenuWorkspaces } from "./ViewMenu";
import { HelpMenu } from "./HelpMenu";
import { openPerformanceMonitor } from "../render/performanceMonitorWindow";
import type {
  DockWorkspaceController,
  DockWorkspaceSnapshot,
} from "../workspace/dockWorkspaceAdapter";

interface AppMenuBarProps {
  pong: string;
  /// Palette open lives here rather than in the registry — the palette
  /// deliberately excludes "open the palette" (appCommands.ts).
  onOpenSearch: () => void;
  onEnterAgentMode: () => void;
  workspaceController: DockWorkspaceController | null;
  workspaceSnapshot: DockWorkspaceSnapshot;
  workspaceProfiles: ViewMenuWorkspaces | null;
}

interface DevMenuProps {
  enabled?: boolean;
  onOpenPerformanceMonitor?: () => void;
}

/// Development diagnostics live behind their own dropdown so normal editor
/// chrome stays free of diagnostic controls. `import.meta.env.DEV` is static at
/// build time, so the entire trigger and entry are absent from release builds.
export function DevMenu({
  enabled = import.meta.env.DEV,
  onOpenPerformanceMonitor = () => {
    void openPerformanceMonitor().catch((error) => {
      console.error("[weftcut/performance-monitor] failed to open:", error);
    });
  },
}: DevMenuProps) {
  const { t } = useTranslation();
  if (!enabled) return null;
  return (
    <Menu label={t("dev.menu")}>
      <MenuItem
        label={t("dev.performance_monitor")}
        onSelect={onOpenPerformanceMonitor}
      />
    </Menu>
  );
}

/// The frameless-window header: app title, menu bar, core-status pill,
/// locale toggle, window controls. Pure chrome — the File/Edit/Insert
/// dropdowns are `menuSpec.ts` projected through the command registry
/// (labels, handlers, enabled/checked state and shortcut hints all come
/// from the catalog), so no project state is read here. Locale cycling
/// lives here because it only touches i18n.
export function AppMenuBar({
  pong,
  onOpenSearch,
  onEnterAgentMode,
  workspaceController,
  workspaceSnapshot,
  workspaceProfiles,
}: AppMenuBarProps) {
  const { t, i18n } = useTranslation();

  // The header search button shows the *effective* palette binding, so a
  // user remap in Settings → Keyboard is reflected here immediately.
  const searchBinding = useEffectiveBindings("openSearchPalette");
  const searchAccelerator = searchBinding
    ? resolveAccelerator(searchBinding)
    : "";

  const cycleLocale = useCallback(() => {
    const current = i18n.language as Locale;
    const idx = SUPPORTED_LOCALES.indexOf(current);
    const next =
      SUPPORTED_LOCALES[(idx + 1) % SUPPORTED_LOCALES.length] ?? "en-US";
    // Persists to app_settings.json AND switches i18next (see setLocale).
    setLocale(next);
  }, [i18n]);

  return (
    /* Frameless window: the header doubles as the title bar. The
       drag-region attribute only fires when the mousedown target IS
       the carrying element, so it sits on the header AND its
       non-interactive children — menus and buttons stay clickable. */
    <header className="app-header" data-drag-region>
      <div className="header-left" data-drag-region>
        {/* Logo + wordmark hug each other as one brand group; .header-left's
            16px gap then separates the group from the menus. Decorative image
            (aria-hidden) — the <h1> carries the accessible name. The
            data-drag-region keeps the mark part of the window drag handle. */}
        <span className="app-brand" data-drag-region>
          <img
            className="app-header-logo"
            src="./icons/icon.svg"
            alt=""
            aria-hidden
            width={18}
            height={18}
            data-drag-region
          />
          <h1 data-drag-region>{t("app.title")}</h1>
        </span>
        <MenuBar>
          <CommandMenu section={FILE_MENU} />
          <CommandMenu section={EDIT_MENU} />

          <ViewMenu
            workspaceController={workspaceController}
            workspaceSnapshot={workspaceSnapshot}
            workspaceProfiles={workspaceProfiles}
            onEnterAgentMode={onEnterAgentMode}
          />

          <CommandMenu section={INSERT_MENU} />

          <HelpMenu />

          <DevMenu />
        </MenuBar>
      </div>
      {/* Spotlight-style entry: a button skinned as an input box, pushed
          against the right header group by an auto left margin (see
          .header-search in misc.css). No data-drag-region — it must
          stay clickable. */}
      <button
        type="button"
        className="header-search"
        onClick={onOpenSearch}
        aria-label={t("actions.open_search")}
      >
        <SearchIcon size={12} aria-hidden />
        <span className="header-search-label">{t("actions.search")}</span>
        {searchAccelerator && (
          <kbd className="header-search-kbd" aria-hidden>
            {searchAccelerator}
          </kbd>
        )}
      </button>
      <div className="header-right" data-drag-region>
        {pong !== "ok" && pong !== "…" && (
          <span className="ping" data-drag-region>
            {t("app.core_status", { status: pong })}
          </span>
        )}
        <button
          type="button"
          className="locale-toggle"
          onClick={cycleLocale}
          title={t("language.switch_label")}
          aria-label={t("language.switch_label")}
        >
          <GlobeIcon className="globe-icon" size={14} aria-hidden />
          <span className="locale-toggle-label">
            {LOCALE_LABELS[(i18n.resolvedLanguage ?? "en-US") as Locale] ??
              "English"}
          </span>
        </button>
        <WindowControls />
      </div>
    </header>
  );
}
