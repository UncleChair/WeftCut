import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { Interpolation } from "../ipc";

const OPTIONS: { kind: "Hold" | "Linear" | "EaseIn" | "EaseOut"; labelKey: string }[] = [
  { kind: "Hold", labelKey: "keyframe.interp_hold" },
  { kind: "Linear", labelKey: "keyframe.interp_linear" },
  { kind: "EaseIn", labelKey: "keyframe.interp_ease_in" },
  { kind: "EaseOut", labelKey: "keyframe.interp_ease_out" },
];

export function KeyframeInterpMenu({
  x,
  y,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  onPick: (interp: Interpolation) => void;
  onClose: () => void;
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
          className="z-50"
        >
          <MenuPrimitive.Popup className="menu-list">
            {OPTIONS.map((o) => (
              <MenuPrimitive.Item
                key={o.kind}
                className="menu-item"
                // Base UI closes the menu on item activation → onOpenChange
                // fires onClose; no explicit onClose here (matches LayerContextMenu).
                onClick={() => onPick({ kind: o.kind })}
              >
                {t(o.labelKey)}
              </MenuPrimitive.Item>
            ))}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
