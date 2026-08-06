import { useTranslation } from "react-i18next";
import { KeyframeField } from "../components/KeyframeField";
import { updateLayerParamTrack, type AnimTrack, type EffectView, type LayerSummary } from "../ipc";
import { getDescriptor, type EffectParamSpec } from "../render/effects/effectRegistry";

/// One keyframe-capable row per registry param of `effect`, reusing the shared
/// KeyframeField (stopwatch + auto-key) exactly like the transform/opacity rows.
/// The wire key is `effects[<id>].params[<key>]`, which `update_layer_param_track`
/// resolves and lazily creates on first write. Unknown kinds (absent from the
/// catalog) render no params.
export function EffectParamFields({
  layer,
  effect,
  tInLayerUs,
  playheadInSpan,
  onMutated,
}: {
  layer: LayerSummary;
  effect: EffectView;
  tInLayerUs: number;
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
}) {
  const desc = getDescriptor(effect.kind);
  if (!desc) return null;
  return (
    <>
      {Object.entries(desc.params).map(([key, spec]) => (
        <EffectParamField
          key={key}
          layer={layer}
          effect={effect}
          paramName={key}
          spec={spec}
          tInLayerUs={tInLayerUs}
          playheadInSpan={playheadInSpan}
          onMutated={onMutated}
        />
      ))}
    </>
  );
}

function EffectParamField({
  layer,
  effect,
  paramName,
  spec,
  tInLayerUs,
  playheadInSpan,
  onMutated,
}: {
  layer: LayerSummary;
  effect: EffectView;
  paramName: string;
  spec: EffectParamSpec;
  tInLayerUs: number;
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const paramKey = `effects[${effect.id}].params[${paramName}]`;
  // Absent slot ⇒ the registry default.
  const track: AnimTrack<number> = effect.params[paramName] ?? { mode: "Static", value: spec.default };
  const label = t(`effects.${effect.kind}.params.${paramName}`, { defaultValue: paramName });
  const step = spec.step ?? (spec.range && spec.range[1] - spec.range[0] <= 10 ? 0.1 : 1);
  // Wrapper carries a stable testid (effect id + param) so the e2e can target
  // this exact field; KeyframeField/AppNumberField don't take a testid prop.
  return (
    <div className="prop-effect-param" data-testid={`effect-param-${effect.id}-${paramName}`}>
      <KeyframeField
        layerId={layer.id}
        paramKey={paramKey}
        label={label}
        track={track}
        fallback={spec.default}
        tInLayerUs={tInLayerUs}
        playheadInSpan={playheadInSpan}
        onCommitTrack={(k, next) => updateLayerParamTrack(layer.id, k, next).then(onMutated).catch((e) => console.warn(e))}
        onMutated={onMutated}
        widgets={["number"]}
        step={step}
        {...(spec.range ? { min: spec.range[0], max: spec.range[1] } : {})}
      />
    </div>
  );
}
