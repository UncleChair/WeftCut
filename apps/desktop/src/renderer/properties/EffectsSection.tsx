import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AppSelect } from "../components/AppSelect";
import { AppSwitch } from "../components/AppSwitch";
import { Button } from "@/components/ui/button";
import { addEffect, updateEffect, moveEffect, removeEffect, type EffectView, type LayerSummary } from "../ipc";
import { listEffects } from "../render/effects/effectRegistry";
import { EffectParamFields } from "./EffectParamField";

interface Props {
  layer: LayerSummary;
  /// Playhead relative to the layer's t_start; forwarded to the keyframe rows.
  tInLayerUs: number;
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
}

/// Per-layer effect chain editor. Data-driven off the effect catalog
/// (`listEffects`): the add picker, the row names, and (Task 6) the param rows
/// all come from the registry, so a new filter is zero UI change. Rendered by
/// PropertyPanel for visual layer kinds only.
export function EffectsSection({ layer, tInLayerUs, playheadInSpan, onMutated }: Props) {
  const { t } = useTranslation();
  const catalog = listEffects();
  const [pendingKind, setPendingKind] = useState(catalog[0]?.kind ?? "");
  const [err, setErr] = useState<string | null>(null);

  const add = () => {
    setErr(null);
    addEffect(layer.id, pendingKind).then(onMutated).catch((e) => setErr(String(e)));
  };

  return (
    <section className="prop-section">
      <h3>{t("effects.heading")}</h3>
      {layer.effects.map((eff, i) => (
        <EffectRow
          key={eff.id}
          layer={layer}
          effect={eff}
          index={i}
          count={layer.effects.length}
          tInLayerUs={tInLayerUs}
          playheadInSpan={playheadInSpan}
          onMutated={onMutated}
        />
      ))}
      <div className="prop-effect-add">
        <AppSelect
          value={pendingKind}
          ariaLabel={t("effects.add")}
          onValueChange={setPendingKind}
          options={catalog.map((d) => ({ value: d.kind, label: t(d.nameI18nKey, { defaultValue: d.kind }) }))}
        />
        <Button size="sm" data-testid="effect-add" disabled={!pendingKind} onClick={add}>
          {t("effects.add")}
        </Button>
      </div>
      {err && <p className="settings-error">{err}</p>}
    </section>
  );
}

function EffectRow({
  layer,
  effect,
  index,
  count,
  tInLayerUs,
  playheadInSpan,
  onMutated,
}: {
  layer: LayerSummary;
  effect: EffectView;
  index: number;
  count: number;
  tInLayerUs: number;
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [err, setErr] = useState<string | null>(null);
  const name = t(`effects.${effect.kind}.name`, { defaultValue: effect.kind });
  const run = (fn: () => Promise<unknown>) => () => {
    setErr(null);
    fn().then(onMutated).catch((e) => setErr(String(e)));
  };

  return (
    <div className="prop-effect-row" data-testid={`effect-row-${index}`}>
      <div className="prop-effect-head">
        <span className="prop-effect-name">{name}</span>
        <AppSwitch
          data-testid={`effect-enable-${index}`}
          checked={effect.enabled}
          ariaLabel={t("effects.enable", { name })}
          onCheckedChange={(next) => run(() => updateEffect(layer.id, effect.id, { enabled: next }))()}
        />
        <Button
          size="sm"
          data-testid={`effect-up-${index}`}
          aria-label={t("effects.move_up")}
          disabled={index === 0}
          onClick={run(() => moveEffect(layer.id, effect.id, index - 1))}
        >
          ↑
        </Button>
        <Button
          size="sm"
          data-testid={`effect-down-${index}`}
          aria-label={t("effects.move_down")}
          disabled={index === count - 1}
          onClick={run(() => moveEffect(layer.id, effect.id, index + 1))}
        >
          ↓
        </Button>
        <Button
          size="sm"
          data-testid={`effect-remove-${index}`}
          aria-label={t("effects.remove", { name })}
          onClick={run(() => removeEffect(layer.id, effect.id))}
        >
          ✕
        </Button>
      </div>
      <EffectParamFields
        layer={layer}
        effect={effect}
        tInLayerUs={tInLayerUs}
        playheadInSpan={playheadInSpan}
        onMutated={onMutated}
      />
      {err && <p className="settings-error">{err}</p>}
    </div>
  );
}
