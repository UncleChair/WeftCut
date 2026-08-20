import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Clock } from "lucide-react";
import type { AnimTrack } from "../ipc";
import { updateLayerParamTrack } from "../ipc";
import { logMutationFailure } from "../errors/tryMutate";
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
  commitTrack,
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
  /// Commit sink for the stopwatch's own track writes. When set, the toggle
  /// routes through it INSTEAD of writing updateLayerParamTrack directly (and
  /// the sink owns the refresh) — this is what lets a composite field (linked
  /// scale) fan the lift/collapse out to both axes. Absent = direct write here.
  commitTrack?: (paramKey: string, next: AnimTrack<number>) => void | Promise<void>;
  /// The existing control (slider / number field), already bound to the
  /// parent's display value + commit. Rendered to the right of the stopwatch.
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const lit = track.mode === "Keyframed";
  const disabled = !lit && !playheadInSpan; // can't START animating off-clip
  const toggleLabel = disabled
    ? t("keyframe.stopwatch_offscreen")
    : lit
      ? t("keyframe.stopwatch_disable")
      : t("keyframe.stopwatch_enable");

  const toggle = async () => {
    try {
      const next = lit
        ? collapseToStatic(track, tInLayerUs, fallback)
        : liftToKeyframed(track.mode === "Static" ? track.value : fallback, tInLayerUs);
      if (commitTrack) {
        await commitTrack(paramKey, next); // sink owns the write AND the refresh
      } else {
        await updateLayerParamTrack(layerId, paramKey, next);
        await onMutated();
      }
    } catch (e) {
      logMutationFailure(e, "Toggle keyframes");
    }
  };

  return (
    <div className="anim-field" onFocusCapture={() => setKeyframeFocus(layerId, paramKey)}>
      <button
        type="button"
        className={`anim-stopwatch ${lit ? "is-lit" : ""}`}
        aria-pressed={lit}
        aria-label={toggleLabel}
        disabled={disabled}
        title={toggleLabel}
        onClick={toggle}
      >
        <Clock size={12} aria-hidden />
      </button>
      <span className="anim-field-label">{label}</span>
      <div className="anim-field-control">{children}</div>
    </div>
  );
}
