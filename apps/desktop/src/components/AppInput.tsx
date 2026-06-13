import { forwardRef } from "react";
import { Input } from "@base-ui/react/input";
import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

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
  align?: "left" | "center";
  /// search only: render a ✕ that clears to "" when the value is non-empty.
  clearable?: boolean;
  ariaLabel?: string;
  className?: string;
}

/// The one text-like input for every WeftCut form. Replaces bare
/// `<input type="text|password|search">`: one `.app-input` skin (focus ring,
/// invalid/mono/center modifiers) instead of ~8 per-scope CSS rules. Spreads
/// remaining native input props (placeholder, maxLength, onBlur, onKeyDown,
/// id, spellCheck…) so it is a drop-in for the rename/search/timecode sites.
export const AppInput = forwardRef<HTMLInputElement, AppInputProps>(
  function AppInput(
    { value, onValueChange, type = "text", invalid, mono, align, clearable, ariaLabel, className, ...rest },
    ref,
  ) {
    const control = (
      <Input
        ref={ref}
        type={type}
        value={value}
        aria-label={ariaLabel}
        onValueChange={(next) => onValueChange(next)}
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
      <span className="app-input-wrap">
        {control}
        {value !== "" ? (
          <button
            type="button"
            className="app-input-clear"
            aria-label="Clear"
            onClick={() => onValueChange("")}
          >
            <XIcon size={12} />
          </button>
        ) : null}
      </span>
    );
  },
);
