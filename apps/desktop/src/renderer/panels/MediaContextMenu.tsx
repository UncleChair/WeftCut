import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CircleDotIcon, CircleIcon } from "lucide-react";

import type { MediaSummary } from "../ipc";

export type MediaProxyMode = "auto" | "proxy" | "original";

const PROXY_MODES: readonly MediaProxyMode[] = [
  "auto",
  "proxy",
  "original",
];

function MenuItemContent({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <>
      <span className="app-menu-item-check" aria-hidden="true" />
      <span className="app-menu-item-label">{children}</span>
    </>
  );
}

/// The single home for media-pool actions. It uses the same virtual-anchor
/// Base UI menu as timeline layers: right-click coordinates determine
/// placement, while Base UI owns outside-click, Escape, arrow navigation and
/// typeahead. Add future per-media commands here rather than putting controls
/// back on the cards.
export function MediaContextMenu({
  x,
  y,
  media,
  proxyMode,
  canSetProxy,
  canAnalyze,
  analyzing,
  canRemove,
  onClose,
  onProxyModeChange,
  onAnalyze,
  onRemove,
}: {
  x: number;
  y: number;
  media: MediaSummary;
  proxyMode: MediaProxyMode | null;
  canSetProxy: boolean;
  canAnalyze: boolean;
  analyzing: boolean;
  canRemove: boolean;
  onClose: () => void;
  onProxyModeChange: (mode: MediaProxyMode) => void;
  onAnalyze: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const anchor = useMemo(
    () => ({
      getBoundingClientRect: () => ({
        x,
        y,
        top: y,
        left: x,
        right: x,
        bottom: y,
        width: 0,
        height: 0,
      }),
    }),
    [x, y],
  );

  return (
    <MenuPrimitive.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={0}
          className="app-popup-positioner"
        >
          <MenuPrimitive.Popup
            className="app-menu-list media-context-menu"
            aria-label={t("media_pool.actions_for", { label: media.label })}
          >
            {proxyMode !== null && (
              <>
                <div className="menu-heading" role="presentation">
                  {t("media_pool.proxy_heading")}
                </div>
                <MenuPrimitive.RadioGroup
                  className="media-proxy-radio-group"
                  value={proxyMode}
                  disabled={!canSetProxy}
                  onValueChange={(value) =>
                    onProxyModeChange(value as MediaProxyMode)
                  }
                >
                  {PROXY_MODES.map((mode) => (
                    <MenuPrimitive.RadioItem
                      key={mode}
                      value={mode}
                      closeOnClick
                      className="media-proxy-radio-button"
                      title={t(`media_pool.proxy_mode_${mode}_hint`)}
                    >
                      <MenuPrimitive.RadioItemIndicator
                        keepMounted
                        className="media-proxy-radio-indicator"
                        render={(props, state) => {
                          const Icon = state.checked
                            ? CircleDotIcon
                            : CircleIcon;
                          return (
                            <span {...props}>
                              <Icon size={10} aria-hidden />
                            </span>
                          );
                        }}
                      />
                      <span className="media-proxy-radio-label">
                        {t(`media_pool.proxy_mode_${mode}`)}
                      </span>
                    </MenuPrimitive.RadioItem>
                  ))}
                </MenuPrimitive.RadioGroup>
                <MenuPrimitive.Separator className="menu-separator" />
              </>
            )}

            {media.kind === "Video" && (
              <>
                <MenuPrimitive.Item
                  className="app-menu-item"
                  disabled={!canAnalyze || analyzing}
                  title={t("media_pool.analyze_shots_hint")}
                  onClick={onAnalyze}
                >
                  <MenuItemContent>
                    {analyzing
                      ? t("media_pool.analyze_shots_running")
                      : t("media_pool.analyze_shots")}
                  </MenuItemContent>
                </MenuPrimitive.Item>
                <MenuPrimitive.Separator className="menu-separator" />
              </>
            )}

            <MenuPrimitive.Item
              className="app-menu-item media-context-menu-remove"
              disabled={!canRemove}
              title={
                canRemove
                  ? t("media_pool.remove_menu")
                  : t("media_pool.remove_wait_for_import")
              }
              onClick={onRemove}
            >
              <MenuItemContent>{t("media_pool.remove_menu")}</MenuItemContent>
            </MenuPrimitive.Item>
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
