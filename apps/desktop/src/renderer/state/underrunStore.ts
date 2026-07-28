// Playback underrun mirror for the transport-bar indicator — the
// dropped-frame and late-tick counts. Written by PixiPreview from
// `Compositor.onUnderrun`
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
  /// True while an underrun of either cause was observed within the
  /// tracker's hold window — the indicator's "lit" state.
  active: boolean;
  /// Comp frames painted from a stale ring in the current/most-recent
  /// play session.
  droppedFrames: number;
  /// Composite ticks that landed past one comp-frame budget in the
  /// same session.
  lateFrames: number;
}

export const useUnderrunStore = create<State>(() => ({
  active: false,
  droppedFrames: 0,
  lateFrames: 0,
}));

/// Wired as `Compositor.onUnderrun` by PixiPreview.
export function setUnderrunState(snapshot: UnderrunSnapshot): void {
  useUnderrunStore.setState({
    active: snapshot.active,
    droppedFrames: snapshot.droppedFrames,
    lateFrames: snapshot.lateFrames,
  });
}

/// Called on PixiPreview unmount so a stale count doesn't survive a
/// project swap / preview teardown.
export function resetUnderrunState(): void {
  useUnderrunStore.setState({ active: false, droppedFrames: 0, lateFrames: 0 });
}

export const useUnderrunActive = (): boolean =>
  useUnderrunStore((s) => s.active);

export const useUnderrunDroppedFrames = (): number =>
  useUnderrunStore((s) => s.droppedFrames);

export const useUnderrunLateFrames = (): number =>
  useUnderrunStore((s) => s.lateFrames);
