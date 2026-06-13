import { NumberField } from "@base-ui/react/number-field";
import { ChevronUpIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AppNumberFieldProps {
  value: number;
  /// Live value (every keystroke / scrub tick). Drives the call site's local
  /// state, mirroring the old `parseFloat(e.target.value) || prev` onChange.
  onValueChange: (value: number) => void;
  /// Fires once per edit, on blur / Enter / scrub-end. Maps to the old
  /// commit-on-blur so undo stays one entry per edit. Omit for live-commit
  /// call sites (they use onValueChange only).
  onCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /// Left is the default (no class); pass "center" to center the value.
  align?: "center";
  ariaLabel?: string;
  className?: string;
}

/// The one numeric input for every WeftCut form. Wraps Base UI NumberField:
/// keyboard arrows, drag-scrub (the left grip), and hover-revealed steppers.
/// `value` may go null mid-edit (empty field) — we drop nulls so the call
/// site keeps the last good number, matching the old `|| prev` guard.
export function AppNumberField({
  value,
  onValueChange,
  onCommit,
  min,
  max,
  step,
  disabled,
  align,
  ariaLabel,
  className,
}: AppNumberFieldProps) {
  return (
    <NumberField.Root
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled ?? false}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      onValueCommitted={(next) => {
        if (next !== null) onCommit?.(next);
      }}
      className={cn("app-number-field", className)}
    >
      <NumberField.Group className="app-number-group">
        <NumberField.ScrubArea className="app-number-scrub" direction="horizontal">
          <span className="app-number-grip" aria-hidden="true" />
        </NumberField.ScrubArea>
        <NumberField.Input
          aria-label={ariaLabel}
          className={cn("app-input", "app-number-input", align === "center" && "app-input--center")}
        />
        <div className="app-number-steppers" aria-hidden="true">
          <NumberField.Increment className="app-number-step">
            <ChevronUpIcon size={10} />
          </NumberField.Increment>
          <NumberField.Decrement className="app-number-step">
            <ChevronDownIcon size={10} />
          </NumberField.Decrement>
        </div>
      </NumberField.Group>
    </NumberField.Root>
  );
}
