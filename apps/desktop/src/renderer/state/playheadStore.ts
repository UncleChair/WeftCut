// Global playhead-time store. The PlaybackEngine emits a time update once per
// COMPOSITION FRAME during playback (PlaybackEngine.emitTime → onTimeUpdate).
// Holding that value in React state at the App root re-rendered the entire
// tree 30–60×/s while playing — a pure CPU tax in production, and in dev the
// React-development-build commit overhead additionally ratchets renderer
// memory ~75–80 MB per played minute (native-side, GC-immune; see
// docs/render.md §Playhead updates). This store is the fan-out point instead;
// NOTHING at frame rate may live in React state above a leaf.
//
// Consumption rules (pick the cheapest tier that fits):
//   1. Event handlers (shortcuts, insert-at-playhead, snap-at-event-time):
//      read `playheadTimeUs()` imperatively at event time. Never subscribe.
//   2. Smooth per-frame visuals (timeline playhead line, timecode readout):
//      TRANSIENT subscription — `usePlayheadStore.subscribe` in an effect,
//      mutate the DOM node via ref. Zero React commits.
//   3. Panels showing "value at playhead" (inspector, peek list):
//      `usePlayheadTimeUsThrottled()` — trailing-edge throttle, converges on
//      the final value after the last change (pause/seek lands exactly).
//   4. Tiny leaf components where per-frame React commits are acceptable
//      (agent-mode MiniTimeline): `usePlayheadTimeUs()`.

import { create } from "zustand";
import { useEffect, useState } from "react";

interface State {
  /// Frame-quantized playhead position, µs. Written once per composition
  /// frame during playback and on every seek.
  timeUs: number;
}

export const usePlayheadStore = create<State>(() => ({ timeUs: 0 }));

/// Per-frame writer. Wired as the engine's `onTimeUpdate` listener (both the
/// editor's PreviewSurface and agent mode's). Engine emits are already
/// deduplicated per frame (`lastEmittedUs`), the guard here just makes
/// external callers safe too.
export function setPlayheadTimeUs(tUs: number): void {
  if (usePlayheadStore.getState().timeUs !== tUs) {
    usePlayheadStore.setState({ timeUs: tUs });
  }
}

/// Imperative read for event-time consumers (tier 1).
export function playheadTimeUs(): number {
  return usePlayheadStore.getState().timeUs;
}

/// Frame-rate React subscription (tier 4) — leaf components only.
export const usePlayheadTimeUs = (): number =>
  usePlayheadStore((s) => s.timeUs);

/// Panel-rate React subscription (tier 3). Trailing-edge throttle: at most
/// one re-render per `intervalMs`, and the timer fires AFTER the last store
/// write, reading the latest value — so a pause or single seek always
/// converges on the exact final position (a leading-edge throttle would
/// freeze one frame early).
export function usePlayheadTimeUsThrottled(intervalMs = 100): number {
  const [timeUs, setTimeUs] = useState<number>(() => playheadTimeUs());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = usePlayheadStore.subscribe(() => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        setTimeUs(playheadTimeUs());
      }, intervalMs);
    });
    // Re-sync after (re)mount — the store may have moved while unmounted
    // (StrictMode remount, panel toggled closed during playback).
    setTimeUs(playheadTimeUs());
    return () => {
      unsub();
      if (timer !== null) clearTimeout(timer);
    };
  }, [intervalMs]);
  return timeUs;
}
