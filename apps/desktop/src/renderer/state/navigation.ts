import { lastFrameAnchorUs } from "../frames";
import { setMediaPoolDrawerOpen } from "../settings/appSettingsStore";
import { transportSeek } from "./playbackStore";
import { setPlayheadTimeUs } from "./playheadStore";
import { useProjectStore } from "./projectStore";
import { setSelectedLayerId } from "./selectionStore";

/// Imperative navigation verbs for callers outside the React ref chain
/// (search palette, future agent-driven UI). Handles that need component
/// internals — App's R.7 reveal-track state, Timeline's scroll container,
/// MediaPool's list DOM — are registered on mount, playbackStore-style;
/// every verb is a safe no-op for whatever isn't mounted.

type RevealTrackFn = (trackId: string, layerId: string) => void;
type ScrollToTimeFn = (tUs: number) => void;
type RevealMediaFn = (mediaId: string) => void;

let revealTrackFn: RevealTrackFn | null = null;
let scrollToTimeFn: ScrollToTimeFn | null = null;
let revealMediaFn: RevealMediaFn | null = null;

// Identity-guarded unregister (releaseTransport pattern): a stale cleanup
// from an old mount can't tear down a newer registration.
export function registerRevealTrack(fn: RevealTrackFn): () => void {
  revealTrackFn = fn;
  return () => {
    if (revealTrackFn === fn) revealTrackFn = null;
  };
}

export function registerScrollToTime(fn: ScrollToTimeFn): () => void {
  scrollToTimeFn = fn;
  return () => {
    if (scrollToTimeFn === fn) scrollToTimeFn = null;
  };
}

export function registerRevealMedia(fn: RevealMediaFn): () => void {
  revealMediaFn = fn;
  return () => {
    if (revealMediaFn === fn) revealMediaFn = null;
  };
}

/// Clamp a target playhead time to [0, lastFrameAnchorUs] against the
/// current summary — the same rule App.tsx's seekTo applies (Q5 of the
/// frame-anchor spec).
export function clampSeekUs(tUs: number): number {
  const summary = useProjectStore.getState().summary;
  const fpsNum = summary?.composition.fps_num ?? 30;
  const fpsDen = summary?.composition.fps_den ?? 1;
  const upper = lastFrameAnchorUs(summary?.duration_us ?? 0, fpsNum, fpsDen);
  return Math.max(0, Math.min(tUs, upper));
}

/// Optimistic playheadStore write first: with no preview mounted there is
/// no engine emit, yet the playhead UI must still move (mirrors App.tsx
/// seekTo). Play state is untouched — seek-while-playing keeps playing
/// (NLE norm). `clampedUs` must already be clamped — callers go through
/// `seekToClamped` or `jumpToTimeUs`, both of which clamp exactly once.
function seekExact(clampedUs: number): void {
  setPlayheadTimeUs(clampedUs);
  transportSeek(clampedUs);
}

/// Clamped seek through the module-level transport.
export function seekToClamped(tUs: number): void {
  seekExact(clampSeekUs(tUs));
}

export function jumpToTimeUs(tUs: number): void {
  const clamped = clampSeekUs(tUs);
  seekExact(clamped);
  scrollToTimeFn?.(clamped);
}

/// Select + seek + scroll to a layer. Validates against the live index —
/// the caller may hold a stale search entry (index rebuilds are
/// debounced). Returns false (and changes nothing) when the layer is gone.
export function jumpToLayer(layerId: string): boolean {
  const { layerById, trackIdByLayerId } = useProjectStore.getState();
  const layer = layerById.get(layerId);
  if (!layer) return false;
  const trackId = trackIdByLayerId.get(layerId);
  if (trackId && revealTrackFn) {
    // App's revealTrack both reveals a hidden track (R.7) and selects the
    // layer; revealing an already-visible track is harmless.
    revealTrackFn(trackId, layerId);
  } else {
    setSelectedLayerId(layerId);
  }
  jumpToTimeUs(layer.t_start_us);
  return true;
}

/// Open the MediaPool drawer and flash the item. Returns false when the
/// media id no longer exists.
export function revealInMediaPool(mediaId: string): boolean {
  if (!useProjectStore.getState().mediaById.has(mediaId)) return false;
  void setMediaPoolDrawerOpen(true);
  revealMediaFn?.(mediaId);
  return true;
}
