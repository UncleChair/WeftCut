import type { SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Diamond } from "lucide-react";
import type { AnimTrack, Keyframe, TrackSummary } from "../ipc";
import { readParamTrack } from "../keyframe/descriptors";
import { keyAt, prevKeyAt, nextKeyAt, resolveNavLayer } from "../keyframe/nav";
import { upsertKeyframe, removeKeyframe } from "../keyframe/edits";
import { resolveAnimated } from "../render/animated";
import { snapFrameRound } from "../frames";
import { transportSeek } from "../state/playbackStore";
import { selectKeyframe } from "../keyframe/selectionStore";
import { setKeyframeFocus, useKeyframeFocusStore } from "../keyframe/focusStore";

/// AE-style per-property keyframe navigator (◄ ◆ ►) for one sub-lane row.
/// Acts on a single resolved clip (focused clip → sole keyframed clip →
/// disabled, per `resolveNavLayer`): ◄/► seek the playhead to the prev/next
/// key (and select+focus it); ◆ toggles a key at the frame-snapped playhead.
/// Pure-frontend — every mutation goes through `onCommitParamTrack`
/// (→ updateLayerParamTrack), one click = one undo step.
export function KeyframeNavigator({
  track,
  paramKey,
  fallback,
  currentTimeUs,
  fpsNum,
  fpsDen,
  onCommitParamTrack,
}: {
  track: TrackSummary;
  paramKey: string;
  fallback: number;
  currentTimeUs: number;
  fpsNum: number;
  fpsDen: number;
  onCommitParamTrack: (layerId: string, paramKey: string, t: AnimTrack<number>) => void;
}) {
  const { t } = useTranslation();
  // Atomic primitive selector (per the zustand composite-selector rule).
  const focusedLayerId = useKeyframeFocusStore((s) => s.layerId);

  const layer = resolveNavLayer(track, paramKey, focusedLayerId);
  const trk = layer ? readParamTrack(layer.params, paramKey) : null;
  const keyed = trk && trk.mode === "Keyframed" ? trk : null;

  // 0 is a safe dummy when there's no target layer — every query below guards
  // on `keyed` (null whenever `layer` is null), so it's never actually read.
  const tLocalUs = layer ? snapFrameRound(currentTimeUs - layer.t_start_us, fpsNum, fpsDen) : 0;
  const inSpan = layer != null && tLocalUs >= 0 && tLocalUs <= layer.t_end_us - layer.t_start_us;

  const at = keyed ? keyAt(keyed, tLocalUs) : null;
  const prev = keyed ? prevKeyAt(keyed, tLocalUs) : null;
  const next = keyed ? nextKeyAt(keyed, tLocalUs) : null;

  const seekTo = (kf: Keyframe<number>) => {
    if (!layer) return;
    selectKeyframe({ layerId: layer.id, paramKey, kfId: kf.id });
    setKeyframeFocus(layer.id, paramKey);
    transportSeek(layer.t_start_us + kf.t_us);
  };

  const onToggle = () => {
    if (!layer || !keyed) return;
    if (at) {
      onCommitParamTrack(layer.id, paramKey, removeKeyframe(keyed, at.id, fallback));
    } else if (inSpan) {
      onCommitParamTrack(
        layer.id,
        paramKey,
        upsertKeyframe(keyed, tLocalUs, resolveAnimated(keyed, tLocalUs, fallback)),
      );
    }
  };

  // The buttons live inside the timeline root, whose onClick deselects the
  // current layer. Stop the bubble so navigating keys doesn't clear selection.
  const stop = (e: SyntheticEvent) => e.stopPropagation();

  return (
    <div className="flex flex-none items-center gap-0.5" onClick={stop} onPointerDown={stop}>
      <button
        type="button"
        data-testid="kf-nav-prev"
        className="anim-stopwatch"
        disabled={!keyed || !prev}
        title={t("keyframe.nav_prev")}
        aria-label={t("keyframe.nav_prev")}
        onClick={() => prev && seekTo(prev)}
      >
        <ChevronLeft size={12} aria-hidden />
      </button>
      <button
        type="button"
        data-testid="kf-nav-set"
        // is-lit (amber) marks "a key sits on the playhead" — same active-state
        // convention as the inspector stopwatch (AnimatableField).
        className={`anim-stopwatch${at ? " is-lit" : ""}`}
        disabled={!keyed || (!at && !inSpan)}
        aria-pressed={at != null}
        title={t("keyframe.nav_set")}
        aria-label={t("keyframe.nav_set")}
        onClick={onToggle}
      >
        <Diamond size={11} fill={at ? "currentColor" : "none"} aria-hidden />
      </button>
      <button
        type="button"
        data-testid="kf-nav-next"
        className="anim-stopwatch"
        disabled={!keyed || !next}
        title={t("keyframe.nav_next")}
        aria-label={t("keyframe.nav_next")}
        onClick={() => next && seekTo(next)}
      >
        <ChevronRight size={12} aria-hidden />
      </button>
    </div>
  );
}
