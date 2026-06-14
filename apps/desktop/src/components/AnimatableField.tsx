import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Clock } from "lucide-react";
import type { AnimTrack } from "../ipc";
import { updateLayerParamTrack } from "../ipc";
import { resolveAnimated } from "../render/animated";
import { collapseToStatic, liftToKeyframed } from "../keyframe/edits";
import { setKeyframeFocus } from "../keyframe/focusStore";

/// The value to show in the control: the static value, or the track evaluated
/// at the playhead-local time when keyframed.
export function displayValue(
  track: AnimTrack<number>,
  tInLayerUs: number,
  fallback: number,
): number {
  return track.mode === "Static" ? track.value : resolveAnimated(track, tInLayerUs, fallback);
}

export function AnimatableField({
  layerId,
  paramKey,
  label,
  track,
  fallback,
  tInLayerUs,
  playheadInSpan,
  onMutated,
  children,
}: {
  layerId: string;
  paramKey: string;
  label: string;
  track: AnimTrack<number>;
  fallback: number;
  /// Playhead time relative to the layer's t_start (may be <0 or > duration).
  tInLayerUs: number;
  /// True when the playhead is within the layer's span — gates keyframe creation.
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
  /// The existing control (slider / number field), already bound to the
  /// parent's display value + commit. Rendered to the right of the stopwatch.
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const lit = track.mode === "Keyframed";
  const disabled = !lit && !playheadInSpan; // can't START animating off-clip

  const toggle = async () => {
    try {
      if (lit) {
        await updateLayerParamTrack(layerId, paramKey, collapseToStatic(track, tInLayerUs, fallback));
      } else {
        const value = track.mode === "Static" ? track.value : fallback;
        await updateLayerParamTrack(layerId, paramKey, liftToKeyframed(value, tInLayerUs));
      }
      await onMutated();
    } catch (e) {
      console.warn("stopwatch toggle failed:", e);
    }
  };

  return (
    <div className="anim-field" onFocusCapture={() => setKeyframeFocus(layerId, paramKey)}>
      <button
        type="button"
        className={`anim-stopwatch ${lit ? "is-lit" : ""}`}
        aria-pressed={lit}
        disabled={disabled}
        title={
          disabled
            ? t("keyframe.stopwatch_offscreen")
            : lit
              ? t("keyframe.stopwatch_disable")
              : t("keyframe.stopwatch_enable")
        }
        onClick={toggle}
      >
        <Clock size={12} aria-hidden />
      </button>
      <span className="anim-field-label">{label}</span>
      <div className="anim-field-control">{children}</div>
    </div>
  );
}
