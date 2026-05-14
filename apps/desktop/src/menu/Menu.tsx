import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  resolveAccelerator,
  useEffectiveBindings,
  type ActionId,
} from "../shortcuts";

// Closing the open dropdown is handled at the `Menu` root; `MenuItem`
// uses this context to fire it after `onClick` so the user doesn't have
// to manually dismiss.
const MenuCloseContext = createContext<() => void>(() => {});

interface MenuProps {
  /// Top-level label rendered on the trigger button.
  label: string;
  /// Tooltip on the trigger.
  hint?: string;
  /// `MenuItem` / `MenuSeparator` / `MenuHeading` children.
  children: ReactNode;
}

export function Menu({ label, hint, children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Outside-click + Escape close. Bound only while open so we don't pay
  // the document-listener cost when every menu in the bar is closed.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu-root" ref={rootRef}>
      <button
        type="button"
        className={`menu-trigger ${open ? "is-open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title={hint}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="menu-trigger-label">{label}</span>
        <span className="menu-chevron" aria-hidden="true">▾</span>
      </button>
      {open && (
        <MenuDropdown close={() => setOpen(false)}>{children}</MenuDropdown>
      )}
    </div>
  );
}

// Wrap the open dropdown so the close callback is available to
// `MenuItem` via context. The clip-hook that punched a hole in the
// libmpv host HWND used to live here; the Phase D `<video>` preview is
// a DOM element so no clip is needed and the dropdown composes
// naturally with the rest of the layout.
function MenuDropdown({
  close,
  children,
}: {
  close: () => void;
  children: ReactNode;
}) {
  return (
    <MenuCloseContext.Provider value={close}>
      <div className="menu-list" role="menu">
        {children}
      </div>
    </MenuCloseContext.Provider>
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
  const close = useContext(MenuCloseContext);
  // Show only the *first* effective binding for the action. The menu
  // has no room for multi-binding lists; the Settings → Keyboard panel
  // is where the user goes to see them all. Reading through the
  // bindings context (rather than `ACTION_DEFS.defaultKeys`) means a
  // user remap shows up here immediately — the label and the bound
  // key cannot drift.
  const effective = useEffectiveBindings(actionId);
  const accelerator = effective ? resolveAccelerator(effective) : "";
  return (
    <button
      type="button"
      className="menu-item"
      role="menuitem"
      title={hint}
      disabled={disabled}
      onClick={() => {
        close();
        // Fire onSelect AFTER close so an async handler doesn't keep the
        // menu open if it throws synchronously. Promise rejections are
        // the caller's responsibility.
        void onSelect();
      }}
    >
      <span className="menu-item-check" aria-hidden="true">
        {checked ? "✓" : ""}
      </span>
      <span className="menu-item-label">{label}</span>
      {accelerator && (
        <span className="menu-item-accelerator" aria-hidden="true">
          {accelerator}
        </span>
      )}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu-separator" role="separator" />;
}

export function MenuHeading({ label }: { label: string }) {
  return (
    <div className="menu-heading" role="presentation">
      {label}
    </div>
  );
}
