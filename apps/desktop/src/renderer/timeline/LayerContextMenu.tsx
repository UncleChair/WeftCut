import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { TransitionDirection } from "../ipc";
import {
  TRANSITION_DIRECTIONS,
  type TransitionCut,
  type TransitionKindName,
} from "./transitions";

/// Floating context menu (Base UI Menu) anchored to a zero-size virtual
/// element at the right-click coordinates. The popup machinery (portal,
/// outside-press + Escape close, arrow-key nav) comes from the library.
/// Action items are scoped to the right-clicked layer's kind.
///
/// When the right-click landed within the click-tolerance band of a cut
/// between same-track adjacent visual layers (`transitionCut` non-null), an
/// "Add transition" section appends — flat, like every menu here (no submenus).
export function LayerContextMenu({
  x,
  y,
  layerId,
  layerKind,
  layerEnabled,
  transitionCut,
  onClose,
  onRename,
  onToggleEnabled,
  onSeparateAudio,
  onPrebakeNow,
  onAddTransition,
}: {
  x: number;
  y: number;
  layerId: string;
  layerKind: string;
  layerEnabled: boolean;
  transitionCut: TransitionCut | null;
  onClose: () => void;
  onRename: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onSeparateAudio: (id: string) => void;
  onPrebakeNow: (id: string) => void;
  onAddTransition: (
    cut: TransitionCut,
    kind: TransitionKindName,
    direction?: TransitionDirection,
  ) => void;
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
  const directionLabel = (d: TransitionDirection) =>
    t(`transitions.direction_${d}`, { defaultValue: d });
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
          className="app-popup-positioner"
        >
          <MenuPrimitive.Popup className="app-menu-list">
            <MenuPrimitive.Item
              className="app-menu-item"
              onClick={() => onRename(layerId)}
            >
              {t("timeline.rename", { defaultValue: "Rename" })}
            </MenuPrimitive.Item>
            <MenuPrimitive.Item
              className="app-menu-item"
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
                  className="app-menu-item"
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
                  className="app-menu-item"
                  onClick={() => onPrebakeNow(layerId)}
                >
                  {t("timeline.prebake_now", { defaultValue: "Pre-bake now" })}
                </MenuPrimitive.Item>
              </>
            )}
            {transitionCut && (
              <>
                <MenuPrimitive.Separator className="menu-separator" />
                <MenuPrimitive.Item
                  className="app-menu-item"
                  onClick={() => onAddTransition(transitionCut, "Crossfade")}
                >
                  {t("timeline.add_transition_crossfade", {
                    defaultValue: "Add crossfade",
                  })}
                </MenuPrimitive.Item>
                {TRANSITION_DIRECTIONS.map((d) => (
                  <MenuPrimitive.Item
                    key={`wipe-${d}`}
                    className="app-menu-item"
                    onClick={() => onAddTransition(transitionCut, "Wipe", d)}
                  >
                    {t("timeline.add_transition_wipe", {
                      direction: directionLabel(d),
                      defaultValue: "Add wipe · {{direction}}",
                    })}
                  </MenuPrimitive.Item>
                ))}
                {TRANSITION_DIRECTIONS.map((d) => (
                  <MenuPrimitive.Item
                    key={`slide-${d}`}
                    className="app-menu-item"
                    onClick={() => onAddTransition(transitionCut, "Slide", d)}
                  >
                    {t("timeline.add_transition_slide", {
                      direction: directionLabel(d),
                      defaultValue: "Add slide · {{direction}}",
                    })}
                  </MenuPrimitive.Item>
                ))}
              </>
            )}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
