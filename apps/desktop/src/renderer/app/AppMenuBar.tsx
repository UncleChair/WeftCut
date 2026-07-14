import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { GlobeIcon } from "lucide-react";

import { WindowControls } from "../components/WindowControls";
import {
  Menu,
  MenuBar,
  MenuItem,
  MenuSeparator,
} from "../menu/Menu";
import {
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  type Locale,
} from "../i18n";
import { ViewMenu } from "./ViewMenu";

interface AppMenuBarProps {
  busy: boolean;
  pong: string;
  canUndo: boolean;            // !!summary?.history.can_undo
  canRedo: boolean;            // !!summary?.history.can_redo
  canBlade: boolean;           // !!summary && summary.layer_count > 0
  exportLocked: boolean;       // busy || exportState.kind is starting|progress
  onImportMedia: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onSaveAndClose: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleBladeMode: () => void;
  onAddColorLayer: () => void;
  onAddTextLayer: () => void;
  onOpenMotifPicker: () => void;
  onOpenExport: () => void;
  onOpenConnect: () => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
}

/// The frameless-window header: app title, menu bar, core-status pill,
/// locale toggle, window controls. Pure chrome — every menu action
/// arrives as an `on*` prop and the `disabled` flags come pre-derived
/// from App (`canUndo`/`canRedo`/`canBlade`/`exportLocked`), so no
/// project state is read here. Locale cycling lives here because it
/// only touches i18n.
export function AppMenuBar({
  busy,
  pong,
  canUndo,
  canRedo,
  canBlade,
  exportLocked,
  onImportMedia,
  onSave,
  onSaveAs,
  onSaveAndClose,
  onUndo,
  onRedo,
  onToggleBladeMode,
  onAddColorLayer,
  onAddTextLayer,
  onOpenMotifPicker,
  onOpenExport,
  onOpenConnect,
  onOpenSettings,
  onOpenSearch,
}: AppMenuBarProps) {
  const { t, i18n } = useTranslation();

  const cycleLocale = useCallback(() => {
    const current = i18n.language as Locale;
    const idx = SUPPORTED_LOCALES.indexOf(current);
    const next =
      SUPPORTED_LOCALES[(idx + 1) % SUPPORTED_LOCALES.length] ?? "en-US";
    i18n.changeLanguage(next);
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
          <Menu label={t("menu.file")}>
            <MenuItem
              actionId="importMedia"
              label={t("actions.import_media")}
              onSelect={onImportMedia}
              disabled={busy}
            />
            <MenuSeparator />
            <MenuItem
              actionId="save"
              label={t("actions.save")}
              onSelect={onSave}
              disabled={busy}
            />
            <MenuItem
              actionId="saveAs"
              label={t("actions.save_as")}
              onSelect={onSaveAs}
              disabled={busy}
            />
            <MenuSeparator />
            <MenuItem
              actionId="closeProject"
              label={t("actions.save_and_close")}
              hint={t("actions.save_and_close_hint")}
              onSelect={onSaveAndClose}
              disabled={busy}
            />
          </Menu>

          <Menu label={t("menu.edit")}>
            <MenuItem
              actionId="undo"
              label={t("actions.undo")}
              onSelect={onUndo}
              disabled={busy || !canUndo}
            />
            <MenuItem
              actionId="redo"
              label={t("actions.redo")}
              onSelect={onRedo}
              disabled={busy || !canRedo}
            />
            <MenuSeparator />
            <MenuItem
              actionId="toggleBladeMode"
              label={t("actions.toggle_blade_mode")}
              onSelect={onToggleBladeMode}
              disabled={busy || !canBlade}
            />
          </Menu>

          <ViewMenu />


          <Menu label={t("menu.insert")}>
            <MenuItem
              label={t("actions.add_color_layer")}
              onSelect={onAddColorLayer}
            />
            <MenuItem
              label={t("actions.add_text_layer")}
              onSelect={onAddTextLayer}
            />
            <MenuItem
              label={t("actions.motifs")}
              hint={t("actions.motifs_hint")}
              onSelect={onOpenMotifPicker}
            />
          </Menu>

          <Menu label={t("menu.export")}>
            <MenuItem
              actionId="export"
              label={t("actions.export")}
              onSelect={onOpenExport}
              disabled={exportLocked}
            />
          </Menu>

          <Menu label={t("menu.tools")}>
            <MenuItem
              label={t("actions.connect_agent")}
              hint={t("actions.connect_agent_hint")}
              onSelect={onOpenConnect}
            />
            <MenuItem
              actionId="openSearchPalette"
              label={t("actions.open_search")}
              onSelect={onOpenSearch}
            />
            <MenuSeparator />
            <MenuItem
              label={t("actions.settings")}
              hint={t("actions.settings_hint")}
              onSelect={onOpenSettings}
            />
          </Menu>
        </MenuBar>
      </div>
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
