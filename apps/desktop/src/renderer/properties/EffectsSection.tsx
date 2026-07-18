import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, GripVertical, Pipette } from "lucide-react";
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

/// An in-progress card reorder gesture. `gap` is the insertion slot in
/// [0..count]: the dragged card would land before row `gap`. Pure pointer
/// events — never HTML5 drag-and-drop — so a card gesture can never become a
/// Dockview Panel dock drag. Exactly one moveEffect command fires, at drop.
interface ChainDrag {
  layerId: string;
  effectId: string;
  fromIndex: number;
  gap: number;
}

/// Dropping on the card's own origin gap (or its own following gap, the same
/// position) leaves the chain untouched — no indicator, no command.
function isNoopGap(gap: number, fromIndex: number): boolean {
  return gap === fromIndex || gap === fromIndex + 1;
}

/// Per-layer effect chain editor. Data-driven off the effect catalog
/// (`listEffects`): the add picker, the row names, and the param rows all come
/// from the registry, so a new filter is zero UI change. Rendered by
/// EffectPanel for visual Layer kinds only.
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

  // Card reorder gesture state. The ref mirrors the state so the window-level
  // listeners registered once per gesture always read the freshest gap.
  const [drag, setDrag] = useState<ChainDrag | null>(null);
  const dragRef = useRef<ChainDrag | null>(null);
  const setChainDrag = (next: ChainDrag | null) => {
    dragRef.current = next;
    setDrag(next);
  };
  const rowsRef = useRef<(HTMLDivElement | null)[]>([]);
  const count = layer.effects.length;

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      let gap = 0;
      rowsRef.current.forEach((row, i) => {
        if (!row) return;
        const rect = row.getBoundingClientRect();
        if (e.clientY > rect.top + rect.height / 2) gap = i + 1;
      });
      if (gap !== current.gap) setChainDrag({ ...current, gap });
    };
    const onUp = () => {
      const current = dragRef.current;
      setChainDrag(null);
      if (!current) return;
      const { layerId, effectId, fromIndex, gap } = current;
      if (isNoopGap(gap, fromIndex)) return;
      const newIndex = gap > fromIndex ? gap - 1 : gap;
      setErr(null);
      moveEffect(layerId, effectId, newIndex).then(onMutated).catch((e) => setErr(String(e)));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChainDrag(null);
    };
    // A browser-aborted gesture (pointercancel) must not stay armed: the next
    // unrelated pointerup would otherwise commit an unintended move.
    const onCancel = () => setChainDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
    };
    // onMutated is re-read per gesture; the listeners live exactly one gesture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  const startChainDrag = (index: number, effectId: string, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection or native drag out of the grip
    // Pointer capture keeps the gesture's release delivered even off-window;
    // jsdom lacks the API, so it is best-effort only (tests drive window).
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // Not every embedder supports capture; window listeners still own the gesture.
    }
    setChainDrag({ layerId: layer.id, effectId, fromIndex: index, gap: index });
  };

  const indicatorGap = drag && !isNoopGap(drag.gap, drag.fromIndex) ? drag.gap : null;

  const add = () => {
    setErr(null);
    addEffect(layer.id, pendingKind).then(onMutated).catch((e) => setErr(String(e)));
  };

  return (
    <section className={drag ? "prop-section prop-effects--reordering" : "prop-section"}>
      <h3>{t("effects.heading")}</h3>
      {layer.effects.map((eff, i) => (
        <EffectRow
          key={eff.id}
          layer={layer}
          effect={eff}
          index={i}
          count={count}
          tInLayerUs={tInLayerUs}
          playheadInSpan={playheadInSpan}
          onMutated={onMutated}
          liveRef={liveRef}
          rowClassName={[
            "prop-effect-row",
            drag?.effectId === eff.id ? "prop-effect-row--dragging" : "",
            indicatorGap === i ? "prop-effect-row--drop-before" : "",
            indicatorGap === count && i === count - 1 ? "prop-effect-row--drop-after" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          rowRef={(el) => {
            rowsRef.current[i] = el;
          }}
          onGripPointerDown={startChainDrag}
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
  rowClassName,
  rowRef,
  onGripPointerDown,
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
  /// Reorder-gesture presentation owned by the section (see ChainDrag).
  rowClassName: string;
  rowRef: (el: HTMLDivElement | null) => void;
  onGripPointerDown: (index: number, effectId: string, e: ReactPointerEvent) => void;
}) {
  const { t } = useTranslation();
  const [err, setErr] = useState<string | null>(null);
  // Session-local card chrome: collapsed state lives on the row (keyed by
  // effect id), so it follows the card across reorders and never enters the
  // persisted Workspace document.
  const [collapsed, setCollapsed] = useState(false);
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
    <div className={rowClassName} ref={rowRef} data-testid={`effect-row-${index}`}>
      <div className="prop-effect-head">
        {/* Pointer-only reorder affordance. Hidden from the accessibility tree:
            the keyboard path is the adjacent move-up/move-down buttons, and a
            card gesture must never read as a Dockview Panel drag. */}
        <span
          className="prop-effect-grip"
          data-testid={`effect-drag-${index}`}
          aria-hidden="true"
          onPointerDown={(e) => onGripPointerDown(index, effect.id, e)}
        >
          <GripVertical size={12} />
        </span>
        <button
          type="button"
          className="app-color-pick prop-effect-collapse"
          data-testid={`effect-collapse-${index}`}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("effects.expand", { name }) : t("effects.collapse", { name })}
          onClick={() => setCollapsed((next) => !next)}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
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
      {!collapsed && (
        <EffectParamFields
          layer={layer}
          effect={effect}
          tInLayerUs={tInLayerUs}
          playheadInSpan={playheadInSpan}
          onMutated={onMutated}
        />
      )}
      {err && <p className="settings-error">{err}</p>}
    </div>
  );
}
