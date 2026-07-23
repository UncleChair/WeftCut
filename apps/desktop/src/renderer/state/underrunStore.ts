// Playback underrun (dropped-frame) mirror for the transport-bar
// indicator. Written by PixiPreview from `Compositor.onUnderrun`
// (edge-triggered + throttled by `UnderrunTracker` — never per-frame),
// read by `DroppedFramesIndicator`. Module-importable for the same
// reason as `playbackStore`: the indicator lives outside the
// PixiPreview ref chain.
//
// React subscribers must use ATOMIC selectors (per
// `feedback_zustand_composite_selector` — never select a composite object).

import { create } from "zustand";

import type { UnderrunSnapshot } from "../render/underrunTracker";

interface State {
  /// True while an underrun was observed within the tracker's hold
  /// window — the indicator's "lit" state.
  active: boolean;
  /// Comp frames painted late in the current/most-recent play session.
  droppedFrames: number;
}

export const useUnderrunStore = create<State>(() => ({
  active: false,
  droppedFrames: 0,
}));

/// Wired as `Compositor.onUnderrun` by PixiPreview.
export function setUnderrunState(snapshot: UnderrunSnapshot): void {
  useUnderrunStore.setState({
    active: snapshot.active,
    droppedFrames: snapshot.droppedFrames,
  });
}

/// Called on PixiPreview unmount so a stale count doesn't survive a
/// project swap / preview teardown.
export function resetUnderrunState(): void {
  useUnderrunStore.setState({ active: false, droppedFrames: 0 });
}

export const useUnderrunActive = (): boolean =>
  useUnderrunStore((s) => s.active);

export const useUnderrunDroppedFrames = (): number =>
  useUnderrunStore((s) => s.droppedFrames);
