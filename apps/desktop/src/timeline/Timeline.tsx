import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  addMediaLayer,
  moveLayer,
  updateLayer,
  type LayerSummary,
  type TrackSummary,
} from "../ipc";
import { WaveformCanvas } from "./WaveformCanvas";

interface TimelineProps {
  tracks: TrackSummary[];
  durationUs: number;
  currentTimeUs: number;
  selectedLayerId: string | null;
  onSelect: (id: string | null) => void;
  onSeek: (tUs: number) => void;
  onMutated: () => Promise<void>;
}

const PX_PER_SEC = 80;
const TRACK_HEIGHT = 36;
const MIN_LAYER_DURATION_US = 100_000;

const MEDIA_DRAG_TYPE = "application/x-weftcut-media";

interface MediaDragPayload {
  mediaId: string;
  kind: string;
}

function parseMediaDrag(e: React.DragEvent): MediaDragPayload | null {
  try {
    const raw = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
    if (!raw) return null;
    return JSON.parse(raw) as MediaDragPayload;
  } catch {
    return null;
  }
}

function trackAcceptsMedia(trackKind: string, mediaKind: string): boolean {
  const t = trackKind.toLowerCase();
  const m = mediaKind.toLowerCase();
  if (t === "video") return m === "video" || m === "image";
  if (t === "audio") return m === "audio";
  if (t === "subtitle") return m === "subtitle";
  return false;
}

interface VisualTrack {
  track: TrackSummary;
  /// True when this is the first lane of its kind group — the renderer adds
  /// a divider line above it.
  isGroupStart: boolean;
}

// Group tracks by kind so the user sees a Premiere-style stack:
//
//   ┌────────────┐ Video (top of z-stack at the top of the group; default
//   │ Video B    │ A roll at the bottom)
//   │ Video A    │
//   ├────────────┤ ── divider
//   │ Subtitles  │ Subtitle tracks (rare; sit between video and audio)
//   ├────────────┤ ── divider
//   │ Audio      │ Audio tracks at the bottom (no z-stack interaction; we
//   └────────────┘ just want them visually below video)
//
// Within each group, lower-index data slots render BELOW higher-index ones
// (matches the existing z-stack convention: tracks[last] = top of z-stack).
function visualOrderedTracks(tracks: TrackSummary[]): VisualTrack[] {
  const video = tracks.filter((t) => t.kind.toLowerCase() === "video").slice().reverse();
  const subtitle = tracks.filter((t) => t.kind.toLowerCase() === "subtitle").slice().reverse();
  const audio = tracks.filter((t) => t.kind.toLowerCase() === "audio").slice().reverse();
  const out: VisualTrack[] = [];
  for (const group of [video, subtitle, audio]) {
    group.forEach((track, i) => {
      out.push({ track, isGroupStart: i === 0 && out.length > 0 });
    });
  }
  return out;
}

// Some media kinds (audio, subtitle) must live on a matching track kind for
// the IR lowering to pick them up. The backend auto-creates / redirects to
// that track on drop, so the drop-hit test should also accept these onto any
// track to mirror that behaviour.
function trackAcceptsMediaForAutoRoute(_trackKind: string, mediaKind: string): boolean {
  const m = mediaKind.toLowerCase();
  return m === "audio" || m === "subtitle";
}

type DragKind = "move" | "trim-start" | "trim-end";

interface DragState {
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
}

export function Timeline({
  tracks,
  durationUs,
  currentTimeUs,
  selectedLayerId,
  onSelect,
  onSeek,
  onMutated,
}: TimelineProps) {
  const totalSec = Math.max(durationUs / 1_000_000, 5);
  const widthPx = totalSec * PX_PER_SEC;
  const [drag, setDrag] = useState<DragState | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const orderedTracks = visualOrderedTracks(tracks);

  const trackUnderPointer = useCallback(
    (clientY: number): TrackSummary | null => {
      if (!canvasRef.current) return null;
      const rect = canvasRef.current.getBoundingClientRect();
      const y = clientY - rect.top;
      const visualIdx = Math.floor(y / TRACK_HEIGHT);
      if (visualIdx < 0 || visualIdx >= orderedTracks.length) return null;
      // Map screen-row index → the right data track via the visual ordering
      // (video → subtitle → audio, each kind already z-stack-reversed).
      return orderedTracks[visualIdx]?.track ?? null;
    },
    [orderedTracks],
  );

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (!drag) return;
      const deltaPx = e.clientX - drag.startX;
      const deltaUs = (deltaPx / PX_PER_SEC) * 1_000_000;
      const overTrack =
        drag.kind === "move" ? trackUnderPointer(e.clientY) : null;
      setDrag({
        ...drag,
        deltaUs,
        overTrackId: overTrack?.id ?? null,
      });
    },
    [drag, trackUnderPointer],
  );

  const handlePointerUp = useCallback(
    async (e: PointerEvent) => {
      if (!drag) return;
      const deltaPx = e.clientX - drag.startX;
      const deltaUs = Math.round((deltaPx / PX_PER_SEC) * 1_000_000);
      const overTrack =
        drag.kind === "move" ? trackUnderPointer(e.clientY) : null;
      const committed = drag;
      setDrag(null);

      // Treat tiny deltas + same track as a no-op so a click doesn't accidentally
      // shove a layer one frame.
      const sameTrack =
        !overTrack || overTrack.id === committed.trackId;
      if (Math.abs(deltaUs) < 1_000 && sameTrack) return;

      try {
        switch (committed.kind) {
          case "move": {
            const newStart = Math.max(0, committed.originalTStart + deltaUs);
            const destTrackId =
              overTrack && trackAcceptsForLayer(overTrack, committed)
                ? overTrack.id
                : committed.trackId;
            await moveLayer(committed.layerId, destTrackId, newStart);
            break;
          }
          case "trim-start": {
            const newStart = Math.max(
              0,
              Math.min(
                committed.originalTStart + deltaUs,
                committed.originalTEnd - MIN_LAYER_DURATION_US,
              ),
            );
            await updateLayer(committed.layerId, { t_start_us: newStart });
            break;
          }
          case "trim-end": {
            const newEnd = Math.max(
              committed.originalTStart + MIN_LAYER_DURATION_US,
              committed.originalTEnd + deltaUs,
            );
            await updateLayer(committed.layerId, { t_end_us: newEnd });
            break;
          }
        }
        await onMutated();
      } catch (err) {
        console.error("timeline commit failed:", err);
      }
    },
    [drag, onMutated, trackUnderPointer],
  );

  useEffect(() => {
    if (!drag) return;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [drag, handlePointerMove, handlePointerUp]);

  const onMediaDrop = useCallback(
    async (
      track: TrackSummary,
      payload: MediaDragPayload,
      e: React.DragEvent<HTMLDivElement>,
    ) => {
      if (
        !trackAcceptsMedia(track.kind, payload.kind) &&
        !trackAcceptsMediaForAutoRoute(track.kind, payload.kind)
      ) {
        console.warn(
          `track ${track.kind} doesn't accept media of kind ${payload.kind}`,
        );
        return;
      }
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const tStartUs = Math.max(0, Math.round((x / PX_PER_SEC) * 1_000_000));
      try {
        await addMediaLayer(track.id, payload.mediaId, tStartUs);
        await onMutated();
      } catch (err) {
        console.error("media drop failed:", err);
      }
    },
    [onMutated],
  );

  const playheadX = (currentTimeUs / 1_000_000) * PX_PER_SEC;

  const seekFromClientX = useCallback(
    (clientX: number) => {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      onSeek(Math.max(0, Math.round((x / PX_PER_SEC) * 1_000_000)));
    },
    [onSeek],
  );

  // Click/drag on empty canvas (lane background, gap below tracks) to seek.
  // Layer / trim-handle pointerdown stops propagation, so this never fires
  // when interacting with an existing layer.
  const onCanvasPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      seekFromClientX(e.clientX);
      const onMove = (ev: PointerEvent) => seekFromClientX(ev.clientX);
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [seekFromClientX],
  );

  return (
    <div
      className={`timeline-root ${drag ? "is-dragging" : ""}`}
      onClick={() => onSelect(null)}
      onPointerDown={onCanvasPointerDown}
    >
      <div
        ref={canvasRef}
        className="timeline-canvas"
        style={{ width: Math.max(widthPx, 200) }}
      >
        {tracks.length === 0 && <EmptyHint />}
        {/*
          Data model: `tracks[0]` is the bottom of the z-stack, `tracks[last]`
          is the top (see `Project::tracks` doc-comment). The visual order
          groups by kind (Video on top, then Subtitle, then Audio at the
          bottom — Premiere/Resolve/FCP convention) and within each group is
          z-stack-reversed so the top of the group is the top of z-stack.
        */}
        {orderedTracks.map(({ track, isGroupStart }) => (
          <TrackLane
            key={track.id}
            track={track}
            pxPerSec={PX_PER_SEC}
            selectedLayerId={selectedLayerId}
            dragState={drag}
            onSelect={onSelect}
            onDragStart={(state) => setDrag(state)}
            onMediaDrop={onMediaDrop}
            isGroupStart={isGroupStart}
          />
        ))}
      </div>
      {currentTimeUs >= 0 && (
        <div
          className="timeline-playhead"
          style={{ left: playheadX }}
        >
          <div className="playhead-knob" />
        </div>
      )}
    </div>
  );
}

/// Cross-track drop only allowed within the same track kind. Cross-kind moves
/// (e.g. video clip → audio track) would leave the layer in a state the IR
/// compiler ignores, so we reject at the UI layer.
function trackAcceptsForLayer(target: TrackSummary, drag: DragState): boolean {
  return target.kind.toLowerCase() === drag.trackKind.toLowerCase();
}

function EmptyHint() {
  const { t } = useTranslation();
  return (
    <div className="timeline-empty">{t("timeline.empty_placeholder")}</div>
  );
}

function TrackLane({
  track,
  pxPerSec,
  selectedLayerId,
  dragState,
  onSelect,
  onDragStart,
  onMediaDrop,
  isGroupStart,
}: {
  track: TrackSummary;
  pxPerSec: number;
  selectedLayerId: string | null;
  dragState: DragState | null;
  onSelect: (id: string | null) => void;
  onDragStart: (state: DragState) => void;
  onMediaDrop: (
    track: TrackSummary,
    payload: MediaDragPayload,
    e: React.DragEvent<HTMLDivElement>,
  ) => void;
  isGroupStart: boolean;
}) {
  const { t } = useTranslation();
  const kindLabel = t(`kinds.${track.kind.toLowerCase()}`, {
    defaultValue: track.kind,
  });
  const [dragOverX, setDragOverX] = useState<number | null>(null);

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
      className={`timeline-track-lane kind-${track.kind.toLowerCase()} ${
        isCrossTrackTarget ? "is-drop-target" : ""
      } ${isGroupStart ? "is-group-start" : ""}`}
      style={{ height: TRACK_HEIGHT }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onSelect(null);
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="track-label">{track.label ?? kindLabel}</div>
      {dragOverX !== null && (
        <div className="drop-indicator" style={{ left: dragOverX }} />
      )}
      {track.layers.map((layer) => (
        <LayerBlock
          key={layer.id}
          layer={layer}
          trackId={track.id}
          trackKind={track.kind}
          pxPerSec={pxPerSec}
          isSelected={selectedLayerId === layer.id}
          dragState={dragState}
          onSelect={onSelect}
          onDragStart={onDragStart}
        />
      ))}
    </div>
  );
}

function LayerBlock({
  layer,
  trackId,
  trackKind,
  pxPerSec,
  isSelected,
  dragState,
  onSelect,
  onDragStart,
}: {
  layer: LayerSummary;
  trackId: string;
  trackKind: string;
  pxPerSec: number;
  isSelected: boolean;
  dragState: DragState | null;
  onSelect: (id: string | null) => void;
  onDragStart: (state: DragState) => void;
}) {
  const { t } = useTranslation();
  const isDragging = dragState?.layerId === layer.id;
  let liveStart = layer.t_start_us;
  let liveEnd = layer.t_end_us;
  if (isDragging && dragState) {
    const dx = dragState.deltaUs;
    switch (dragState.kind) {
      case "move":
        liveStart += dx;
        liveEnd += dx;
        break;
      case "trim-start":
        liveStart = Math.min(
          liveStart + dx,
          liveEnd - MIN_LAYER_DURATION_US,
        );
        break;
      case "trim-end":
        liveEnd = Math.max(
          liveStart + MIN_LAYER_DURATION_US,
          liveEnd + dx,
        );
        break;
    }
  }

  const left = (Math.max(0, liveStart) / 1_000_000) * pxPerSec;
  const width = ((liveEnd - liveStart) / 1_000_000) * pxPerSec;
  const kindLabel = t(`kinds.${layer.kind.toLowerCase()}`, {
    defaultValue: layer.kind,
  });
  const label = layer.label ?? kindLabel;

  // Hide the layer from its source track during cross-track drag — it
  // appears at the new track's position via the live-updated TrackLane render
  // logic in our App tree (TrackLane keys the layer to its current track ID;
  // for cross-track preview we just dim the source).
  const movedAcrossTracks =
    isDragging &&
    dragState?.kind === "move" &&
    dragState.overTrackId !== null &&
    dragState.overTrackId !== trackId;

  const beginDrag = (kind: DragKind, trackKind: string) =>
    (e: React.PointerEvent) => {
      if (e.button !== 0 || layer.locked) return;
      e.stopPropagation();
      onSelect(layer.id);
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
      });
    };

  const layerWidthPx = Math.max(width, 4);

  return (
    <div
      className={`timeline-layer ${isSelected ? "is-selected" : ""} ${
        isDragging ? "is-dragging" : ""
      } ${layer.locked ? "is-locked" : ""} ${movedAcrossTracks ? "is-ghost" : ""}`}
      style={{
        left,
        width: layerWidthPx,
        background: layer.color_hint,
        opacity: movedAcrossTracks
          ? 0.3
          : layer.enabled
            ? 1
            : 0.45,
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(layer.id);
      }}
      onPointerDown={beginDrag("move", trackKind)}
      title={`${layer.kind}: ${(liveStart / 1_000_000).toFixed(2)}s → ${(liveEnd / 1_000_000).toFixed(2)}s`}
    >
      {layer.params.kind === "Audio" && layerWidthPx > 8 && (() => {
        // Source-window shifts mirror the timeline-window shifts during
        // trim — no speed factor on Audio params, so dx applies 1:1.
        let liveSrcIn = layer.params.src_in_us;
        let liveSrcOut = layer.params.src_out_us;
        if (isDragging && dragState) {
          const dx = dragState.deltaUs;
          if (dragState.kind === "trim-start") {
            liveSrcIn = Math.min(liveSrcIn + dx, liveSrcOut - MIN_LAYER_DURATION_US);
          } else if (dragState.kind === "trim-end") {
            liveSrcOut = Math.max(liveSrcIn + MIN_LAYER_DURATION_US, liveSrcOut + dx);
          }
        }
        return (
          <WaveformCanvas
            mediaId={layer.params.media_id}
            srcInUs={liveSrcIn}
            srcOutUs={liveSrcOut}
            width={layerWidthPx}
            height={TRACK_HEIGHT - 4}
          />
        );
      })()}
      <div
        className="layer-trim-handle left"
        onPointerDown={beginDrag("trim-start", trackKind)}
      />
      <span className="layer-label">{label}</span>
      <div
        className="layer-trim-handle right"
        onPointerDown={beginDrag("trim-end", trackKind)}
      />
    </div>
  );
}
