import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LayerBlock,
  type DragState,
  type DragSeed,
  type DragSubject,
  type PendingLayerPlacement,
} from "./LayerBlock";
import { computeLayerSlices } from "./geometry";
import { formatTimecode } from "../frames";
import type { AnimTrack, LayerSummary, TrackSummary } from "../ipc";
import { playheadTimeUs } from "../state/playheadStore";
import {
  MEDIA_DRAG_TYPE,
  parseMediaDrag,
  planMediaDrop,
  useMediaDragStore,
  type MediaDragPayload,
  type MediaDropPlan,
  type MediaDropSnapOptions,
} from "./mediaDrag";

export function TrackLane({
  track,
  pxPerSec,
  height,
  isExpanded,
  selectedLayerId,
  selectedLayerIds,
  groupByLayerId,
  dragState,
  pendingPlacements,
  pendingLayerById,
  dragLayerById,
  bladeMode,
  onBladeSplit,
  onBladePreview,
  onSelectFromClick,
  onDragStart,
  onMediaDrop,
  onContextMenu,
  onCommitLabel,
  onCommitParamTrack,
  isGroupStart,
  isRevealed,
  isResizing,
  onHeightDragStart,
  fpsNum,
  fpsDen,
  mediaDropSnap,
}: {
  track: TrackSummary;
  pxPerSec: number;
  height: number;
  /// True when this track's keyframe sub-lanes are expanded — collapsed
  /// in-clip diamonds are hidden (the sub-lanes render them instead).
  isExpanded: boolean;
  selectedLayerId: string | null;
  selectedLayerIds: Set<string>;
  groupByLayerId: Map<string, string>;
  dragState: DragState | null;
  pendingPlacements: PendingLayerPlacement[] | null;
  pendingLayerById: ReadonlyMap<string, LayerSummary>;
  dragLayerById: ReadonlyMap<string, LayerSummary>;
  bladeMode: boolean;
  onBladeSplit: (layer: LayerSummary, clientX: number) => void;
  onBladePreview: (layer: LayerSummary | null, clientX?: number) => void;
  onSelectFromClick: (
    layerId: string,
    e: { altKey: boolean; shiftKey: boolean; metaKey: boolean },
  ) => void;
  onDragStart: (state: DragSeed) => void;
  onMediaDrop: (
    track: TrackSummary,
    payload: MediaDragPayload,
    plan: MediaDropPlan,
  ) => void;
  /// Context-menu hook. LayerBlock fires this on right-click; the
  /// Timeline shows a small floating menu and routes the chosen
  /// action.
  onContextMenu: (
    e: React.MouseEvent,
    layerId: string,
    layerKind: string,
    layerEnabled: boolean,
  ) => void;
  onCommitLabel: (layerId: string, label: string) => void;
  onCommitParamTrack: (layerId: string, paramKey: string, track: AnimTrack<number>) => void;
  isGroupStart: boolean;
  /// Inline-reveal flag. The lane renders with extra chrome
  /// (dashed border / "hidden" badge) so the user knows this row is
  /// only here because they clicked a peek item.
  isRevealed: boolean;
  /// True while any track-height drag is in flight — keeps the resize
  /// handle highlighted even when the pointer wanders off it mid-drag.
  isResizing: boolean;
  onHeightDragStart: (e: React.PointerEvent) => void;
  fpsNum: number;
  fpsDen: number;
  mediaDropSnap: Omit<MediaDropSnapOptions, "currentTimeUs">;
}) {
  const { t } = useTranslation();
  const activeMediaDrag = useMediaDragStore((s) => s.active);
  const dropTargetTrackId = useMediaDragStore((s) => s.dropTargetTrackId);
  const claimDropTarget = useMediaDragStore((s) => s.claimDropTarget);
  const releaseDropTarget = useMediaDragStore((s) => s.releaseDropTarget);
  const endMediaDrag = useMediaDragStore((s) => s.end);
  const [dropPreview, setDropPreview] = useState<{
    media: MediaDragPayload;
    plan: MediaDropPlan;
  } | null>(null);

  useEffect(() => {
    if (activeMediaDrag === null || dropTargetTrackId !== track.id) {
      setDropPreview(null);
    }
  }, [activeMediaDrag, dropTargetTrackId, track.id]);

  const visibleDropPreview =
    dropTargetTrackId === track.id ? dropPreview : null;

  const dragPreviewTrackId = useCallback(
    (subject: DragSubject): string => {
      if (dragState?.kind !== "move") return subject.trackId;
      if (subject.layerId !== dragState.layerId) return subject.trackId;
      return dragState.overTrackId ?? subject.trackId;
    },
    [dragState],
  );

  const renderedLayers = useMemo(() => {
    let layers = track.layers;

    for (const pendingPlacement of pendingPlacements ?? []) {
      const pendingLayer = pendingLayerById.get(pendingPlacement.layerId);
      if (!pendingLayer) continue;
      const pendingRenderLayer: LayerSummary = {
        ...pendingLayer,
        t_start_us: pendingPlacement.tStartUs,
        t_end_us: pendingPlacement.tEndUs,
      };

      if (pendingPlacement.trackId === track.id) {
        let replaced = false;
        layers = layers.map((layer) => {
          if (layer.id !== pendingPlacement.layerId) return layer;
          replaced = true;
          return pendingRenderLayer;
        });
        if (!replaced) layers = [...layers, pendingRenderLayer];
      } else {
        layers = layers.filter(
          (layer) => layer.id !== pendingPlacement.layerId,
        );
      }
    }

    if (dragState?.kind === "move") {
      for (const subject of dragState.subjects) {
        const layer = dragLayerById.get(subject.layerId);
        if (!layer) continue;
        const previewTrackId = dragPreviewTrackId(subject);
        if (previewTrackId === track.id) {
          if (!layers.some((candidate) => candidate.id === layer.id)) {
            layers = [...layers, layer];
          }
        } else if (subject.trackId === track.id) {
          layers = layers.filter((candidate) => candidate.id !== subject.layerId);
        }
      }
    }

    return layers;
  }, [
    dragLayerById,
    dragPreviewTrackId,
    dragState,
    pendingLayerById,
    pendingPlacements,
    track.id,
    track.layers,
  ]);

  const onDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) return;
      e.preventDefault();
      if (activeMediaDrag === null) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const plan = planMediaDrop({
        track,
        media: activeMediaDrag,
        pointerXPx: e.clientX - rect.left,
        pxPerSec,
        fpsNum,
        fpsDen,
        snap: { ...mediaDropSnap, currentTimeUs: playheadTimeUs() },
      });
      e.dataTransfer.dropEffect = plan.validity === "valid" ? "copy" : "none";
      claimDropTarget(track.id);
      setDropPreview({ media: activeMediaDrag, plan });
    },
    [
      activeMediaDrag,
      claimDropTarget,
      fpsDen,
      fpsNum,
      mediaDropSnap,
      pxPerSec,
      track,
    ],
  );

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Crossing a child LayerBlock is not leaving the lane. Without this guard
    // the ghost flickers whenever it passes over existing clip content.
    const rect = e.currentTarget.getBoundingClientRect();
    // Chromium may report (0, 0) as an unavailable-coordinate sentinel for
    // dragleave. Treating it as a real point wedges the first lane's ghost,
    // because that lane commonly begins at the viewport origin.
    const hasPointerCoordinates = e.clientX !== 0 || e.clientY !== 0;
    const pointerStillInside =
      hasPointerCoordinates &&
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    if (
      pointerStillInside ||
      (e.relatedTarget instanceof Node &&
        e.currentTarget.contains(e.relatedTarget))
    ) {
      return;
    }
    releaseDropTarget(track.id);
    setDropPreview(null);
  }, [releaseDropTarget, track.id]);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const payload = parseMediaDrag(e);
      const rect = e.currentTarget.getBoundingClientRect();
      const plan = payload
        ? planMediaDrop({
            track,
            media: payload,
            pointerXPx: e.clientX - rect.left,
            pxPerSec,
            fpsNum,
            fpsDen,
            snap: { ...mediaDropSnap, currentTimeUs: playheadTimeUs() },
          })
        : null;
      setDropPreview(null);
      if (!payload) return;
      e.preventDefault();
      endMediaDrag();
      if (plan?.validity !== "valid") return;
      onMediaDrop(track, payload, plan);
    },
    [
      endMediaDrag,
      fpsDen,
      fpsNum,
      mediaDropSnap,
      onMediaDrop,
      pxPerSec,
      track,
    ],
  );

  // Highlight the lane the user is currently dragging an existing layer over.
  const isCrossTrackTarget =
    dragState?.kind === "move" &&
    dragState.overTrackId === track.id &&
    dragState.trackId !== track.id;

  const dropTargetClass =
    visibleDropPreview?.plan.validity === "collision"
      ? "bg-red-500/10 outline outline-1 outline-dashed -outline-offset-1 outline-red-400/80"
      : visibleDropPreview?.plan.validity === "locked"
        ? "bg-amber-500/10 outline outline-1 outline-dashed -outline-offset-1 outline-amber-400/80"
        : visibleDropPreview !== null
          ? "bg-blue-500/10 outline outline-1 outline-dashed -outline-offset-1 outline-blue-300/80"
          : "";

  let ghostTop = 4;
  let ghostHeight = Math.max(8, height - 8);
  if (visibleDropPreview?.plan.sharesLane) {
    const interiorHeight = Math.max(8, height - 8);
    const halfHeight = Math.max(8, Math.floor((interiorHeight - 1) / 2));
    ghostHeight =
      visibleDropPreview.plan.overlapClass === "visual"
        ? halfHeight
        : interiorHeight - halfHeight - 1;
    if (visibleDropPreview.plan.overlapClass === "audio") {
      ghostTop = 4 + halfHeight + 1;
    }
  }

  return (
    <div
      data-testid="track-lane"
      className={[
        "relative border-b border-border-soft bg-track-lane",
        // Mutually exclusive so emit order never decides which state's
        // chrome wins (drop-target vs revealed); the base bg-track-lane
        // vs branch-bg conflict still resolves by emit order, currently
        // favouring the branches.
        visibleDropPreview !== null
          ? dropTargetClass
          : isCrossTrackTarget
          ? "bg-secondary outline outline-1 outline-dashed -outline-offset-1 outline-primary"
          : isRevealed
            ? "outline outline-1 outline-dashed -outline-offset-1 outline-blue-400/55 bg-blue-400/5"
            : "",
        isGroupStart ? "border-t border-t-border" : "",
      ].join(" ")}
      style={{ height }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {visibleDropPreview !== null && (
        <div
          data-testid="media-drop-ghost"
          data-validity={visibleDropPreview.plan.validity}
          data-start-us={visibleDropPreview.plan.tStartUs}
          data-end-us={visibleDropPreview.plan.tEndUs}
          className={`pointer-events-none absolute z-[5] flex min-w-1 items-center gap-1 overflow-hidden rounded border px-2 text-[10px] font-semibold text-white shadow-[0_3px_10px_rgba(0,0,0,0.4)] ${
            visibleDropPreview.plan.validity === "collision"
              ? "border-red-300 bg-red-500/55"
              : visibleDropPreview.plan.validity === "locked"
                ? "border-amber-300 bg-amber-500/55"
                : "border-blue-200 bg-blue-500/45"
          }`}
          style={{
            left: (visibleDropPreview.plan.tStartUs / 1_000_000) * pxPerSec,
            top: ghostTop,
            width: Math.max(
              4,
              ((visibleDropPreview.plan.tEndUs - visibleDropPreview.plan.tStartUs) /
                1_000_000) *
                pxPerSec,
            ),
            height: ghostHeight,
          }}
          title={`${visibleDropPreview.media.label}: ${formatTimecode(visibleDropPreview.plan.tStartUs, fpsNum, fpsDen)} → ${formatTimecode(visibleDropPreview.plan.tEndUs, fpsNum, fpsDen)}`}
        >
          <span className="min-w-0 truncate">{visibleDropPreview.media.label}</span>
          <span className="shrink-0 opacity-80">
            {formatTimecode(visibleDropPreview.media.durationUs, fpsNum, fpsDen)}
          </span>
          {visibleDropPreview.plan.validity !== "valid" && (
            <span className="ml-auto shrink-0 rounded bg-black/35 px-1 py-0.5">
              {visibleDropPreview.plan.validity === "collision"
                ? t("timeline.drop_collision", { defaultValue: "Overlap" })
                : t("timeline.drop_locked", { defaultValue: "Locked" })}
            </span>
          )}
        </div>
      )}
      {/* Eye-off feedback: dim + freeze the whole layer area. When the
          track is enabled the wrapper is `display: contents` (no box, no
          layout impact); when disabled it's an unpositioned plain div, so
          the absolutely-positioned LayerBlocks still resolve against the
          lane's `relative` box — geometry identical in both states. */}
      <div className={track.enabled ? "contents" : "pointer-events-none opacity-40"}>
      {(() => {
        // Compute per-layer slice once per track render. Layers
        // with a co-located opposite-class layer render half-height
        // (top for visual, bottom for audio) so the user sees both in
        // one row. Single-class layers fill the row at full height.
        const slices = computeLayerSlices(renderedLayers);
        return renderedLayers.map((layer) => (
          <LayerBlock
            key={layer.id}
            layer={layer}
            trackId={track.id}
            trackKind={track.kind}
            trackLocked={track.locked}
            isTrackExpanded={isExpanded}
            pxPerSec={pxPerSec}
            laneHeight={height}
            slice={slices.get(layer.id) ?? "full"}
            isPrimary={selectedLayerId === layer.id}
            isSelected={selectedLayerIds.has(layer.id)}
            groupId={groupByLayerId.get(layer.id) ?? null}
            dragState={dragState}
            pendingPlacement={
              pendingPlacements?.find((placement) => placement.layerId === layer.id) ?? null
            }
            bladeMode={bladeMode}
            onBladeSplit={onBladeSplit}
            onBladePreview={onBladePreview}
            onSelectFromClick={onSelectFromClick}
            onDragStart={onDragStart}
            onContextMenu={onContextMenu}
            onCommitLabel={onCommitLabel}
            onCommitParamTrack={onCommitParamTrack}
            fpsNum={fpsNum}
            fpsDen={fpsDen}
          />
        ));
      })()}
      </div>
      <div
        className={`absolute inset-x-0 -bottom-[3px] z-[3] h-1.5 cursor-ns-resize transition-colors duration-75 hover:bg-blue-400/35 ${isResizing ? "bg-blue-400/35" : "bg-transparent"}`}
        title={t("timeline.resize_track_hint", {
          defaultValue: "Drag to resize this track",
        })}
        onPointerDown={onHeightDragStart}
      />
    </div>
  );
}
