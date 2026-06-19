import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

/// V.7 floating context menu, rendered with Base UI Menu anchored to a
/// zero-size virtual element at the right-click coordinates — the
/// `contextMenu` state plumbing (and its coexistence with drag/blade
/// pointer handling) is unchanged; only the popup machinery moved to
/// the library (portal, outside-press + Escape close, arrow-key nav).
/// Shows action items scoped to the right-clicked layer's kind.
/// (The 2026-05-17 effect-redesign removed the H.6 render-mode toggle;
/// group html-rendering is now driven by the presence of an
/// HtmlTransform effect on the group, authored via MCP / a future
/// effects panel.)
export function LayerContextMenu({
  x,
  y,
  layerId,
  layerKind,
  layerEnabled,
  onClose,
  onRename,
  onToggleEnabled,
  onSeparateAudio,
  onPrebakeNow,
}: {
  x: number;
  y: number;
  layerId: string;
  layerKind: string;
  layerEnabled: boolean;
  onClose: () => void;
  onRename: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onSeparateAudio: (id: string) => void;
  onPrebakeNow: (id: string) => void;
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
      // Non-modal: no scroll lock — the scroll-close effect in Timeline
      // handles the anchored-to-stale-coordinates case instead.
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
          className="z-50"
        >
          <MenuPrimitive.Popup className="menu-list">
            <MenuPrimitive.Item
              className="menu-item"
              onClick={() => onRename(layerId)}
            >
              {t("timeline.rename", { defaultValue: "Rename" })}
            </MenuPrimitive.Item>
            <MenuPrimitive.Item
              className="menu-item"
              onClick={() => onToggleEnabled(layerId, !layerEnabled)}
            >
              {layerEnabled
                ? t("timeline.disable_layer", { defaultValue: "Disable layer" })
                : t("timeline.enable_layer", { defaultValue: "Enable layer" })}
            </MenuPrimitive.Item>
            {layerKind === "Audio" && (
              <>
                <MenuPrimitive.Separator className="menu-separator" />
                <MenuPrimitive.Item
                  className="menu-item"
                  onClick={() => onSeparateAudio(layerId)}
                >
                  {t("timeline.separate_audio", {
                    defaultValue: "Separate audio to new track",
                  })}
                </MenuPrimitive.Item>
              </>
            )}
            {layerKind === "Motif" && (
              <>
                <MenuPrimitive.Separator className="menu-separator" />
                <MenuPrimitive.Item
                  className="menu-item"
                  onClick={() => onPrebakeNow(layerId)}
                >
                  {t("timeline.prebake_now", { defaultValue: "Pre-bake now" })}
                </MenuPrimitive.Item>
              </>
            )}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
