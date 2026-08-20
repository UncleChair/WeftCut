// The transition chip's context menu (#16): kind / direction / duration
// without a round trip to the inspector, plus delete. Same cursor-anchored
// Base UI shell as LayerContextMenu, but the first timeline menu with
// submenus — reusing the menubar's `SubMenu`/`MenuItem` rows, whose check
// column doubles as the radio state for kind, direction, and the duration
// presets.
//
// All commits go through the same `updateTransition`/`removeTransition`
// wrappers as the inspector; this component only assembles the args.

import { useTranslation } from "react-i18next";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { TransitionSummary } from "../ipc";
import { MenuItem, MenuSeparator, SubMenu } from "../menu/Menu";
import { useCursorAnchor } from "./contextMenuAnchor";
import {
  TRANSITION_DIRECTIONS,
  TRANSITION_DURATION_PRESETS_SEC,
  TRANSITION_KIND_NAMES,
  presetTransitionDurationUs,
  transitionDirectionOf,
  transitionDirectionUpdateArgs,
  transitionDurationUpdateArgs,
  transitionKindUpdateArgs,
  type TransitionUpdateArgs,
} from "./transitions";

export function TransitionChipMenu({
  x,
  y,
  transition,
  fpsNum,
  fpsDen,
  onClose,
  onUpdate,
  onDelete,
}: {
  x: number;
  y: number;
  transition: TransitionSummary;
  fpsNum: number;
  fpsDen: number;
  onClose: () => void;
  onUpdate: (args: TransitionUpdateArgs) => void;
  onDelete: (transitionId: string) => void;
}) {
  const { t } = useTranslation();
  const anchor = useCursorAnchor(x, y);
  const currentKind = transition.kind.kind;
  const currentDirection = transitionDirectionOf(transition.kind);

  // Arg assembly lives in transitions.ts as pure functions (unit-tested
  // there); null means "picked the current value", which commits nothing.
  const commit = (args: ReturnType<typeof transitionKindUpdateArgs>) => {
    if (args !== null) onUpdate(args);
  };

  return (
    <MenuPrimitive.Root
      open
      // Non-modal for the LayerContextMenu reason: the Timeline's
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
          <MenuPrimitive.Popup
            className="app-menu-list"
            data-testid="transition-chip-menu"
          >
            <SubMenu label={t("timeline.transition_menu_kind")}>
              {TRANSITION_KIND_NAMES.map((kind) => (
                <MenuItem
                  key={kind}
                  label={t(`transitions.kind_${kind.toLowerCase()}`, {
                    defaultValue: kind,
                  })}
                  checked={kind === currentKind}
                  onSelect={() => commit(transitionKindUpdateArgs(transition, kind))}
                />
              ))}
            </SubMenu>
            {/* Hidden entirely for Crossfade — the inspector's rule: a
                directionless kind offering a direction would promise an
                effect it cannot have. */}
            {currentKind !== "Crossfade" && (
              <SubMenu label={t("timeline.transition_menu_direction")}>
                {TRANSITION_DIRECTIONS.map((direction) => (
                  <MenuItem
                    key={direction}
                    label={t(`transitions.direction_${direction}`, {
                      defaultValue: direction,
                    })}
                    checked={direction === currentDirection}
                    onSelect={() =>
                      commit(transitionDirectionUpdateArgs(transition, direction))
                    }
                  />
                ))}
              </SubMenu>
            )}
            <SubMenu label={t("timeline.transition_menu_duration")}>
              {TRANSITION_DURATION_PRESETS_SEC.map((seconds) => {
                const durationUs = presetTransitionDurationUs(
                  seconds,
                  fpsNum,
                  fpsDen,
                );
                return (
                  <MenuItem
                    key={seconds}
                    label={t("timeline.transition_menu_duration_preset", {
                      seconds,
                      defaultValue: "{{seconds}} s",
                    })}
                    checked={durationUs === transition.duration_us}
                    onSelect={() =>
                      commit(transitionDurationUpdateArgs(transition, durationUs))
                    }
                  />
                );
              })}
            </SubMenu>
            <MenuSeparator />
            <MenuItem
              label={t("property_panel.transition_delete", {
                defaultValue: "Delete transition",
              })}
              onSelect={() => onDelete(transition.id)}
            />
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
