import type { ReactNode } from "react";
import { Select } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AppSelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

interface AppSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: AppSelectOption[];
  /// Extra trigger classes on top of the shared `.app-select` skin —
  /// context rules like `.export-select` (min-width) hang off this.
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

/// The one dropdown control for every WeftCut form. Replaces native
/// `<select>`: the popup is app-styled (reusing the app-menu-list/app-menu-item
/// chrome instead of the OS-rendered list), keyboard/typeahead behavior
/// comes from Base UI, and the selected item shows a ✓ in the popup.
/// String values only — numeric call sites convert at the boundary,
/// matching the old `e.target.value` shape.
export function AppSelect({
  value,
  onValueChange,
  options,
  className,
  disabled,
  ariaLabel,
}: AppSelectProps) {
  return (
    <Select.Root
      value={value}
      items={options.map((o) => ({ value: o.value, label: o.label }))}
      disabled={disabled ?? false}
      onValueChange={(v) => {
        if (typeof v === "string") onValueChange(v);
      }}
    >
      <Select.Trigger
        className={cn("app-select", className)}
        aria-label={ariaLabel}
      >
        <Select.Value />
        <span className="menu-chevron" aria-hidden="true">
          <ChevronDownIcon size={11} />
        </span>
      </Select.Trigger>
      <Select.Portal>
        {/* alignItemWithTrigger=false: drop below the trigger like the
            menubar dropdowns (and native Windows selects) instead of
            overlaying the trigger mac-style. */}
        <Select.Positioner
          align="start"
          sideOffset={4}
          alignItemWithTrigger={false}
          className="z-50"
        >
          <Select.Popup className="app-menu-list">
            {options.map((o) => (
              <Select.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled ?? false}
                className="app-menu-item"
              >
                <span className="app-menu-item-check" aria-hidden="true">
                  <Select.ItemIndicator>
                    <CheckIcon size={12} />
                  </Select.ItemIndicator>
                </span>
                <Select.ItemText className="app-menu-item-label">
                  {o.label}
                </Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
