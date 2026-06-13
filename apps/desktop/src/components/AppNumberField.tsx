import { NumberField } from "@base-ui/react/number-field";
import { ChevronUpIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AppNumberFieldProps {
  /// `null` renders an empty field — for optional values (e.g. an unset
  /// custom bitrate). Required-value call sites just pass their number.
  value: number | null;
  /// Live value (every keystroke / scrub tick). Drives the call site's local
  /// state, mirroring the old `parseFloat(e.target.value) || prev` onChange.
  onValueChange: (value: number) => void;
  /// Fires once per edit, on blur / Enter / scrub-end. Maps to the old
  /// commit-on-blur so undo stays one entry per edit. Omit for live-commit
  /// call sites (they use onValueChange only).
  onCommit?: (value: number) => void;
  /// Fires (live) when the field is cleared to empty. Without it, an empty
  /// field is dropped so the call site keeps its last good number; with it,
  /// the call site can represent the unset state (e.g. bitrate → null).
  onClear?: () => void;
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
/// type a value, use ↑/↓ arrow keys, or the hover-revealed +/- steppers.
/// (Drag-scrub was dropped: Base UI's ScrubArea needs the Pointer Lock API,
/// which doesn't engage in WebView2 — the bounded cursor only ever scrubbed
/// the value up, never down.)
/// `value` may go null mid-edit (empty field): without `onClear` we drop the
/// null so the call site keeps its last good number (matching the old
/// `|| prev` guard); with `onClear` the call site learns the field is unset.
/// No ref forwarding: number fields aren't programmatically focused (unlike
/// the rename/timecode AppInput sites).
export function AppNumberField({
  value,
  onValueChange,
  onCommit,
  onClear,
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
        else onClear?.();
      }}
      onValueCommitted={(next) => {
        if (next !== null) onCommit?.(next);
      }}
      className={cn("app-number-field", className)}
    >
      <NumberField.Group className="app-number-group">
        <NumberField.Input
          aria-label={ariaLabel}
          className={cn("app-input", "app-number-input", align === "center" && "app-input--center")}
        />
        {/* Mouse-only affordance: hidden until hover (keyboard users change
            the value with arrow keys on the input). Not aria-hidden — the
            Increment/Decrement buttons keep their own button semantics. */}
        <div className="app-number-steppers">
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
