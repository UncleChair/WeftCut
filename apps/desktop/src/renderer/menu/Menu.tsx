import type { ReactNode } from "react";
import { Menubar } from "@base-ui/react/menubar";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import {
  resolveAccelerator,
} from "../shortcuts/match";
import { useEffectiveBindings } from "../shortcuts/bindings-context";
import type { ActionId } from "../shortcuts/defs";

/// The menu bar container. Base UI's Menubar makes the triggers one
/// composite roving-focus stop and coordinates the Menus inside it:
/// click opens, hovering an adjacent trigger while any menu is open
/// switches to it, ArrowLeft/Right move between menus, and opening one
/// menu closes the previous (only one dropdown open at a time).
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

/// One dropdown in the bar. Base UI supplies portal + Floating UI positioning, outside-click and
/// Escape close, ArrowDown/Up item navigation, and typeahead. The
/// .menu-* classes carry the visual identity; placement is via the
/// Positioner (align start, 4px below the trigger).
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
        <MenuPrimitive.Positioner
          align="start"
          sideOffset={4}
          className="app-popup-positioner"
        >
          <MenuPrimitive.Popup className="app-menu-list">
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
      className="app-menu-item"
      title={hint}
      disabled={disabled ?? false}
      // Base UI closes the menu on activation before this runs, so an
      // async handler that throws can't keep the dropdown open.
      // Promise rejections are the caller's responsibility.
      onClick={() => void onSelect()}
    >
      <span className="app-menu-item-check" aria-hidden="true">
        {checked ? <CheckIcon size={12} /> : null}
      </span>
      <span className="app-menu-item-label">{label}</span>
      {accelerator && (
        <span className="app-menu-item-accelerator" aria-hidden="true">
          {accelerator}
        </span>
      )}
    </MenuPrimitive.Item>
  );
}

interface SubMenuProps {
  /// Label rendered on the trigger row.
  label: string;
  disabled?: boolean;
  /// `MenuItem` / `MenuSeparator` / `MenuHeading` children.
  children: ReactNode;
}

/// A nested dropdown inside a Menu. Base UI's SubmenuRoot supplies hover
/// intent, ArrowRight/Left open/close, and Escape handling; nested inside a
/// Menu its Positioner defaults to side=inline-end/align=start, so the popup
/// opens to the trigger's right edge with no extra placement props. The
/// trigger row reuses the .app-menu-item styles (plus a right chevron) so it
/// lines up with plain items.
export function SubMenu({ label, disabled, children }: SubMenuProps) {
  return (
    <MenuPrimitive.SubmenuRoot>
      <MenuPrimitive.SubmenuTrigger
        className="app-menu-item app-submenu-trigger"
        disabled={disabled ?? false}
      >
        {/* Empty check-column spacer so the label aligns with MenuItem rows. */}
        <span className="app-menu-item-check" aria-hidden="true" />
        <span className="app-menu-item-label">{label}</span>
        <span className="app-submenu-chevron" aria-hidden="true">
          <ChevronRightIcon size={12} />
        </span>
      </MenuPrimitive.SubmenuTrigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner className="app-popup-positioner">
          <MenuPrimitive.Popup className="app-menu-list">
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.SubmenuRoot>
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
