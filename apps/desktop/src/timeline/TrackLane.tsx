import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LayerBlock, type DragState, type PendingLayerPlacement } from "./LayerBlock";
import { computeLayerSlices } from "./geometry";
import type { LayerSummary, TrackSummary } from "../ipc";

export const MEDIA_DRAG_TYPE = "application/x-weftcut-media";

export interface MediaDragPayload {
  mediaId: string;
  kind: string;
}

export function parseMediaDrag(e: React.DragEvent): MediaDragPayload | null {
  try {
    const raw = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
    if (!raw) return null;
    return JSON.parse(raw) as MediaDragPayload;
  } catch {
    return null;
  }
}

export function TrackLane({
  track,
  pxPerSec,
  height,
  selectedLayerId,
  selectedLayerIds,
  groupByLayerId,
  dragState,
  pendingPlacement,
  pendingLayer,
  dragLayer,
  bladeMode,
  onBladeSplit,
  onSelect,
  onSelectFromClick,
  onDragStart,
  onMediaDrop,
  onContextMenu,
  isGroupStart,
  isRevealed,
  onHeightDragStart,
  fpsNum,
  fpsDen,
}: {
  track: TrackSummary;
  pxPerSec: number;
  height: number;
  selectedLayerId: string | null;
  selectedLayerIds: Set<string>;
  groupByLayerId: Map<string, string>;
  dragState: DragState | null;
  pendingPlacement: PendingLayerPlacement | null;
  pendingLayer: LayerSummary | null;
  dragLayer: LayerSummary | null;
  bladeMode: boolean;
  onBladeSplit: (layer: LayerSummary, clientX: number) => void;
  onSelect: (id: string | null) => void;
  onSelectFromClick: (
    layerId: string,
    e: { altKey: boolean; shiftKey: boolean; metaKey: boolean },
  ) => void;
  onDragStart: (state: DragState) => void;
  onMediaDrop: (
    track: TrackSummary,
    payload: MediaDragPayload,
    e: React.DragEvent<HTMLDivElement>,
  ) => void;
  /// V.7 context-menu hook. LayerBlock fires this on right-click; the
  /// Timeline shows a small floating menu and routes the chosen
  /// action.
  onContextMenu: (
    e: React.MouseEvent,
    layerId: string,
    layerKind: string,
  ) => void;
  isGroupStart: boolean;
  /// R.7 inline-reveal flag. The lane renders with extra chrome
  /// (dashed border / "hidden" badge) so the user knows this row is
  /// only here because they clicked a peek item.
  isRevealed: boolean;
  onHeightDragStart: (e: React.PointerEvent) => void;
  fpsNum: number;
  fpsDen: number;
}) {
  const { t } = useTranslation();
  const kindLabel = t(`kinds.${track.kind.toLowerCase()}`, {
    defaultValue: track.kind,
  });
  const [dragOverX, setDragOverX] = useState<number | null>(null);

  const renderedLayers = useMemo(() => {
    let layers = track.layers;

    if (pendingPlacement && pendingLayer) {
      const pendingRenderLayer = {
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

    if (
      dragState?.kind === "move" &&
      dragLayer &&
      dragState.overTrackId === track.id &&
      dragState.trackId !== track.id &&
      !layers.some((layer) => layer.id === dragLayer.id)
    ) {
      layers = [...layers, dragLayer];
    }

    if (
      dragState?.kind === "move" &&
      dragState.overTrackId !== null &&
      dragState.overTrackId !== track.id &&
      dragState.trackId === track.id
    ) {
      layers = layers.filter((layer) => layer.id !== dragState.layerId);
    }

    return layers;
  }, [
    dragLayer,
    dragState,
    pendingLayer,
    pendingPlacement,
    track.id,
    track.layers,
  ]);

  const onDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      const rect = e.currentTarget.getBoundingClientRect();
      setDragOverX(e.clientX - rect.left);
    },
    [],
  );

  const onDragLeave = useCallback(() => {
    setDragOverX(null);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const payload = parseMediaDrag(e);
      setDragOverX(null);
      if (!payload) return;
      e.preventDefault();
      onMediaDrop(track, payload, e);
    },
    [onMediaDrop, track],
  );

  // Highlight the lane the user is currently dragging an existing layer over.
  const isCrossTrackTarget =
    dragState?.kind === "move" &&
    dragState.overTrackId === track.id &&
    dragState.trackId !== track.id;

  return (
    <div
      className={[
        "relative border-b border-border-soft bg-background",
        isCrossTrackTarget ? "bg-secondary outline outline-1 outline-dashed -outline-offset-1 outline-primary" : "",
        isGroupStart ? "border-t border-t-border" : "",
        isRevealed ? "outline outline-1 outline-dashed -outline-offset-1 outline-blue-400/55 bg-blue-400/5" : "",
      ].join(" ")}
      style={{ height }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onSelect(null);
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="pointer-events-none absolute left-1 top-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {track.label ?? kindLabel}
        {isRevealed && <span className="font-medium text-blue-400/70"> (revealed)</span>}
      </div>
      {dragOverX !== null && (
        <div
          className="pointer-events-none absolute bottom-1 top-1 w-0.5 bg-foreground shadow-[0_0_6px_rgba(255,255,255,0.4)]"
          style={{ left: dragOverX }}
        />
      )}
      {(() => {
        // V.6: compute per-layer slice once per track render. Layers
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
            pxPerSec={pxPerSec}
            laneHeight={height}
            slice={slices.get(layer.id) ?? "full"}
            isPrimary={selectedLayerId === layer.id}
            isSelected={selectedLayerIds.has(layer.id)}
            groupId={groupByLayerId.get(layer.id) ?? null}
            dragState={dragState}
            pendingPlacement={pendingPlacement}
            bladeMode={bladeMode}
            onBladeSplit={onBladeSplit}
            onSelect={onSelect}
            onSelectFromClick={onSelectFromClick}
            onDragStart={onDragStart}
            onContextMenu={onContextMenu}
            fpsNum={fpsNum}
            fpsDen={fpsDen}
          />
        ));
      })()}
      <div
        className="absolute inset-x-0 -bottom-[3px] z-[3] h-1.5 cursor-ns-resize bg-transparent transition-colors duration-75 hover:bg-blue-400/35"
        title={t("timeline.resize_track_hint", {
          defaultValue: "Drag to resize this track",
        })}
        onPointerDown={onHeightDragStart}
      />
    </div>
  );
}
