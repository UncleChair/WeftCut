import { cn } from "@/lib/utils";

export interface AppColorFieldProps {
  /// Hex string, e.g. "#aabbcc". The native picker edits the RGB triplet only.
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

/// The one color swatch for every WeftCut form. A skinned native
/// `<input type="color">` — keeps the OS picker (no custom popover). Does NOT
/// debounce: callers whose commit triggers an expensive re-render (PropertyPanel
/// CDP re-capture) keep their own debounce, exactly as before.
export function AppColorField({
  value,
  onValueChange,
  disabled,
  ariaLabel,
  className,
}: AppColorFieldProps) {
  return (
    <input
      type="color"
      className={cn("app-color-swatch", className)}
      value={value}
      disabled={disabled ?? false}
      aria-label={ariaLabel}
      onChange={(e) => onValueChange(e.target.value)}
    />
  );
}
