import type { ReactNode } from "react";
import { Menubar } from "@base-ui/react/menubar";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import {
  resolveAccelerator,
  useEffectiveBindings,
  type ActionId,
} from "../shortcuts";

/// The menu bar container. Base UI's Menubar makes the triggers one
/// composite roving-focus stop and coordinates the Menus inside it:
/// click opens, hovering an adjacent trigger while any menu is open
/// switches to it, ArrowLeft/Right move between menus, and opening one
/// menu closes the previous (the hand-rolled version let two dropdowns
/// sit open at once).
export function MenuBar({ children }: { children: ReactNode }) {
  return <Menubar className="menu-bar">{children}</Menubar>;
}

interface MenuProps {
  /// Top-level label rendered on the trigger button.
  label: string;
  /// Tooltip on the trigger.
  hint?: string;
  /// `MenuItem` / `MenuSeparator` / `MenuHeading` children.
  children: ReactNode;
}

/// One dropdown in the bar. Base UI supplies what the hand-rolled
/// version lacked: portal + Floating UI positioning, outside-click and
/// Escape close, ArrowDown/Up item navigation, and typeahead. The
/// legacy .menu-* classes keep the visual identity; placement moved
/// from .menu-list's absolute offsets to the Positioner (align start,
/// 4px below the trigger — same spot).
export function Menu({ label, hint, children }: MenuProps) {
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger className="menu-trigger" title={hint}>
        <span className="menu-trigger-label">{label}</span>
        <span className="menu-chevron" aria-hidden="true">
          <ChevronDownIcon size={11} />
        </span>
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner align="start" sideOffset={4} className="z-50">
          <MenuPrimitive.Popup className="menu-list">
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

interface MenuItemProps {
  label: string;
  hint?: string;
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
  /// Renders a check glyph; useful for radio-style preset rows.
  checked?: boolean;
  /// When set, the item picks up its accelerator hint from
  /// `ACTION_DEFS[actionId]` and renders it right-aligned. This is a
  /// pure display aid — the handler still comes from `onSelect`. The
  /// global keydown dispatcher (`useShortcuts`) reaches the same
  /// handler via the action id, so the accelerator label and bound
  /// key cannot drift.
  actionId?: ActionId;
}

export function MenuItem({
  label,
  hint,
  onSelect,
  disabled,
  checked,
  actionId,
}: MenuItemProps) {
  // Show only the *first* effective binding for the action. The menu
  // has no room for multi-binding lists; the Settings → Keyboard panel
  // is where the user goes to see them all. Reading through the
  // bindings context (rather than `ACTION_DEFS.defaultKeys`) means a
  // user remap shows up here immediately — the label and the bound
  // key cannot drift.
  const effective = useEffectiveBindings(actionId);
  const accelerator = effective ? resolveAccelerator(effective) : "";
  return (
    <MenuPrimitive.Item
      className="menu-item"
      title={hint}
      disabled={disabled ?? false}
      // Base UI closes the menu on activation before this runs, so an
      // async handler that throws can't keep the dropdown open.
      // Promise rejections are the caller's responsibility.
      onClick={() => void onSelect()}
    >
      <span className="menu-item-check" aria-hidden="true">
        {checked ? <CheckIcon size={12} /> : null}
      </span>
      <span className="menu-item-label">{label}</span>
      {accelerator && (
        <span className="menu-item-accelerator" aria-hidden="true">
          {accelerator}
        </span>
      )}
    </MenuPrimitive.Item>
  );
}

export function MenuSeparator() {
  return <MenuPrimitive.Separator className="menu-separator" />;
}

export function MenuHeading({ label }: { label: string }) {
  return (
    <div className="menu-heading" role="presentation">
      {label}
    </div>
  );
}
