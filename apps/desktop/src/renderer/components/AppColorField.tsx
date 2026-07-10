import { Pipette } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { pickColor } from "../colorpick/pickColor";

export interface AppColorFieldProps {
  /// Hex string, e.g. "#aabbcc". The native picker edits the RGB triplet only.
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  /// Global eyedropper button next to the swatch (default on). Opt out only
  /// where the extra 24px genuinely cannot fit.
  withEyeDropper?: boolean;
}

/// The one color swatch for every WeftCut form. A skinned native
/// `<input type="color">` — keeps the OS picker (no custom popover). Does NOT
/// debounce: callers whose commit triggers an expensive re-render (e.g. PropertyPanel
/// CDP re-capture) must keep their own debounce. The eyedropper commits through
/// the same onValueChange, so caller debounce policy applies to picks too.
export function AppColorField({
  value,
  onValueChange,
  disabled,
  ariaLabel,
  className,
  withEyeDropper = true,
}: AppColorFieldProps) {
  const { t } = useTranslation();
  const input = (
    <input
      type="color"
      className={cn("app-color-swatch", className)}
      value={value}
      disabled={disabled ?? false}
      aria-label={ariaLabel}
      onChange={(e) => onValueChange(e.target.value)}
    />
  );
  if (!withEyeDropper) return input;
  return (
    <span className="app-color-field">
      {input}
      <button
        type="button"
        className="app-color-pick"
        disabled={disabled ?? false}
        aria-label={t("colorpick.pick")}
        onClick={() => {
          void pickColor().then((r) => {
            if (r) onValueChange(r.hex);
          });
        }}
      >
        <Pipette size={12} />
      </button>
    </span>
  );
}
