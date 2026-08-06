import { forwardRef } from "react";
import { Input } from "@base-ui/react/input";
import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS_GROUP_ATTR } from "../focus/focusRegion";
import { isInTransientWidget } from "../shortcuts/match";

type NativeInputProps = Omit<
  React.ComponentProps<"input">,
  "value" | "onChange" | "type" | "ref" | "className"
>;

export interface AppInputProps extends NativeInputProps {
  value: string;
  onValueChange: (value: string) => void;
  /// Defaults to "text". "search" pairs with `clearable`.
  type?: "text" | "password" | "search";
  invalid?: boolean;
  mono?: boolean;
  /// Left is the default (no class); pass "center" to center the value.
  align?: "center";
  /// search only: render a ✕ that clears to "" when the value is non-empty.
  clearable?: boolean;
  /// Accessible label for the clear ✕ (clearable inputs). Defaults to "Clear";
  /// pass a translated string at i18n call sites.
  clearAriaLabel?: string;
  ariaLabel?: string;
  className?: string;
  /// `Escape` = discard this edit (ADR 0041). The widget cannot revert on its
  /// own — the call site owns `value` — so a field wanting NLE cancel
  /// semantics restores its draft here AND flags the imminent blur as a
  /// cancel, so its own `onBlur` commit stands down. Omit and Escape still
  /// releases focus to the panel (`useFocusRegions`), it just commits.
  ///
  /// Never fires inside a dialog / menu / listbox: there Escape closes the
  /// widget, and consuming it to revert would strand the user one level in.
  onCancel?: () => void;
}

/// The one text-like input for every WeftCut form. Replaces bare
/// `<input type="text|password|search">`: one `.app-input` skin (focus ring,
/// invalid/mono/center modifiers). Spreads remaining native input props
/// (placeholder, maxLength, onBlur, onKeyDown, id, spellCheck…) so it is a
/// drop-in for the rename/search/timecode sites.
export const AppInput = forwardRef<HTMLInputElement, AppInputProps>(
  function AppInput(
    { value, onValueChange, type = "text", invalid, mono, align, clearable, clearAriaLabel, ariaLabel, className, onCancel, onKeyDown, ...rest },
    ref,
  ) {
    // The call site's handler runs FIRST and can opt out of the cancel by
    // consuming the key — the timeline rename input does exactly that (its
    // Escape ends rename mode, which is its own kind of cancel).
    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      onKeyDown?.(e);
      if (!onCancel || e.key !== "Escape" || e.defaultPrevented) return;
      if (isInTransientWidget(e.currentTarget)) return;
      e.preventDefault();
      onCancel();
    };
    const control = (
      <Input
        ref={ref}
        type={type}
        value={value}
        aria-label={ariaLabel}
        onValueChange={(next) => onValueChange(next)}
        onKeyDown={handleKeyDown}
        className={cn(
          "app-input",
          invalid && "app-input--invalid",
          mono && "app-input--mono",
          align === "center" && "app-input--center",
          clearable && "app-input--clearable",
          className,
        )}
        {...rest}
      />
    );
    if (!clearable) return control;
    return (
      // A focus group: the ✕ below is a satellite of this input, so a press on
      // it must not read as "the user left the field". The `onMouseDown`
      // preventDefault there is not sufficient on its own —
      // `useFocusRegions` listens in the capture phase and would run first.
      <span className="app-input-wrap" {...{ [FOCUS_GROUP_ATTR]: "" }}>
        {control}
        {value !== "" ? (
          <button
            type="button"
            className="app-input-clear"
            aria-label={clearAriaLabel ?? "Clear"}
            // Keep focus in the input after clearing (prevent the button's
            // mousedown from stealing focus and firing the input's onBlur).
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onValueChange("")}
          >
            <XIcon size={12} />
          </button>
        ) : null}
      </span>
    );
  },
);
