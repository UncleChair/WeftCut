import type { SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AnimTrack, TrackSummary } from "../ipc";
import { readParamTrack, type ParamDescriptor } from "../keyframe/descriptors";
import { resolveNavLayer } from "../keyframe/nav";
import { snapFrameRound } from "../frames";
import { useKeyframeFocusStore } from "../keyframe/focusStore";
import { KeyframeField } from "../components/KeyframeField";

/// The editable value for one expanded sub-lane row: the property's value at
/// the frame-snapped playhead, as a compact number field with no stopwatch.
/// Acts on the same resolved clip as the row's navigator (resolveNavLayer →
/// focused clip / sole keyframed clip / none). Editing creates/updates a key
/// at the playhead through the timeline's onCommitParamTrack (one undo step).
export function KeyframeValueField({
  track,
  desc,
  currentTimeUs,
  fpsNum,
  fpsDen,
  onCommitParamTrack,
}: {
  track: TrackSummary;
  desc: ParamDescriptor;
  currentTimeUs: number;
  fpsNum: number;
  fpsDen: number;
  onCommitParamTrack: (layerId: string, paramKey: string, t: AnimTrack<number>) => void;
}) {
  const { t } = useTranslation();
  const focusedLayerId = useKeyframeFocusStore((s) => s.layerId);
  const layer = resolveNavLayer(track, desc.paramKey, focusedLayerId);
  const trk = layer ? readParamTrack(layer.params, desc.paramKey) : null;
  if (!layer || !trk || trk.mode !== "Keyframed") return null;

  const tLocalUs = snapFrameRound(currentTimeUs - layer.t_start_us, fpsNum, fpsDen);
  const inSpan = tLocalUs >= 0 && tLocalUs <= layer.t_end_us - layer.t_start_us;

  // The timeline root's onClick clears the layer selection; stop the bubble so
  // editing the value doesn't deselect (same guard as KeyframeNavigator).
  const stop = (e: SyntheticEvent) => e.stopPropagation();

  // exactOptionalPropertyTypes rejects passing `undefined` for `?: number`
  // props, so spread step/min/max only when set (mirrors InspectorAnimField).
  const bounds = {
    ...(desc.step !== undefined ? { step: desc.step } : {}),
    ...(desc.min !== undefined ? { min: desc.min } : {}),
    ...(desc.max !== undefined ? { max: desc.max } : {}),
  };

  return (
    <div className="kf-value-row mt-0.5 max-w-[7rem]" onClick={stop} onPointerDown={stop}>
      <KeyframeField
        layerId={layer.id}
        paramKey={desc.paramKey}
        label={t(desc.labelKey, { defaultValue: desc.paramKey })}
        track={trk}
        fallback={desc.fallback}
        tInLayerUs={tLocalUs}
        playheadInSpan={inSpan}
        onCommitTrack={(k, next) => onCommitParamTrack(layer.id, k, next)}
        widgets={["number"]}
        {...bounds}
        showStopwatch={false}
        compact
      />
    </div>
  );
}
