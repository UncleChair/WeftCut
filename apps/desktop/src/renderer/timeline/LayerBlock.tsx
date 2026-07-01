import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatTimecode } from "../frames";
import { AppInput } from "../components/AppInput";
import {
  HEADER_COL_PX,
  LAYER_FULL_LABEL_MIN_PX,
  LAYER_LABEL_MIN_PX,
  MIN_LAYER_DURATION_US,
  groupHue,
  keyframeHitTest,
  keyframeXWithinClip,
  type LayerSlice,
} from "./geometry";
import { TimelineVisualPreview } from "./TimelineVisualPreview";
import { useLayerBakePhase } from "./motifBakeStatusStore";
import type { AnimTrack, LayerSummary } from "../ipc";
import { useEditingLayerId, beginRename, endRename } from "./renameStore";
import { useFocusedParamFor } from "../keyframe/focusStore";
import { readParamTrack, animatableParams } from "../keyframe/descriptors";
import { retimeKeyframe, removeKeyframe } from "../keyframe/edits";
import { EasingMenu } from "./EasingMenu";
import { transportSeek } from "../state/playbackStore";
import {
  selectKeyframe,
  clearKeyframeSelection,
  useKeyframeSelectionStore,
} from "../keyframe/selectionStore";

export type DragKind = "move" | "trim-start" | "trim-end";

export interface DragSubject {
  layerId: string;
  trackId: string;
  originalTStart: number;
  originalTEnd: number;
}

export interface DragSeed {
  kind: DragKind;
  layerId: string;
  trackId: string;
  /// Carried so cross-track drops only land on tracks of the same kind.
  trackKind: string;
  startX: number;
  startY: number;
  originalTStart: number;
  originalTEnd: number;
  deltaUs: number;
  /// During cross-track drag, which track is the pointer currently over.
  overTrackId: string | null;
  /// `docs/groups.md` — when true (Alt-held at drag start), this op
  /// stays local even if the dragged layer is in a group. Passed straight
  /// to `moveLayer` / `trimLayer` as `escape_group`.
  escapeGroup: boolean;
}

export interface DragState extends DragSeed {
  subjects: DragSubject[];
}

export interface PendingLayerPlacement {
  layerId: string;
  trackId: string;
  tStartUs: number;
  tEndUs: number;
}

/// Small status dot on a Motif layer block. Phase-only (no count) so it
/// re-renders only on phase change. Hidden when idle (selector returns null).
export function MotifBakeDot({ layerId }: { layerId: string }) {
  const { t } = useTranslation();
  const phase = useLayerBakePhase(layerId);
  if (!phase) return null;
  const label =
    phase === "warming"
      ? t("timeline.bake_dot_warming", { defaultValue: "Warming…" })
      : phase === "baking"
        ? t("timeline.bake_dot_baking", { defaultValue: "Pre-baking…" })
        : phase === "ready"
          ? t("timeline.bake_dot_ready", { defaultValue: "Pre-baked" })
          : t("timeline.bake_dot_error", { defaultValue: "Pre-bake failed" });
  return <span className={`motif-bake-dot is-${phase}`} title={label} aria-label={label} />;
}

function shortLayerLabel(label: string): string {
  const clean = label.trim();
  if (clean.length <= 12) return clean;
  return `${clean.slice(0, 12)}...`;
}

export function LayerBlock({
  layer,
  trackId,
  trackKind,
  trackLocked,
  isTrackExpanded,
  pxPerSec,
  laneHeight,
  slice,
  isPrimary,
  isSelected,
  groupId,
  dragState,
  pendingPlacement,
  bladeMode,
  onBladeSplit,
  onBladePreview,
  onSelectFromClick,
  onDragStart,
  onContextMenu,
  onCommitLabel,
  onCommitParamTrack,
  fpsNum,
  fpsDen,
}: {
  layer: LayerSummary;
  trackId: string;
  trackKind: string;
  /// Track-level lock — blocks move/trim/blade on every layer in the
  /// lane, same affordance as the per-layer lock.
  trackLocked: boolean;
  /// True when this track's keyframe sub-lanes are expanded — collapsed
  /// in-clip diamonds are hidden (the sub-lanes render them instead).
  isTrackExpanded: boolean;
  pxPerSec: number;
  laneHeight: number;
  /// Vertical slot. "full" = entire row; "top" = top half (visual
  /// layer paired with audio); "bottom" = bottom half (audio paired
  /// with visual). Determines the rendered height + top offset.
  slice: LayerSlice;
  /// Primary selection (drives PropertyPanel). One layer at a time.
  isPrimary: boolean;
  /// Member of the current selection set (highlight only).
  isSelected: boolean;
  /// `docs/groups.md` — null when ungrouped.
  groupId: string | null;
  dragState: DragState | null;
  pendingPlacement: PendingLayerPlacement | null;
  /// Blade-tool mode: pointerdown splits at the click point instead
  /// of selecting/dragging. Cursor is set by the `timeline-root-blade`
  /// class (styles.css) via the `timeline-layer` hook class below.
  bladeMode: boolean;
  onBladeSplit: (layer: LayerSummary, clientX: number) => void;
  onBladePreview: (layer: LayerSummary | null, clientX?: number) => void;
  onSelectFromClick: (
    layerId: string,
    e: { altKey: boolean; shiftKey: boolean; metaKey: boolean },
  ) => void;
  onDragStart: (state: DragSeed) => void;
  onContextMenu: (
    e: React.MouseEvent,
    layerId: string,
    layerKind: string,
    layerEnabled: boolean,
  ) => void;
  /// Persist an inline-rename edit. `label` may be empty (clears the custom
  /// label → block falls back to the kind name). Wired by Timeline to
  /// `updateLayer({label}) + onMutated`, matching the drag-commit pattern.
  onCommitLabel: (layerId: string, label: string) => void;
  /// Persist a keyframe track edit (retime or remove). Wired by Timeline to
  /// `updateLayerParamTrack + onMutated`.
  onCommitParamTrack: (layerId: string, paramKey: string, track: AnimTrack<number>) => void;
  fpsNum: number;
  fpsDen: number;
}) {
  const { t } = useTranslation();
  const dragSubject =
    dragState?.subjects.find((subject) => subject.layerId === layer.id) ??
    null;
  const isDragging = dragSubject !== null;
  const isDragAnchor = dragState?.layerId === layer.id;
  const isPendingPlacement = pendingPlacement?.layerId === layer.id;

  const editingLayerId = useEditingLayerId();
  const isEditing = editingLayerId === layer.id;
  const focusedParam = useFocusedParamFor(layer.id);
  const [draft, setDraft] = useState("");
  // Which keyframe on THIS layer+param is selected (null = none). Reads the
  // shared selection store so collapsed + expanded diamonds agree.
  const selectedKfId = useKeyframeSelectionStore((s) =>
    s.selected?.layerId === layer.id && s.selected?.paramKey === focusedParam
      ? s.selected.kfId
      : null,
  );
  const [interpMenu, setInterpMenu] = useState<{ x: number; y: number; kfId: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragTUsRef = useRef<number | null>(null);
  useEffect(() => {
    if (isEditing) {
      setDraft(layer.label ?? "");
      // preventScroll: the timeline is a scroll container, so a plain
      // focus() would scroll the block into view and jolt the timeline.
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    }
  }, [isEditing, layer.id, layer.label]);

  useEffect(() => {
    if (!selectedKfId || !focusedParam) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Delete" && ev.key !== "Backspace") return;
      // A diamond is selected → Delete removes the KEYFRAME, not the layer.
      // Capture phase + stopImmediatePropagation run this before, and preempt,
      // the app-level delete-selected-layer shortcut (also a bare-Delete window
      // listener) so the two can't both fire on one keypress.
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const track = readParamTrack(layer.params, focusedParam);
      if (!track) return;
      const desc = animatableParams(layer.kind).find((d) => d.paramKey === focusedParam);
      onCommitParamTrack(layer.id, focusedParam, removeKeyframe(track, selectedKfId, desc?.fallback ?? 0));
      clearKeyframeSelection();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selectedKfId, focusedParam, layer.id, layer.kind, layer.params, onCommitParamTrack]);

  // Drop the diamond selection when this layer is no longer the primary
  // selection, so the capture-phase Delete handler above can't stay armed
  // after the user moves on (Delete then reverts to deleting the layer).
  useEffect(() => {
    if (!isPrimary) clearKeyframeSelection();
  }, [isPrimary]);

  const commitRename = () => {
    const next = draft.trim();
    if (next !== (layer.label ?? "")) onCommitLabel(layer.id, next);
    endRename();
  };
  let liveStart = isPendingPlacement
    ? pendingPlacement.tStartUs
    : (dragSubject?.originalTStart ?? layer.t_start_us);
  let liveEnd = isPendingPlacement
    ? pendingPlacement.tEndUs
    : (dragSubject?.originalTEnd ?? layer.t_end_us);
  if (dragSubject && dragState) {
    const dx = dragState.deltaUs;
    switch (dragState.kind) {
      case "move": {
        const moveDeltaUs = Math.max(dx, -dragState.originalTStart);
        const durationUs = dragSubject.originalTEnd - dragSubject.originalTStart;
        liveStart = Math.max(0, dragSubject.originalTStart + moveDeltaUs);
        liveEnd = liveStart + durationUs;
        break;
      }
      case "trim-start":
        liveStart = Math.min(
          dragSubject.originalTStart + dx,
          dragSubject.originalTEnd - MIN_LAYER_DURATION_US,
        );
        liveEnd = dragSubject.originalTEnd;
        break;
      case "trim-end":
        liveEnd = Math.max(
          dragSubject.originalTStart + MIN_LAYER_DURATION_US,
          dragSubject.originalTEnd + dx,
        );
        liveStart = dragSubject.originalTStart;
        break;
    }
  }

  const left = (Math.max(0, liveStart) / 1_000_000) * pxPerSec;
  const width = ((liveEnd - liveStart) / 1_000_000) * pxPerSec;
  const kindLabel = t(`kinds.${layer.kind.toLowerCase()}`, {
    defaultValue: layer.kind,
  });
  const label =
    layer.label && layer.label.trim() !== "" ? layer.label : kindLabel;

  // Source copies are normally filtered out for cross-track drag/pending
  // states. If one still renders during a transitional frame, keep it
  // non-interactive and visually secondary.
  const dragPreviewTrackId =
    dragSubject && dragState?.kind === "move"
      ? isDragAnchor
        ? (dragState.overTrackId ?? dragSubject.trackId)
        : dragSubject.trackId
      : null;
  const movedAcrossTracks =
    (dragPreviewTrackId !== null && dragPreviewTrackId !== trackId) ||
    (isPendingPlacement && pendingPlacement.trackId !== trackId);

  // Edge-hover trim: pointerdown within EDGE_ZONE_PX of the layer's
  // left/right edge dispatches trim-start/trim-end; everywhere else
  // dispatches a move. The zone clamps to a third of the chip's width
  // so the two edges never overlap on a narrow clip.
  const EDGE_ZONE_PX = 6;
  const [edgeHover, setEdgeHover] = useState<"left" | "right" | null>(null);

  const edgeZoneFor = (
    clientX: number,
    rect: DOMRect,
  ): "left" | "right" | null => {
    const zone = Math.min(EDGE_ZONE_PX, Math.floor(rect.width / 3));
    if (zone <= 0) return null;
    const rel = clientX - rect.left;
    if (rel < zone) return "left";
    if (rect.width - rel < zone) return "right";
    return null;
  };

  const onPointerMoveHover = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 0) return; // ignore moves with a button held (drag)
    if (bladeMode) {
      if (layer.locked || trackLocked || isDragging) {
        onBladePreview(null);
      } else {
        onBladePreview(layer, e.clientX);
      }
      if (edgeHover !== null) setEdgeHover(null);
      return;
    }
    if (layer.locked || trackLocked || bladeMode || isDragging) {
      if (edgeHover !== null) setEdgeHover(null);
      return;
    }
    const next = edgeZoneFor(
      e.clientX,
      e.currentTarget.getBoundingClientRect(),
    );
    if (next !== edgeHover) setEdgeHover(next);
  };

  const onPointerLeaveHover = () => {
    if (bladeMode) onBladePreview(null);
    if (edgeHover !== null) setEdgeHover(null);
  };

  const onLayerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || layer.locked || trackLocked) return;
    e.stopPropagation();
    // Clicking the clip body (diamond pointerdown stops propagation, so this
    // only fires off-diamond) deselects any selected keyframe → Delete then
    // targets the layer again.
    clearKeyframeSelection();
    // Blade-tool mode hijacks every pointerdown on the layer surface:
    // the click is a cut request, not a select/drag.
    if (bladeMode) {
      onBladeSplit(layer, e.clientX);
      return;
    }
    const zone = edgeZoneFor(
      e.clientX,
      e.currentTarget.getBoundingClientRect(),
    );
    const kind: DragKind =
      zone === "left" ? "trim-start" : zone === "right" ? "trim-end" : "move";
    // `docs/groups.md` — match click-selection semantics on
    // pointerdown so drag and click share the same group-aware path.
    onSelectFromClick(layer.id, {
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
    });
    onDragStart({
      kind,
      layerId: layer.id,
      trackId,
      trackKind,
      startX: e.clientX,
      startY: e.clientY,
      originalTStart: layer.t_start_us,
      originalTEnd: layer.t_end_us,
      deltaUs: 0,
      overTrackId: trackId,
      escapeGroup: e.altKey,
    });
  };

  const layerWidthPx = Math.max(width, 4);
  const showLabel = layerWidthPx >= LAYER_LABEL_MIN_PX;
  const showFullAffordances = layerWidthPx > LAYER_FULL_LABEL_MIN_PX;
  const visibleLabel = showFullAffordances ? label : shortLayerLabel(label);

  // Vertical slot. Each row has a 4px outer breathing room so the
  // chip doesn't touch the row edges. Within that interior:
  //   - "full"   → one block spans top:4 to bottom-4
  //   - "top"    → top half (4 → midline-1)
  //   - "bottom" → bottom half (midline+1 → height-4)
  // The 1px gap at the midline visually separates V from A in the
  // combined-row case so the user sees they're hit-test independent.
  const ROW_PADDING = 4;
  const interiorTop = ROW_PADDING;
  const interiorHeight = Math.max(8, laneHeight - 2 * ROW_PADDING);
  const halfHeight = Math.max(8, Math.floor((interiorHeight - 1) / 2));
  let sliceTop: number;
  let sliceHeight: number;
  if (slice === "full") {
    sliceTop = interiorTop;
    sliceHeight = interiorHeight;
  } else if (slice === "top") {
    sliceTop = interiorTop;
    sliceHeight = halfHeight;
  } else {
    sliceTop = interiorTop + halfHeight + 1;
    sliceHeight = interiorHeight - halfHeight - 1;
  }

  // `docs/groups.md` — tinted left border + chain-link icon hue
  // derived from group_id so all members share an accent color.
  const groupStyle: React.CSSProperties = {};
  if (groupId !== null) {
    const hue = groupHue(groupId);
    groupStyle.borderLeft = `2px solid hsl(${hue} 75% 60%)`;
  }

  const sliceClasses =
    slice === "top"
      ? "rounded-b-none border-b border-b-black/25"
      : slice === "bottom"
        ? "rounded-t-none border-t border-t-white/10"
        : "";

  // Derive from the LIVE edges (not the committed t_end/t_start) so diamond
  // positions stay consistent with `layerWidthPx` during a trim drag; the
  // actor re-bases keyframes on commit, so this is just the in-flight preview.
  const clipDurationUs = liveEnd - liveStart;
  const diamonds = (() => {
    // When the track is expanded the keyframes render in the sub-lanes
    // below (KeyframeLane), so the collapsed in-clip diamonds are hidden.
    if (isTrackExpanded) return [] as { id: string; x: number }[];
    if (!focusedParam) return [] as { id: string; x: number }[];
    const track = readParamTrack(layer.params, focusedParam);
    if (!track || track.mode !== "Keyframed") return [];
    return track.value
      // collapsed mode hides out-of-range keys (kept in data)
      .filter((k) => k.t_us >= 0 && k.t_us <= clipDurationUs)
      .map((k) => ({ id: k.id, x: keyframeXWithinClip(k.t_us, clipDurationUs, layerWidthPx) }));
  })();

  return (
    <div
      className={[
        "timeline-layer", // JS hook for the blade-cursor rule; carries no styles itself.
        "absolute flex items-center rounded border border-white/15 px-2",
        "text-[11px] font-semibold text-background select-none cursor-grab",
        "shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-[outline,filter] duration-75",
        "hover:brightness-110",
        sliceClasses,
        isSelected ? "z-[2]" : "",
        isDragging ? "z-[3] cursor-grabbing brightness-[1.15]" : "",
        // Outline conditionals are mutually exclusive so Tailwind's emit
        // order never decides the conflict: the locked chrome trumps the
        // selected chrome (matching the legacy cascade, where
        // `.is-locked` was declared after `.is-selected`).
        (layer.locked || trackLocked)
          ? "cursor-not-allowed outline outline-1 outline-dashed outline-black/50"
          : isSelected
            ? "outline outline-2 -outline-offset-2 outline-ring"
            : "",
        movedAcrossTracks ? "pointer-events-none" : "",
      ].join(" ")}
      style={{
        left,
        top: sliceTop,
        width: layerWidthPx,
        height: sliceHeight,
        backgroundColor: layer.color_hint,
        backgroundImage:
          "linear-gradient(180deg, rgba(255,255,255,0.10), rgba(0,0,0,0.14))",
        opacity: movedAcrossTracks ? 0.3 : layer.enabled ? 1 : 0.45,
        cursor:
          !layer.locked && !trackLocked && !bladeMode && !isDragging && edgeHover !== null
            ? "ew-resize"
            : undefined,
        ...groupStyle,
      }}
      onClick={(e) => {
        // Selection happens on pointerdown (onLayerPointerDown, which also
        // arms the drag). This handler exists only to stop the click from
        // bubbling to the timeline-root background-deselect — without it,
        // selecting a clip would immediately clear the selection. Ruler-only
        // seek decoupling: selecting a clip must not bubble to the
        // timeline-root background-deselect.
        e.stopPropagation();
      }}
      onDoubleClick={(e) => {
        if (layer.locked || trackLocked || bladeMode) return;
        e.stopPropagation();
        beginRename(layer.id);
      }}
      onPointerDown={onLayerPointerDown}
      onPointerMove={onPointerMoveHover}
      onPointerLeave={onPointerLeaveHover}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // Spec §3: locked layers are unselectable; suppress context menu too.
        if (layer.locked || trackLocked) return;
        onContextMenu(e, layer.id, layer.kind, layer.enabled);
      }}
      title={`${layer.kind}: ${formatTimecode(liveStart, fpsNum, fpsDen)} → ${formatTimecode(liveEnd, fpsNum, fpsDen)}`}
    >
      <TimelineVisualPreview
        layer={layer}
        layerWidthPx={layerWidthPx}
        layerHeightPx={sliceHeight}
      />
      {isEditing && showLabel ? (
        <AppInput
          ref={inputRef}
          // Sticky like the label so the editor appears at the clip's current
          // visible left edge, not its (possibly scrolled-off) absolute start.
          // Width pinned inline because .app-input's width:100% would beat a
          // `w-40` utility class.
          className="sticky z-[2]"
          style={{ left: HEADER_COL_PX + 4, width: "10rem", maxWidth: "100%" }}
          value={draft}
          onValueChange={setDraft}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onBlur={commitRename}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              endRename();
            }
          }}
        />
      ) : showLabel ? (
        <span
          // Sticky so the label stays readable while scrolling a long clip:
          // it pins just past the sticky track-header column and slides along
          // within the clip until the clip's tail scrolls past it. Content-
          // width (capped) so it can actually slide; clips itself with ellipsis.
          className="sticky z-[1] overflow-hidden text-ellipsis whitespace-nowrap rounded-sm bg-black/45 px-1.5 py-0.5 text-[10px] leading-none text-white shadow-[0_1px_2px_rgba(0,0,0,0.35)]"
          style={{
            left: HEADER_COL_PX + 4,
            maxWidth: showFullAffordances
              ? "min(calc(100% - 8px), 240px)"
              : "min(calc(100% - 8px), 120px)",
          }}
        >
          {visibleLabel}
        </span>
      ) : null}
      {layer.kind === "Motif" && showFullAffordances && (
        <MotifBakeDot layerId={layer.id} />
      )}
      {diamonds.length > 0 && focusedParam && (
        <div
          className="kf-diamond-row"
          aria-hidden
          style={{ pointerEvents: "auto" }}
          onContextMenu={(e) => {
            if (!focusedParam) return;
            const track = readParamTrack(layer.params, focusedParam);
            if (!track || track.mode !== "Keyframed") return;
            const rect = e.currentTarget.getBoundingClientRect();
            const hitId = keyframeHitTest(diamonds, e.clientX - rect.left, 6);
            if (!hitId) return;
            e.preventDefault();
            e.stopPropagation();
            setInterpMenu({ x: e.clientX, y: e.clientY, kfId: hitId });
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            const paramTrack = readParamTrack(layer.params, focusedParam);
            if (!paramTrack || paramTrack.mode !== "Keyframed") return;
            const rect = e.currentTarget.getBoundingClientRect();
            const hitId = keyframeHitTest(diamonds, e.clientX - rect.left, 6);
            if (!hitId) return;
            e.stopPropagation();
            const key = paramTrack.value.find((k) => k.id === hitId);
            if (!key) return;
            selectKeyframe({ layerId: layer.id, paramKey: focusedParam, kfId: hitId });
            transportSeek(layer.t_start_us + key.t_us);
            // begin drag-retime
            const startClientX = e.clientX;
            const startTUs = key.t_us;
            const onMove = (me: PointerEvent) => {
              const dxUs = ((me.clientX - startClientX) / pxPerSec) * 1_000_000;
              const nextTUs = Math.max(0, Math.min(clipDurationUs, startTUs + dxUs));
              dragTUsRef.current = nextTUs;
            };
            const onUp = () => {
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", onUp);
              const nextTUs = dragTUsRef.current;
              dragTUsRef.current = null;
              if (nextTUs != null && nextTUs !== startTUs) {
                onCommitParamTrack(layer.id, focusedParam, retimeKeyframe(paramTrack, hitId, nextTUs));
              }
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
          }}
        >
          {diamonds.map((d) => (
            <span
              key={d.id}
              className={`kf-diamond${selectedKfId === d.id ? " is-selected" : ""}`}
              style={{ left: d.x }}
              data-kf-id={d.id}
            />
          ))}
        </div>
      )}
      {interpMenu && focusedParam && (() => {
        const track = readParamTrack(layer.params, focusedParam);
        if (!track || track.mode !== "Keyframed") return null;
        return (
          <EasingMenu
            x={interpMenu.x}
            y={interpMenu.y}
            track={track}
            kfId={interpMenu.kfId}
            onClose={() => setInterpMenu(null)}
            onCommit={(next) => onCommitParamTrack(layer.id, focusedParam, next)}
          />
        );
      })()}
    </div>
  );
}
