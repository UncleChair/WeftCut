// Global playback transport registry. The active preview's PlaybackEngine
// is reachable only through the React ref chain (PixiPreview → PreviewSurface
// → App.tsx), so nothing outside that chain — Tauri event handlers, MCP-driven
// mutation paths, dialogs, deep components — can stop playback. This store is
// the module-importable escape hatch: `PixiPreview` registers the live engine
// on mount, anyone can call `transportPause()` (etc.) without threading a ref.
//
// React subscribers must use ATOMIC selectors (per
// `feedback_zustand_composite_selector` — never select a composite object).

import { create } from "zustand";

/// Narrow imperative surface of the active preview's PlaybackEngine.
/// `PlaybackEngine` satisfies this structurally — register the engine itself.
export interface TransportHandle {
  play(): void;
  pause(): void;
  seek(tUs: number): void;
  isPlaying(): boolean;
}

interface State {
  /// Live transport, or null when no preview is mounted.
  transport: TransportHandle | null;
  /// Mirror of the engine's intended play state. Fed by
  /// `setTransportPlaying` from the engine's onPlayStateChange
  /// subscription so React subscribers don't need to poll the handle.
  playing: boolean;
}

export const usePlaybackStore = create<State>(() => ({
  transport: null,
  playing: false,
}));

/// Called by `PixiPreview` once its PlaybackEngine is wired. Re-registering
/// replaces the prior transport (StrictMode re-mount / project swap).
export function registerTransport(handle: TransportHandle): void {
  usePlaybackStore.setState({ transport: handle, playing: handle.isPlaying() });
}

/// Called by `PixiPreview` on unmount. Identity-guarded so a stale cleanup
/// (old mount unmounting after a new mount already registered) can't tear
/// down the live transport.
export function releaseTransport(handle: TransportHandle): void {
  if (usePlaybackStore.getState().transport !== handle) return;
  usePlaybackStore.setState({ transport: null, playing: false });
}

/// Mirror the engine's play state into the store. Wired by `PixiPreview`
/// via `engine.onPlayStateChange(setTransportPlaying)`.
export function setTransportPlaying(playing: boolean): void {
  usePlaybackStore.setState({ playing });
}

/// Safe no-ops while no preview is mounted — callers (event handlers,
/// dialogs) shouldn't have to care whether the editor is showing.
export function transportPlay(): void {
  usePlaybackStore.getState().transport?.play();
}

export function transportPause(): void {
  usePlaybackStore.getState().transport?.pause();
}

export function transportSeek(tUs: number): void {
  usePlaybackStore.getState().transport?.seek(tUs);
}

/// Atomic hook for React subscribers (primitive → no useSyncExternalStore
/// loop, re-renders only on actual play/pause flips).
export const usePlaybackPlaying = (): boolean =>
  usePlaybackStore((s) => s.playing);
