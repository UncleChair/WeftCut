// Easing popover anchored at a click point: the full preset gallery (the
// canonical table, family-grouped), Smooth, and — on an Elastic keyframe —
// the amplitude/period sliders. Applies to ONE keyframe's outgoing segment.
// In-place tangent-handle editing lives in KeyframeCurveGraph.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { AnimTrack, Interpolation } from "../ipc";
import {
  EASING_PRESETS,
  presetIdForInterp,
  type EasingPreset,
} from "../../shared/easing";
import { setKeyframeInterp, smoothKeyframe } from "../keyframe/edits";
import { clearEasingPreview, setEasingPreview } from "../keyframe/easingPreviewStore";
import { AppSlider } from "../components/AppSlider";

const CHIP_STYLE: React.CSSProperties = {
  fontSize: "var(--font-size-caption)",
  padding: "2px 8px",
  borderRadius: "var(--radius-control)",
  border: "1px solid var(--border, #3f3f46)",
  background: "var(--secondary, #27272a)",
  color: "var(--foreground, #fafafa)",
  cursor: "pointer",
};

/// The reverse-lookup match — the one chip painted as selected.
const CHIP_SELECTED_STYLE: React.CSSProperties = {
  ...CHIP_STYLE,
  border: "1px solid var(--selection-border, #3b82f6)",
  background: "var(--selection-bg, rgba(59,130,246,0.16))",
};

/// The classic group heads the gallery (table order: linear, hold, and the
/// CSS-named eases); every other id's family is its last `_` segment.
const CLASSIC_IDS = new Set(["linear", "hold", "ease", "ease_in", "ease_out", "ease_in_out"]);

function familyOf(id: string): string {
  if (CLASSIC_IDS.has(id)) return "classic";
  return /_([a-z]+)$/.exec(id)![1]!;
}

/// Gallery rows: consecutive table entries chunked by family, preserving the
/// canonical order (classic first, then sine→bounce). Derived, never a second
/// source — reordering the gallery means reordering the table.
const FAMILY_ROWS: EasingPreset[][] = EASING_PRESETS.reduce<EasingPreset[][]>((rows, p) => {
  const last = rows[rows.length - 1];
  if (last && familyOf(last[0]!.id) === familyOf(p.id)) last.push(p);
  else rows.push([p]);
  return rows;
}, []);

/// Elastic slider ranges. The 1.0 amplitude floor is the schema/engine
/// contract (the engine's phase needs `asin(1/a)` to exist). The ceilings are
/// UI choices: past ~4× amplitude the overshoot dwarfs the segment, and past a
/// 2.0 period less than half an oscillation fits — both defaults (1.0 / 0.3)
/// sit comfortably inside.
const AMPLITUDE_MIN = 1.0;
const AMPLITUDE_MAX = 4.0;
const PERIOD_MIN = 0.05;
const PERIOD_MAX = 2.0;
const PARAM_STEP = 0.05;

const PARAM_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  fontSize: "var(--font-size-caption)",
  color: "var(--muted-foreground, #9ca3af)",
};

/// Amplitude/period sliders for an Elastic keyframe. All three params are
/// pinned at mount and advanced ONLY by drag-local state: every commit is a
/// complete Elastic interp built from that state, never base+delta read back
/// from the track prop — the renderer mirror lags commits by up to two round
/// trips, and a read-modify-write from it eats the previous commit (see
/// feedback_renderer_mirror_read_modify_write). Live redraw goes through
/// easingPreviewStore; the actor commit fires once per gesture on release,
/// matching the tangent-handle undo convention.
function ElasticParamRows({
  kfId,
  interp,
  onCommitInterp,
}: {
  kfId: string;
  interp: Extract<Interpolation, { kind: "Elastic" }>;
  onCommitInterp: (interp: Interpolation) => void;
}) {
  const { t } = useTranslation();
  const [dir] = useState(interp.dir);
  const [amplitude, setAmplitude] = useState(interp.amplitude);
  const [period, setPeriod] = useState(interp.period);
  // Whatever the gesture state, the preview must not outlive the menu.
  useEffect(() => () => clearEasingPreview(kfId), [kfId]);

  const build = (a: number, p: number): Interpolation => ({
    kind: "Elastic",
    dir,
    amplitude: a,
    period: p,
  });

  return (
    <div
      data-testid="easing-elastic-params"
      style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "2px 0" }}
    >
      <div style={PARAM_ROW_STYLE}>
        <span style={{ width: "48px", flexShrink: 0 }}>{t("keyframe.elastic_amplitude")}</span>
        <AppSlider
          value={amplitude}
          min={AMPLITUDE_MIN}
          max={AMPLITUDE_MAX}
          step={PARAM_STEP}
          ariaLabel={t("keyframe.elastic_amplitude")}
          onValueChange={(v) => {
            setAmplitude(v);
            setEasingPreview(kfId, build(v, period));
          }}
          onValueCommitted={(v) => {
            setAmplitude(v);
            onCommitInterp(build(v, period));
          }}
        />
        <span style={{ width: "32px", textAlign: "right" }}>{amplitude.toFixed(2)}</span>
      </div>
      <div style={PARAM_ROW_STYLE}>
        <span style={{ width: "48px", flexShrink: 0 }}>{t("keyframe.elastic_period")}</span>
        <AppSlider
          value={period}
          min={PERIOD_MIN}
          max={PERIOD_MAX}
          step={PARAM_STEP}
          ariaLabel={t("keyframe.elastic_period")}
          onValueChange={(v) => {
            setPeriod(v);
            setEasingPreview(kfId, build(amplitude, v));
          }}
          onValueCommitted={(v) => {
            setPeriod(v);
            onCommitInterp(build(amplitude, v));
          }}
        />
        <span style={{ width: "32px", textAlign: "right" }}>{period.toFixed(2)}</span>
      </div>
    </div>
  );
}

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
  const current: Interpolation =
    track.mode === "Keyframed"
      ? (track.value.find((k) => k.id === kfId)?.interp ?? { kind: "Linear" as const })
      : { kind: "Linear" as const };
  const isHold = current.kind === "Hold";
  // Which chip the current params ARE (display-layer identity): exact reverse
  // lookup, so a hand-dragged bezier or tuned Elastic selects nothing.
  const selectedId = presetIdForInterp(current);

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
        <PopoverPrimitive.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={4}
          className="app-popup-positioner"
        >
          <PopoverPrimitive.Popup
            className="app-menu-list"
            style={{
              padding: "6px",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              width: "252px",
              maxHeight: "320px",
              overflowY: "auto",
            }}
          >
            {current.kind === "Elastic" && (
              <ElasticParamRows
                kfId={kfId}
                interp={current}
                // Full interp from the sliders' drag-local state; the popover
                // stays open so a gesture on the other slider can follow.
                onCommitInterp={(interp) => onCommit(setKeyframeInterp(track, kfId, interp))}
              />
            )}
            {FAMILY_ROWS.map((row) => (
              <div
                key={familyOf(row[0]!.id)}
                style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}
              >
                {row.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    data-testid="easing-preset-chip"
                    aria-pressed={p.id === selectedId}
                    style={p.id === selectedId ? CHIP_SELECTED_STYLE : CHIP_STYLE}
                    onClick={() => {
                      // A preset replaces any slider draft outright — drop the
                      // preview so the gallery commit is what the curve shows.
                      clearEasingPreview(kfId);
                      onCommit(setKeyframeInterp(track, kfId, p.interp));
                      onClose();
                    }}
                  >
                    {t(p.labelKey)}
                  </button>
                ))}
              </div>
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
