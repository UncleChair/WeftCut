import { useTranslation } from "react-i18next";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useCursorAnchor } from "./contextMenuAnchor";

/// Right-click menu on a lane header. Its own component rather than an arm of
/// `LayerContextMenu` because the object being acted on is the TRACK, and its
/// state can live in the header itself: nothing here needs the cross-lane cut
/// hit-test that keeps the layer menu's state up in Timeline.
///
/// "Rename" opens the same inline edit the header's double-click does — the menu
/// exists so the gesture is discoverable without already knowing it.
export function TrackContextMenu({
  x,
  y,
  onClose,
  onRename,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
}) {
  const { t } = useTranslation();
  const anchor = useCursorAnchor(x, y);
  return (
    <MenuPrimitive.Root
      open
      // Non-modal, like the layer menu: no scroll lock, and the header's own
      // scroll-close effect handles anchored-to-stale-coordinates.
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
            <MenuPrimitive.Item className="app-menu-item" onClick={onRename}>
              {t("timeline.rename", { defaultValue: "Rename" })}
            </MenuPrimitive.Item>
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
