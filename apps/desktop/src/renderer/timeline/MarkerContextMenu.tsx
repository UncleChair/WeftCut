import { useTranslation } from "react-i18next";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useCursorAnchor } from "./contextMenuAnchor";

/// Right-click menu on a marker glyph in the ruler. Its own component rather
/// than an arm of `LayerContextMenu` for the `TrackContextMenu` reason: the
/// object being acted on is the MARKER, and the ruler owns the state.
///
/// Two items and no more. Rename and delete are the operations a marker's
/// maintainer needs; everything heavier (colour, drag, navigation) was
/// deliberately cut from this slice. Delete asks nothing first — it is one
/// undo away, which is the house rule for destructive-but-recorded.
export function MarkerContextMenu({
  x,
  y,
  onClose,
  onRename,
  onDelete,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const anchor = useCursorAnchor(x, y);
  return (
    <MenuPrimitive.Root
      open
      // Non-modal, like the track and layer menus: no scroll lock, and the
      // ruler's own scroll-close effect handles anchored-to-stale-coordinates.
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
            <MenuPrimitive.Item className="app-menu-item" onClick={onDelete}>
              {t("timeline.delete_marker", { defaultValue: "Delete marker" })}
            </MenuPrimitive.Item>
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
