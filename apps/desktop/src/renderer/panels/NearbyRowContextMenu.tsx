import { useTranslation } from "react-i18next";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { useCursorAnchor } from "../timeline/contextMenuAnchor";
import type { RestackMenuTargets, RestackTarget } from "./peek";

/// Right-click menu on an At-playhead visual row — the non-drag path to the
/// same restack op as the grip (ADR 0044 decision 4: every drag has a
/// keyboard-reachable equivalent). Four ordering items only; rows with
/// nothing to order (audio, Nearby section) get no menu at all rather than
/// an empty one. The caller resolves each item to its anchored restack (or
/// null = disabled) via `restackMenuTargets` at open time, so this component
/// is purely presentational and the op surface stays above/below.
///
/// Same virtual-anchor Base UI menu as the timeline's and the media pool's:
/// placement from the right-click coordinates, outside-press + Escape close
/// and arrow-key navigation from the library.
export function NearbyRowContextMenu({
  x,
  y,
  label,
  targets,
  onClose,
  onAction,
}: {
  x: number;
  y: number;
  /// The row's display name, for the popup's accessible name.
  label: string;
  targets: RestackMenuTargets;
  onClose: () => void;
  /// Fires exactly once per chosen item with the item's anchored restack.
  onAction: (target: RestackTarget) => void;
}) {
  const { t } = useTranslation();
  const anchor = useCursorAnchor(x, y);
  const item = (target: RestackTarget | null, text: string) => (
    <MenuPrimitive.Item
      className="app-menu-item"
      disabled={target === null}
      onClick={() => {
        if (target) onAction(target);
      }}
    >
      {text}
    </MenuPrimitive.Item>
  );
  return (
    <MenuPrimitive.Root
      open
      // Non-modal, like every context menu here: no scroll lock — the
      // panel's scroll-close effect handles anchored-to-stale-coordinates.
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
            className="app-menu-list"
            aria-label={t("peek.row_menu", { label })}
          >
            {item(targets.bringForward, t("peek.restack_forward"))}
            {item(targets.sendBackward, t("peek.restack_backward"))}
            {item(targets.bringToFront, t("peek.restack_front"))}
            {item(targets.sendToBack, t("peek.restack_back"))}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
