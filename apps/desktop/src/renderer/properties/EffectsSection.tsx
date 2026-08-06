import {
  useEffect,
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

// Auto-scroll band and speed for a drag that reaches the panel's edge. The
// Effect panel lives in a scrolling dock host, so a long chain would otherwise
// be unreorderable past the visible rows.
const EDGE_BAND_PX = 28;
const EDGE_SPEED_PX = 12;

/// Nearest scrollable ancestor, or null when the chain fits without scrolling.
function scrollHostOf(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const overflowY = getComputedStyle(n).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      n.scrollHeight > n.clientHeight
    ) {
      return n;
    }
  }
  return null;
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

  // Card reorder gesture state. The ref mirrors the state so the window-level
  // listeners registered once per gesture always read the freshest gap.
  const [drag, setDrag] = useState<ChainDrag | null>(null);
  const dragRef = useRef<ChainDrag | null>(null);
  const setChainDrag = (next: ChainDrag | null) => {
    dragRef.current = next;
    setDrag(next);
  };
  const rowsRef = useRef<(HTMLDivElement | null)[]>([]);
  const sectionRef = useRef<HTMLElement | null>(null);
  const count = layer.effects.length;

  useEffect(() => {
    if (!drag) return;
    // The gap is derived from live rects, so it stays correct while the host
    // auto-scrolls under a stationary pointer.
    const gapAt = (clientY: number) => {
      let gap = 0;
      rowsRef.current.forEach((row, i) => {
        if (!row) return;
        const rect = row.getBoundingClientRect();
        if (clientY > rect.top + rect.height / 2) gap = i + 1;
      });
      return gap;
    };
    const applyGap = (clientY: number) => {
      const current = dragRef.current;
      if (!current) return;
      const gap = gapAt(clientY);
      if (gap !== current.gap) setChainDrag({ ...current, gap });
    };

    // Edge auto-scroll: a rAF pump so holding the pointer at the panel edge
    // keeps scrolling, instead of advancing one step per pointermove event.
    const host = scrollHostOf(sectionRef.current);
    let speed = 0;
    let lastY = 0;
    let raf = 0;
    const pump = () => {
      raf = 0;
      if (!host || speed === 0 || !dragRef.current) return;
      const before = host.scrollTop;
      host.scrollTop += speed;
      if (host.scrollTop !== before) applyGap(lastY);
      raf = requestAnimationFrame(pump);
    };
    const updateAutoScroll = (clientY: number) => {
      lastY = clientY;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      if (clientY < rect.top + EDGE_BAND_PX) speed = -EDGE_SPEED_PX;
      else if (clientY > rect.bottom - EDGE_BAND_PX) speed = EDGE_SPEED_PX;
      else speed = 0;
      if (speed !== 0 && raf === 0) raf = requestAnimationFrame(pump);
    };

    const onMove = (e: PointerEvent) => {
      applyGap(e.clientY);
      updateAutoScroll(e.clientY);
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
      speed = 0;
      if (raf !== 0) cancelAnimationFrame(raf);
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

  const add = (kind: string) => {
    setErr(null);
    addEffect(layer.id, kind).then(onMutated).catch((e) => setErr(String(e)));
  };

  return (
    <section
      ref={sectionRef}
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
  const descriptor = getDescriptor(effect.kind);
  const run = (fn: () => Promise<unknown>) => () => {
    setErr(null);
    fn().then(onMutated).catch((e) => setErr(String(e)));
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
          onPointerDown={(e) => onGripPointerDown(index, effect.id, e)}
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
