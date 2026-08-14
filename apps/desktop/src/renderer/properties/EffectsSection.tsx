import {
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Menu } from "@base-ui/react/menu";
import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  MoreHorizontal,
  Pipette,
} from "lucide-react";
import { AppSwitch } from "../components/AppSwitch";
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
import { refusalText } from "../errors/tryMutate";
import { usePointerReorder } from "../hooks/usePointerReorder";
import { listEffects, getDescriptor } from "../render/effects/effectRegistry";
import { autoKeyTrack } from "../keyframe/autoKey";
import { hexToRgb01 } from "../colorpick/pixel";
import { pickColor } from "../colorpick/pickColor";
import {
  clearTransientOverrides,
  setTransientOverrides,
} from "../render/effects/effectOverrides";
import { EffectParamFields } from "./EffectParamField";
import { EffectPicker } from "./EffectPicker";

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
/// EffectPanel for visual Layer kinds only.
export function EffectsSection({ layer, tInLayerUs, playheadInSpan, onMutated }: Props) {
  const { t } = useTranslation();
  const catalog = listEffects();
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

  // Card reorder gesture — mechanics, and why pointer events, never HTML5
  // DnD, live in usePointerReorder.
  const count = layer.effects.length;
  const { drag, indicatorGap, containerRef, setRowEl, startDrag } =
    usePointerReorder({
      rowIds: layer.effects.map((eff) => eff.id),
      onDrop: ({ id, fromIndex, gap }) => {
        const newIndex = gap > fromIndex ? gap - 1 : gap;
        setErr(null);
        moveEffect(layer.id, id, newIndex).then(onMutated).catch((e) => setErr(refusalText(e)));
      },
    });

  const add = (kind: string) => {
    setErr(null);
    addEffect(layer.id, kind).then(onMutated).catch((e) => setErr(refusalText(e)));
  };

  return (
    <section
      ref={containerRef}
      className={drag ? "prop-section prop-effects prop-effects--reordering" : "prop-section prop-effects"}
    >
      {/* No visible heading: the section is the Effect Panel's whole body, so
          a title here only repeats the Panel's own tab. The region still
          carries the name for assistive tech — EffectPanel's aria-label. */}
      {count === 0 ? (
        <p className="prop-effect-blank">{t("effects.empty_chain")}</p>
      ) : (
        <>
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
                drag?.id === eff.id ? "prop-effect-row--dragging" : "",
                indicatorGap === i ? "prop-effect-row--drop-before" : "",
                indicatorGap === count && i === count - 1 ? "prop-effect-row--drop-after" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              rowRef={(el) => setRowEl(i, el)}
              onGripPointerDown={startDrag}
            />
          ))}
          {/* The chain's direction is not inferable from a vertical list —
              state it, because blur→key and key→blur are different images. */}
          <p className="prop-effect-order-hint">{t("effects.order_hint")}</p>
        </>
      )}
      <div className="prop-effect-add">
        <EffectPicker catalog={catalog} onPick={add} disabled={catalog.length === 0} />
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
  /// Reorder-gesture presentation owned by the section (see usePointerReorder).
  rowClassName: string;
  rowRef: (el: HTMLDivElement | null) => void;
  onGripPointerDown: (index: number, e: ReactPointerEvent) => void;
}) {
  const { t } = useTranslation();
  const [err, setErr] = useState<string | null>(null);
  // Session-local card chrome: collapsed state lives on the row (keyed by
  // effect id), so it follows the card across reorders and never enters the
  // persisted Workspace document.
  const [collapsed, setCollapsed] = useState(false);
  const name = t(`effects.${effect.kind}.name`, { defaultValue: effect.kind });
  const descriptor = getDescriptor(effect.kind);
  const run = (fn: () => Promise<unknown>) => () => {
    setErr(null);
    fn().then(onMutated).catch((e) => setErr(refusalText(e)));
  };

  /// Reset every catalog param to its registry default as ONE undoable batch.
  /// Deliberately writes Static tracks: "reset" means back to the default
  /// value, so any keyframes on those params are discarded (one Ctrl+Z away).
  const resetParams = () => {
    const spec = descriptor?.params ?? {};
    const entries: [string, AnimTrack<number>][] = Object.entries(spec).map(([key, s]) => [
      `effects[${effect.id}].params[${key}]`,
      { mode: "Static", value: s.default },
    ]);
    if (entries.length === 0) return Promise.resolve();
    return updateLayerParamTracks(layer.id, entries);
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

  const colorGroups = descriptor?.colorGroups ?? [];

  return (
    <div className={rowClassName} ref={rowRef} data-testid={`effect-row-${index}`}>
      <div className="prop-effect-head">
        {/* Pointer-only reorder affordance. Hidden from the accessibility tree:
            the keyboard path is the move-up/move-down items in the ⋯ menu, and
            a card gesture must never read as a Dockview Panel drag. */}
        <span
          className="prop-effect-grip"
          data-testid={`effect-drag-${index}`}
          aria-hidden="true"
          title={t("effects.drag_hint")}
          onPointerDown={(e) => onGripPointerDown(index, e)}
        >
          <GripVertical size={13} />
        </span>
        {/* Chain position. Without it a one-effect chain looks orderless and a
            multi-effect chain gives no handle for "move the 3rd one up". */}
        <span className="prop-effect-index" aria-hidden="true">
          {index + 1}
        </span>
        <button
          type="button"
          className="prop-effect-title"
          data-testid={`effect-collapse-${index}`}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("effects.expand", { name }) : t("effects.collapse", { name })}
          onClick={() => setCollapsed((next) => !next)}
        >
          <span className="prop-effect-chevron" aria-hidden="true">
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </span>
          <span className="prop-effect-name">{name}</span>
        </button>
        <AppSwitch
          data-testid={`effect-enable-${index}`}
          checked={effect.enabled}
          ariaLabel={t("effects.enable", { name })}
          onCheckedChange={(next) => run(() => updateEffect(layer.id, effect.id, { enabled: next }))()}
        />
        {/* Secondary actions collapse into one overflow menu so the effect name
            stays legible in a docked (narrow) panel. */}
        <Menu.Root>
          <Menu.Trigger
            className="prop-effect-more"
            data-testid={`effect-menu-${index}`}
            aria-label={t("effects.more", { name })}
          >
            <MoreHorizontal size={14} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={4} className="app-popup-positioner">
              <Menu.Popup className="app-menu-list">
                <Menu.Item
                  className="app-menu-item"
                  data-testid={`effect-up-${index}`}
                  disabled={index === 0}
                  onClick={run(() => moveEffect(layer.id, effect.id, index - 1))}
                >
                  <span className="app-menu-item-label">{t("effects.move_up")}</span>
                </Menu.Item>
                <Menu.Item
                  className="app-menu-item"
                  data-testid={`effect-down-${index}`}
                  disabled={index === count - 1}
                  onClick={run(() => moveEffect(layer.id, effect.id, index + 1))}
                >
                  <span className="app-menu-item-label">{t("effects.move_down")}</span>
                </Menu.Item>
                <Menu.Separator className="menu-separator" />
                <Menu.Item
                  className="app-menu-item"
                  data-testid={`effect-reset-${index}`}
                  onClick={run(resetParams)}
                >
                  <span className="app-menu-item-label">{t("effects.reset_params")}</span>
                </Menu.Item>
                <Menu.Separator className="menu-separator" />
                <Menu.Item
                  className="app-menu-item"
                  data-testid={`effect-remove-${index}`}
                  onClick={run(() => removeEffect(layer.id, effect.id))}
                >
                  <span className="app-menu-item-label">{t("effects.remove", { name })}</span>
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
      {!collapsed && (
        <div className="prop-effect-body">
          {/* The eyedropper sits with the params it writes, not in the header:
              it edits three color scalars, so it belongs to the body. */}
          {colorGroups.map((group, gi) => (
            <div className="prop-field prop-effect-colorgroup" key={`cg-${gi}`}>
              <span className="prop-field-label">{t("effects.key_color")}</span>
              <div className="prop-field-control">
                <button
                  type="button"
                  className="app-color-pick"
                  data-testid={`effect-colorpick-${index}`}
                  aria-label={t("colorpick.pick")}
                  onClick={() => void pickColorGroup(group.params)}
                >
                  <Pipette size={12} />
                </button>
              </div>
            </div>
          ))}
          <EffectParamFields
            layer={layer}
            effect={effect}
            tInLayerUs={tInLayerUs}
            playheadInSpan={playheadInSpan}
            onMutated={onMutated}
          />
        </div>
      )}
      {err && <p className="settings-error">{err}</p>}
    </div>
  );
}
