import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  addMediaLayer,
  moveLayer,
  updateLayer,
  viewStateGet,
  viewStateSet,
  type LayerSummary,
  type TrackSummary,
} from "../ipc";
import { WaveformCanvas } from "./WaveformCanvas";

// Zoom + height bounds. The defaults match the pre-refactor constants so
// projects that have never written `view.json` look identical to before.
const DEFAULT_PX_PER_SEC = 80;
const MIN_PX_PER_SEC = 8;
const MAX_PX_PER_SEC = 800;
const DEFAULT_TRACK_HEIGHT = 36;
const MIN_TRACK_HEIGHT = 24;
const MAX_TRACK_HEIGHT = 200;
const MIN_LAYER_DURATION_US = 100_000;
// Debounce window after the last zoom/height edit before we hit disk.
// Resize-drag tends to fire ~60×/sec; 200ms keeps the file write off the
// critical drag path while still landing within a beat of the user
// releasing the handle.
const VIEW_SAVE_DEBOUNCE_MS = 200;

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

interface HeightDragState {
  trackId: string;
  startY: number;
  startHeight: number;
}

interface TimelineProps {
  tracks: TrackSummary[];
  durationUs: number;
  currentTimeUs: number;
  selectedLayerId: string | null;
  onSelect: (id: string | null) => void;
  onSeek: (tUs: number) => void;
  onMutated: () => Promise<void>;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
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
  const [pxPerSec, setPxPerSec] = useState<number>(DEFAULT_PX_PER_SEC);
  const [trackHeights, setTrackHeights] = useState<Record<string, number>>({});
  // Suppress the initial post-load save: we don't want the first
  // load-then-set-state pair to immediately echo the same values back to
  // disk. Flipped to true only after the in-flight load completes.
  const viewLoadedRef = useRef<boolean>(false);

  const totalSec = Math.max(durationUs / 1_000_000, 5);
  const widthPx = totalSec * pxPerSec;
  const [drag, setDrag] = useState<DragState | null>(null);
  const [heightDrag, setHeightDrag] = useState<HeightDragState | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const orderedTracks = useMemo(() => visualOrderedTracks(tracks), [tracks]);

  // Cumulative (y, height) per visible track row. Heights vary now, so
  // hit-testing for "which track is the pointer over" needs a real
  // offset table instead of `Math.floor(y / TRACK_HEIGHT)`.
  const trackRows = useMemo(() => {
    const rows: { track: TrackSummary; y: number; height: number }[] = [];
    let y = 0;
    for (const { track } of orderedTracks) {
      const h = trackHeights[track.id] ?? DEFAULT_TRACK_HEIGHT;
      rows.push({ track, y, height: h });
      y += h;
    }
    return rows;
  }, [orderedTracks, trackHeights]);

  // -------- Initial load + debounced save --------

  // One-shot load on mount. The backend returns defaults pre-workspace
  // (blank-on-boot session), so this is safe to call unconditionally.
  useEffect(() => {
    let cancelled = false;
    viewStateGet()
      .then((state) => {
        if (cancelled) return;
        setPxPerSec(
          clamp(state.timeline_px_per_sec, MIN_PX_PER_SEC, MAX_PX_PER_SEC),
        );
        setTrackHeights(state.track_heights ?? {});
      })
      .catch((e) => {
        console.warn("view_state load failed:", e);
      })
      .finally(() => {
        if (!cancelled) viewLoadedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced persist. Refs hold the latest values so the timer doesn't
  // need to restart with React's render cadence on every wheel tick.
  const pxPerSecRef = useRef(pxPerSec);
  const trackHeightsRef = useRef(trackHeights);
  useEffect(() => {
    pxPerSecRef.current = pxPerSec;
  }, [pxPerSec]);
  useEffect(() => {
    trackHeightsRef.current = trackHeights;
  }, [trackHeights]);

  useEffect(() => {
    if (!viewLoadedRef.current) return;
    const handle = setTimeout(() => {
      // Prune dead track ids on save so view.json doesn't accumulate
      // entries for tracks the user has deleted (see advisor note: state
      // map keeps stale keys until we filter on the way out).
      const live = new Set(tracks.map((t) => t.id));
      const pruned: Record<string, number> = {};
      for (const [id, h] of Object.entries(trackHeightsRef.current)) {
        if (live.has(id)) pruned[id] = h;
      }
      viewStateSet({
        timeline_px_per_sec: pxPerSecRef.current,
        track_heights: pruned,
      }).catch((e) => console.warn("view_state save failed:", e));
    }, VIEW_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // `tracks` participates so a track-deletion triggers a save that
    // prunes the stale id even if neither zoom nor height changed.
  }, [pxPerSec, trackHeights, tracks]);

  // -------- Ctrl+wheel zoom (cursor-anchored) --------

  // We capture { scrollLeft, cursorXInViewport, oldPxPerSec } when the
  // wheel fires, kick off `setPxPerSec`, and apply the new scrollLeft
  // in a useLayoutEffect once React has re-rendered with the new
  // px/sec. Doing it inline in the handler reads stale state and
  // produces a one-frame jitter (advisor note #2).
  const wheelPendingRef = useRef<{
    scrollLeft: number;
    cursorXInViewport: number;
    oldPxPerSec: number;
  } | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // React's JSX `onWheel` is registered passive in modern React, so
    // `preventDefault()` from there silently fails. Attach manually
    // with `{ passive: false }` so we can swallow the default
    // page-scroll behaviour when Ctrl is held.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = root.getBoundingClientRect();
      const cursorXInViewport = e.clientX - rect.left;
      // deltaMode varies by device — normalise lines/pages to pixels
      // before computing the zoom factor (advisor note #3).
      const lineHeight = 16;
      const pageHeight = 100;
      const px =
        e.deltaY *
        (e.deltaMode === 1 ? lineHeight : e.deltaMode === 2 ? pageHeight : 1);
      // Exponential zoom: small wheel ticks scale by ~ε near 1.0, big
      // ones don't snap-jump. Negative px (scrolling up) zooms in.
      const factor = Math.exp(-px * 0.001);
      const oldPxPerSec = pxPerSecRef.current;
      const newPxPerSec = clamp(
        oldPxPerSec * factor,
        MIN_PX_PER_SEC,
        MAX_PX_PER_SEC,
      );
      if (newPxPerSec === oldPxPerSec) return;
      wheelPendingRef.current = {
        scrollLeft: root.scrollLeft,
        cursorXInViewport,
        oldPxPerSec,
      };
      setPxPerSec(newPxPerSec);
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      root.removeEventListener("wheel", onWheel);
    };
  }, []);

  // Re-anchor scroll position so the time under the cursor stays put.
  // Runs synchronously after the layout flip so there's no flash.
  useLayoutEffect(() => {
    const pending = wheelPendingRef.current;
    if (!pending) return;
    wheelPendingRef.current = null;
    const root = rootRef.current;
    if (!root) return;
    const ratio = pxPerSec / pending.oldPxPerSec;
    root.scrollLeft =
      (pending.scrollLeft + pending.cursorXInViewport) * ratio -
      pending.cursorXInViewport;
  }, [pxPerSec]);

  // -------- Layer drag (move / trim) --------

  const trackUnderPointer = useCallback(
    (clientY: number): TrackSummary | null => {
      if (!canvasRef.current) return null;
      const rect = canvasRef.current.getBoundingClientRect();
      const y = clientY - rect.top;
      for (const row of trackRows) {
        if (y >= row.y && y < row.y + row.height) return row.track;
      }
      return null;
    },
    [trackRows],
  );

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (!drag) return;
      const deltaPx = e.clientX - drag.startX;
      const deltaUs = (deltaPx / pxPerSec) * 1_000_000;
      const overTrack =
        drag.kind === "move" ? trackUnderPointer(e.clientY) : null;
      setDrag({
        ...drag,
        deltaUs,
        overTrackId: overTrack?.id ?? null,
      });
    },
    [drag, pxPerSec, trackUnderPointer],
  );

  const handlePointerUp = useCallback(
    async (e: PointerEvent) => {
      if (!drag) return;
      const deltaPx = e.clientX - drag.startX;
      const deltaUs = Math.round((deltaPx / pxPerSec) * 1_000_000);
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
    [drag, onMutated, pxPerSec, trackUnderPointer],
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

  // -------- Track-height drag --------

  const beginHeightDrag = useCallback(
    (trackId: string) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // The lane below the handle would normally start a seek; stop the
      // pointerdown here so the seek-on-empty-canvas path never fires.
      e.stopPropagation();
      e.preventDefault();
      const current =
        trackHeightsRef.current[trackId] ?? DEFAULT_TRACK_HEIGHT;
      setHeightDrag({
        trackId,
        startY: e.clientY,
        startHeight: current,
      });
    },
    [],
  );

  useEffect(() => {
    if (!heightDrag) return;
    const onMove = (e: PointerEvent) => {
      const dy = e.clientY - heightDrag.startY;
      const next = clamp(
        Math.round(heightDrag.startHeight + dy),
        MIN_TRACK_HEIGHT,
        MAX_TRACK_HEIGHT,
      );
      setTrackHeights((prev) =>
        prev[heightDrag.trackId] === next
          ? prev
          : { ...prev, [heightDrag.trackId]: next },
      );
    };
    const onUp = () => setHeightDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [heightDrag]);

  // -------- Media drop, seek, render --------

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
      const tStartUs = Math.max(0, Math.round((x / pxPerSec) * 1_000_000));
      try {
        await addMediaLayer(track.id, payload.mediaId, tStartUs);
        await onMutated();
      } catch (err) {
        console.error("media drop failed:", err);
      }
    },
    [onMutated, pxPerSec],
  );

  const playheadX = (currentTimeUs / 1_000_000) * pxPerSec;

  const seekFromClientX = useCallback(
    (clientX: number) => {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      onSeek(Math.max(0, Math.round((x / pxPerSec) * 1_000_000)));
    },
    [onSeek, pxPerSec],
  );

  // Click/drag on empty canvas (lane background, gap below tracks) to seek.
  // Layer / trim-handle / resize-handle pointerdown stops propagation, so
  // this never fires when interacting with an existing control.
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
      ref={rootRef}
      className={`timeline-root ${drag ? "is-dragging" : ""} ${
        heightDrag ? "is-resizing-track" : ""
      }`}
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
            pxPerSec={pxPerSec}
            height={trackHeights[track.id] ?? DEFAULT_TRACK_HEIGHT}
            selectedLayerId={selectedLayerId}
            dragState={drag}
            onSelect={onSelect}
            onDragStart={(state) => setDrag(state)}
            onMediaDrop={onMediaDrop}
            isGroupStart={isGroupStart}
            onHeightDragStart={beginHeightDrag(track.id)}
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
  height,
  selectedLayerId,
  dragState,
  onSelect,
  onDragStart,
  onMediaDrop,
  isGroupStart,
  onHeightDragStart,
}: {
  track: TrackSummary;
  pxPerSec: number;
  height: number;
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
  onHeightDragStart: (e: React.PointerEvent) => void;
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
      style={{ height }}
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
          laneHeight={height}
          isSelected={selectedLayerId === layer.id}
          dragState={dragState}
          onSelect={onSelect}
          onDragStart={onDragStart}
        />
      ))}
      <div
        className="track-resize-handle"
        title={t("timeline.resize_track_hint", {
          defaultValue: "Drag to resize this track",
        })}
        onPointerDown={onHeightDragStart}
      />
    </div>
  );
}

function LayerBlock({
  layer,
  trackId,
  trackKind,
  pxPerSec,
  laneHeight,
  isSelected,
  dragState,
  onSelect,
  onDragStart,
}: {
  layer: LayerSummary;
  trackId: string;
  trackKind: string;
  pxPerSec: number;
  laneHeight: number;
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
            height={Math.max(8, laneHeight - 4)}
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
