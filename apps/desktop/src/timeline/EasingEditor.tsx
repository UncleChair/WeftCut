import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { AnimTrack, Interpolation } from "../ipc";
import { PRESETS, interpToCoeffs } from "../keyframe/curve";
import { setKeyframeInterp, smoothKeyframe } from "../keyframe/edits";
import { EasingCanvas } from "./EasingCanvas";
import { MotionPreview } from "./MotionPreview";

/// Floating easing editor, anchored to a virtual point at (x, y).
/// Edits the OUTGOING segment of keyframe `kfId` (i.e. kf.interp).
/// Stays open on any interior interaction; closes on outside-click or Escape.
export function EasingEditor({
  x,
  y,
  track,
  kfId,
  onCommit,
  onClose,
}: {
  x: number;
  y: number;
  track: AnimTrack<number>;
  kfId: string;
  onCommit: (next: AnimTrack<number>) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  const current: Interpolation =
    track.mode === "Keyframed"
      ? (track.value.find((k) => k.id === kfId)?.interp ?? { kind: "Linear" })
      : { kind: "Linear" };

  const [coeffs, setCoeffs] = useState<[number, number, number, number]>(() =>
    interpToCoeffs(current),
  );

  const isHold = current.kind === "Hold";

  // Virtual zero-size anchor positioned at the right-click coordinates.
  const anchor = useMemo(
    () => ({
      getBoundingClientRect: () =>
        ({
          x,
          y,
          top: y,
          left: x,
          right: x,
          bottom: y,
          width: 0,
          height: 0,
        }) as DOMRect,
    }),
    [x, y],
  );

  const pickPreset = (interp: Interpolation) => {
    setCoeffs(interpToCoeffs(interp));
    onCommit(setKeyframeInterp(track, kfId, interp));
  };

  const onCurveChange = (next: [number, number, number, number]) => {
    setCoeffs(next);
    onCommit(
      setKeyframeInterp(track, kfId, {
        kind: "Bezier",
        p1: [next[0], next[1]],
        p2: [next[2], next[3]],
      }),
    );
  };

  const doSmooth = () => {
    const smoothed = smoothKeyframe(track, kfId);
    onCommit(smoothed);
    // Sync the canvas/readout/preview to the baked curve (else they show the
    // pre-smooth shape until the popover is reopened).
    if (smoothed.mode === "Keyframed") {
      const kf = smoothed.value.find((k) => k.id === kfId);
      if (kf) setCoeffs(interpToCoeffs(kf.interp));
    }
  };

  return (
    // Popover.Root with modal=false: stays open on interior interaction;
    // closes on outside-click or Escape → onOpenChange fires onClose.
    <PopoverPrimitive.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={4}
          className="z-50"
        >
          <PopoverPrimitive.Popup className="menu-list" style={{ padding: "12px", width: "200px", display: "flex", flexDirection: "column", gap: "8px" }}>
            {/* Section label */}
            <div style={{ fontSize: "11px", color: "var(--muted-foreground, #71717a)" }}>
              {t("keyframe.easing_title")}
            </div>

            {/* Preset chips + Smooth */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  style={{
                    fontSize: "11px",
                    padding: "2px 8px",
                    borderRadius: "4px",
                    border: "1px solid var(--border, #3f3f46)",
                    background: "var(--secondary, #27272a)",
                    color: "var(--foreground, #fafafa)",
                    cursor: "pointer",
                  }}
                  onClick={() => pickPreset(p.interp)}
                >
                  {t(p.labelKey)}
                </button>
              ))}
              <button
                style={{
                  fontSize: "11px",
                  padding: "2px 8px",
                  borderRadius: "4px",
                  border: "1px solid var(--border, #3f3f46)",
                  background: "var(--secondary, #27272a)",
                  color: "var(--foreground, #fafafa)",
                  cursor: "pointer",
                }}
                onClick={doSmooth}
                data-testid="easing-smooth"
              >
                {t("keyframe.smooth")}
              </button>
            </div>

            {/* Curve editor */}
            <EasingCanvas coeffs={coeffs} onChange={onCurveChange} disabled={isHold} />

            {/* cubic-bezier readout */}
            <div
              style={{
                fontFamily: "ui-monospace, monospace",
                fontSize: "10px",
                color: "var(--muted-foreground, #71717a)",
              }}
            >
              cubic-bezier({coeffs.map((c) => c.toFixed(2)).join(", ")})
            </div>

            {/* Motion preview */}
            <MotionPreview coeffs={coeffs} />
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
