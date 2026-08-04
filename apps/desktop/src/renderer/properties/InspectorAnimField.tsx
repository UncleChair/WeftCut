import { useTranslation } from "react-i18next";
import { KeyframeField } from "../components/KeyframeField";
import { updateLayerParamTrack, updateLayerParamTracks, type LayerSummary } from "../ipc";
import { readParamTrack, type ParamDescriptor } from "../keyframe/descriptors";
import { fanOutEntries } from "../keyframe/fanOut";

/// Inspector adapter: maps a (layer, ParamDescriptor) pair onto the shared
/// KeyframeField with the stopwatch + the inspector commit path;
/// widgets/step/min/max come from the descriptor (keyframe/descriptors.ts).
///
/// A composite descriptor (fanOutKeys) writes the authored track to every
/// listed key in ONE plural batch — the linked-scale twin write. The
/// stopwatch shares this sink (KeyframeField forwards it), so lift/collapse
/// fans out too and the twin invariant holds on every inspector write path.
export function InspectorAnimField({
  layer,
  desc,
  tInLayerUs,
  playheadInSpan,
  onMutated,
}: {
  layer: LayerSummary;
  desc: ParamDescriptor;
  tInLayerUs: number;
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const track = readParamTrack(layer.params, desc.paramKey) ?? { mode: "Static" as const, value: desc.fallback };
  const fanOut = desc.fanOutKeys;
  return (
    <KeyframeField
      layerId={layer.id}
      paramKey={desc.paramKey}
      label={t(desc.labelKey)}
      track={track}
      fallback={desc.fallback}
      tInLayerUs={tInLayerUs}
      playheadInSpan={playheadInSpan}
      onCommitTrack={(k, next) =>
        (fanOut
          ? updateLayerParamTracks(layer.id, fanOutEntries(fanOut, next))
          : updateLayerParamTrack(layer.id, k, next)
        ).then(onMutated).catch((e) => console.warn(e))
      }
      onMutated={onMutated}
      widgets={desc.widgets ?? ["number"]}
      {...(desc.step !== undefined ? { step: desc.step } : {})}
      {...(desc.min !== undefined ? { min: desc.min } : {})}
      {...(desc.max !== undefined ? { max: desc.max } : {})}
    />
  );
}
