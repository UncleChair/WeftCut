import { useEffect, useRef } from "react";
import { NumberField } from "@base-ui/react/number-field";
import { ChevronUpIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS_GROUP_ATTR } from "../focus/focusRegion";
import { isInTransientWidget } from "../shortcuts/match";

// While typing, auto-commit the value once the user pauses, so the change
// applies to the canvas without needing to blur. Enter / blur / step-end still
// commit immediately (Base UI's onValueCommitted) as a safeguard. 300ms — a bit
// longer than the 250ms slider debounce, since typing pauses run longer than
// scrub micro-pauses (avoids committing mid-number).
const NUMBER_COMMIT_DEBOUNCE_MS = 300;

export interface AppNumberFieldProps {
  /// `null` renders an empty field — for optional values (e.g. an unset
  /// custom bitrate). Required-value call sites just pass their number.
  value: number | null;
  /// Live value (every keystroke / arrow/stepper step). Drives the call site's
  /// local state.
  onValueChange: (value: number) => void;
  /// Fires once per edit, on blur / Enter / step-end so undo stays one entry
  /// per edit. Omit for live-commit call sites (they use onValueChange only).
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
  /// Optional focus/blur passthrough. Call sites that keep a local-state mirror
  /// of `value` (e.g. font_size, speed) use these to gate their prop→local
  /// resync while the field is focused — otherwise a mid-typing debounced
  /// commit's round-trip can re-run the resync and clobber what's being typed.
  onFocus?: () => void;
  onBlur?: () => void;
  ariaLabel?: string;
  className?: string;
}

/// The one numeric input for every WeftCut form. Wraps Base UI NumberField:
/// type a value, use ↑/↓ arrow keys, or the hover-revealed +/- steppers.
/// (No drag-scrub: Base UI's ScrubArea needs Pointer Lock; it is simply not
/// wired up here. Could be added — keyboard arrows and the +/- steppers cover
/// the same edits.)
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
  onFocus,
  onBlur,
  ariaLabel,
  className,
}: AppNumberFieldProps) {
  // Debounced auto-commit plumbing. `slot` is a closure-stable timer slot;
  // `lastCommitted` tracks the value we last handed to onCommit so the
  // blur/Enter commit can't fire a duplicate of what the debounce just sent
  // (else one edit = two undo entries). The baseline is (re)captured on focus,
  // NOT synced from `value` — call sites like font_size mirror the typed value
  // into `value`, so a `value`-sync would make the debounce see its own typed
  // value and skip the commit. Re-capturing on focus also resets the baseline
  // across layer switches / external changes (each edit starts fresh).
  const slot = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommitted = useRef<number | null>(value);
  // Don't fire a debounced commit against a now-unmounted field.
  useEffect(() => () => { if (slot.current) clearTimeout(slot.current); }, []);

  const flushCommit = (next: number) => {
    if (slot.current) {
      clearTimeout(slot.current);
      slot.current = null;
    }
    if (next !== lastCommitted.current) {
      lastCommitted.current = next;
      onCommit?.(next);
    }
  };

  /// `Escape` = discard this edit (ADR 0041). Unlike `AppInput`, this widget
  /// needs no call-site cooperation: `lastCommitted` — captured on focus, not
  /// synced from `value` — IS the pre-edit snapshot, and restoring it makes
  /// the release blur's `onValueCommitted` hit `flushCommit`'s dedup guard, so
  /// cancelling can never log an undo entry.
  const cancelEdit = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    // Inside a dialog / menu, Escape belongs to the widget that owns it.
    if (isInTransientWidget(e.currentTarget)) return;
    e.preventDefault();
    if (slot.current) {
      clearTimeout(slot.current);
      slot.current = null;
    }
    const snapshot = lastCommitted.current;
    if (snapshot !== null) onValueChange(snapshot);
  };

  return (
    <NumberField.Root
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled ?? false}
      onValueChange={(next) => {
        if (next === null) {
          onClear?.();
          return;
        }
        onValueChange(next);
        // Schedule a debounced commit only when the call site records commits.
        if (onCommit) {
          if (slot.current) clearTimeout(slot.current);
          slot.current = setTimeout(() => flushCommit(next), NUMBER_COMMIT_DEBOUNCE_MS);
        }
      }}
      onValueCommitted={(next) => {
        // Enter / blur / step-end: commit now (and cancel any pending debounce).
        if (next !== null) flushCommit(next);
      }}
      className={cn("app-number-field", className)}
    >
      {/* A focus group: the steppers below are satellites of this input, so a
          press on one must not read as "the user left the field" and commit. */}
      <NumberField.Group className="app-number-group" {...{ [FOCUS_GROUP_ATTR]: "" }}>
        <NumberField.Input
          aria-label={ariaLabel}
          // Capture the committed baseline at edit-start for the dedup guard,
          // then notify the call site (focus-gated resync).
          onFocus={() => {
            lastCommitted.current = value;
            onFocus?.();
          }}
          onBlur={() => onBlur?.()}
          onKeyDown={cancelEdit}
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
