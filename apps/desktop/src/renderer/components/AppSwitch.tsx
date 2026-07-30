import { Switch } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";
import { blurAfterMouseActivation } from "./blurAfterMouseActivation";

interface AppSwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  "data-testid"?: string;
}

/// The one on/off control for every WeftCut form. Use for immediate-effect
/// toggles (settings, layer enabled, include audio) — a switch pill states
/// the instant-apply semantics more honestly than a form checkbox.
/// Renders a button with role="switch" — keyboard (Space) and aria come
/// from Base UI.
export function AppSwitch({
  checked,
  onCheckedChange,
  disabled,
  ariaLabel,
  className,
  "data-testid": testId,
}: AppSwitchProps) {
  return (
    <Switch.Root
      className={cn("app-switch", className)}
      checked={checked}
      disabled={disabled ?? false}
      aria-label={ariaLabel}
      data-testid={testId}
      onCheckedChange={(next) => onCheckedChange(next)}
      onClick={blurAfterMouseActivation}
    >
      <Switch.Thumb className="app-switch-thumb" />
    </Switch.Root>
  );
}
