import { Switch } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

interface AppSwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

/// The one on/off control for every WeftCut form. Replaces bare
/// `<input type="checkbox">`: all of the app's checkboxes were
/// immediate-effect toggles (settings, layer enabled, include audio),
/// which a switch pill states more honestly than a form checkbox.
/// Renders a button with role="switch" — keyboard (Space) and aria come
/// from Base UI.
export function AppSwitch({
  checked,
  onCheckedChange,
  disabled,
  ariaLabel,
  className,
}: AppSwitchProps) {
  return (
    <Switch.Root
      className={cn("app-switch", className)}
      checked={checked}
      disabled={disabled ?? false}
      aria-label={ariaLabel}
      onCheckedChange={(next) => onCheckedChange(next)}
    >
      <Switch.Thumb className="app-switch-thumb" />
    </Switch.Root>
  );
}
