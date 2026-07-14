// Small preset/Smooth popover anchored at a click point: applies named easing
// presets / Smooth to one keyframe. In-place curve editing lives in KeyframeCurveGraph.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { AnimTrack } from "../ipc";
import { PRESETS } from "../keyframe/curve";
import { setKeyframeInterp, smoothKeyframe } from "../keyframe/edits";

const CHIP_STYLE: React.CSSProperties = {
  fontSize: "11px",
  padding: "2px 8px",
  borderRadius: "4px",
  border: "1px solid var(--border, #3f3f46)",
  background: "var(--secondary, #27272a)",
  color: "var(--foreground, #fafafa)",
  cursor: "pointer",
};

export function EasingMenu({
  x, y, track, kfId, onCommit, onClose,
}: {
  x: number;
  y: number;
  track: AnimTrack<number>;
  kfId: string;
  onCommit: (next: AnimTrack<number>) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const current =
    track.mode === "Keyframed"
      ? (track.value.find((k) => k.id === kfId)?.interp ?? { kind: "Linear" as const })
      : { kind: "Linear" as const };
  const isHold = current.kind === "Hold";

  const anchor = useMemo(
    () => ({
      getBoundingClientRect: () =>
        ({ x, y, top: y, left: x, right: x, bottom: y, width: 0, height: 0 }) as DOMRect,
    }),
    [x, y],
  );

  return (
    <PopoverPrimitive.Root open modal={false} onOpenChange={(o) => { if (!o) onClose(); }}>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner anchor={anchor} side="bottom" align="start" sideOffset={4} className="z-50">
          <PopoverPrimitive.Popup
            className="menu-list"
            style={{ padding: "6px", display: "flex", flexWrap: "wrap", gap: "4px", width: "168px" }}
          >
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                style={CHIP_STYLE}
                onClick={() => { onCommit(setKeyframeInterp(track, kfId, p.interp)); onClose(); }}
              >
                {t(p.labelKey)}
              </button>
            ))}
            <button
              type="button"
              style={{ ...CHIP_STYLE, cursor: isHold ? "not-allowed" : "pointer", opacity: isHold ? 0.4 : 1 }}
              disabled={isHold}
              data-testid="easing-smooth"
              onClick={() => { onCommit(smoothKeyframe(track, kfId)); onClose(); }}
            >
              {t("keyframe.smooth")}
            </button>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
