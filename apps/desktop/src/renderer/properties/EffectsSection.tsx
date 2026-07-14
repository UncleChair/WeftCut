import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pipette } from "lucide-react";
import { AppSelect } from "../components/AppSelect";
import { AppSwitch } from "../components/AppSwitch";
import { Button } from "@/components/ui/button";
import {
  addEffect,
  updateEffect,
  moveEffect,
  removeEffect,
  updateLayerParamTracks,
  type AnimTrack,
  type EffectView,
  type LayerSummary,
} from "../ipc";
import { listEffects, getDescriptor } from "../render/effects/effectRegistry";
import { autoKeyTrack } from "../keyframe/autoKey";
import { hexToRgb01 } from "../colorpick/pixel";
import { pickColor } from "../colorpick/pickColor";
import {
  clearTransientOverrides,
  setTransientOverrides,
} from "../render/effects/effectOverrides";
import { EffectParamFields } from "./EffectParamField";

interface Props {
  layer: LayerSummary;
  /// Playhead relative to the layer's t_start; forwarded to the keyframe rows.
  tInLayerUs: number;
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
}

/// Per-layer effect chain editor. Data-driven off the effect catalog
/// (`listEffects`): the add picker, the row names, and the param rows all come
/// from the registry, so a new filter is zero UI change. Rendered by
/// PropertyPanel for visual layer kinds only.
export function EffectsSection({ layer, tInLayerUs, playheadInSpan, onMutated }: Props) {
  const { t } = useTranslation();
  const catalog = listEffects();
  const [pendingKind, setPendingKind] = useState(catalog[0]?.kind ?? "");
  const [err, setErr] = useState<string | null>(null);

  // A pick session (EffectRow.pickColorGroup) is modal and long-lived. If its
  // own effect is deleted mid-session, the EffectRow holding it unmounts
  // along with it — a ref scoped to that row would go stale at exactly the
  // moment it needs to report "gone". This section-level ref keeps updating
  // on every EffectsSection render regardless of which child rows currently
  // exist, so the commit path's existence check survives the row's unmount
  // (spec error table: effect deleted mid-session → treat as cancel).
  const liveRef = useRef({ layer, tInLayerUs });
  useLayoutEffect(() => {
    liveRef.current = { layer, tInLayerUs };
  }, [layer, tInLayerUs]);

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
          liveRef={liveRef}
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
  liveRef,
}: {
  layer: LayerSummary;
  effect: EffectView;
  index: number;
  count: number;
  tInLayerUs: number;
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
  /// Section-level "freshest known state" ref (see EffectsSection) — read at
  /// commit time instead of this render's closure, which predates the pick
  /// session and can't observe concurrent edits (or this row's own removal).
  liveRef: { current: { layer: LayerSummary; tInLayerUs: number } };
}) {
  const { t } = useTranslation();
  const [err, setErr] = useState<string | null>(null);
  const name = t(`effects.${effect.kind}.name`, { defaultValue: effect.kind });
  const run = (fn: () => Promise<unknown>) => () => {
    setErr(null);
    fn().then(onMutated).catch((e) => setErr(String(e)));
  };

  // Chromakey (and any future color-triplet effect): one eyedropper writes the
  // three scalars as ONE undo entry via the batch API. Hover live-applies
  // through transient overrides (never recorded); pickColor resolving — commit
  // OR cancel — is followed by clearing them, so Esc restores the pre-pick
  // matte. Keyframe semantics per param = autoKeyTrack, identical to a manual
  // number edit.
  const pickColorGroup = async (params: [string, string, string]) => {
    setErr(null);
    const result = await pickColor({
      excludeEffectId: effect.id,
      onHover: (hex) => {
        const [r, g, b] = hexToRgb01(hex);
        setTransientOverrides(effect.id, {
          [params[0]]: r,
          [params[1]]: g,
          [params[2]]: b,
        });
      },
    });
    clearTransientOverrides(effect.id);
    if (!result) return;
    const live = liveRef.current;
    const liveEffect = live.layer.effects.find((f) => f.id === effect.id);
    if (!liveEffect) return; // deleted mid-session → cancel (spec error table)
    const rgb = hexToRgb01(result.hex);
    const spec = getDescriptor(liveEffect.kind)?.params ?? {};
    const entries: [string, AnimTrack<number>][] = params.map((p, i) => [
      `effects[${effect.id}].params[${p}]`,
      autoKeyTrack(
        liveEffect.params[p] ?? { mode: "Static", value: spec[p]?.default ?? 0 },
        live.tInLayerUs,
        rgb[i]!,
      ),
    ]);
    try {
      await updateLayerParamTracks(live.layer.id, entries);
      await onMutated();
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <div className="prop-effect-row" data-testid={`effect-row-${index}`}>
      <div className="prop-effect-head">
        <span className="prop-effect-name">{name}</span>
        {getDescriptor(effect.kind)?.colorGroups?.map((group, gi) => (
          <button
            key={`cg-${gi}`}
            type="button"
            className="app-color-pick"
            data-testid={`effect-colorpick-${index}`}
            aria-label={t("colorpick.pick")}
            onClick={() => void pickColorGroup(group.params)}
          >
            <Pipette size={12} />
          </button>
        ))}
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
