import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_TRACK_HEIGHT,
  MAX_TRACK_HEIGHT,
  MIN_TRACK_HEIGHT,
  clamp,
} from "../geometry";

interface HeightDragState {
  trackId: string;
  startY: number;
  startHeight: number;
}

/// Track-height resize drag: pointerdown on a lane's resize handle
/// starts the drag; window-level pointermove/pointerup listeners track
/// it until release.
export function useHeightDrag(opts: {
  trackHeightsRef: React.MutableRefObject<Record<string, number>>;
  setTrackHeights: React.Dispatch<React.SetStateAction<Record<string, number>>>;
}): {
  heightDrag: { trackId: string; startY: number; startHeight: number } | null;
  beginHeightDrag: (trackId: string) => (e: React.PointerEvent) => void;
} {
  const { trackHeightsRef, setTrackHeights } = opts;
  const [heightDrag, setHeightDrag] = useState<HeightDragState | null>(null);

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
    [trackHeightsRef],
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
  }, [heightDrag, trackHeightsRef, setTrackHeights]);

  return { heightDrag, beginHeightDrag };
}
