// Transport for the new PixiJS renderer. Owns the SyntheticClock,
// wires the Compositor and AudioGraph, and exposes play/pause/seek/scrub.
//
// Plan: docs/pixi-renderer-plan.md
//
// P0 stub — full implementation lands in P1 (decode + clock + scrub).
// The shape here is intentionally close to the existing
// `preview/dom/PlaybackEngine.ts` so the React mount layer (PreviewSurface)
// can swap implementations with minimal churn when LiveLayers is replaced.

import type { Compositor } from "./Compositor";
import { SyntheticClock } from "./clock";

export interface PlaybackEngineInit {
  compositor: Compositor;
}

type TimeListener = (tUs: number) => void;
type PlayStateListener = (playing: boolean) => void;

export class PlaybackEngine {
  private clock = new SyntheticClock();
  private rafHandle: number | null = null;
  private timeListeners = new Set<TimeListener>();
  private playStateListeners = new Set<PlayStateListener>();
  private compositor: Compositor;

  constructor(init: PlaybackEngineInit) {
    this.compositor = init.compositor;
  }

  isPlaying(): boolean {
    return this.clock.isPlaying();
  }

  positionUs(): number {
    return this.clock.positionUs();
  }

  play(): void {
    if (this.clock.isPlaying()) return;
    this.clock.play();
    this.emitPlayState(true);
    this.startLoop();
  }

  pause(): void {
    if (!this.clock.isPlaying()) return;
    this.clock.pause();
    this.emitPlayState(false);
    this.stopLoop();
  }

  /// Hard seek to a composition time. P1 wires this into decoder
  /// scrub coalescing.
  seek(tUs: number): void {
    this.clock.setPosition(tUs);
    this.compositor.setAnchorTime(tUs);
    this.compositor.compositeFrame(tUs);
    this.emitTime(tUs);
  }

  onTimeUpdate(cb: TimeListener): () => void {
    this.timeListeners.add(cb);
    return () => this.timeListeners.delete(cb);
  }

  onPlayStateChange(cb: PlayStateListener): () => void {
    this.playStateListeners.add(cb);
    return () => this.playStateListeners.delete(cb);
  }

  dispose(): void {
    this.stopLoop();
    this.timeListeners.clear();
    this.playStateListeners.clear();
  }

  private startLoop(): void {
    const tick = () => {
      if (!this.clock.isPlaying()) return;
      const { tUs } = this.clock.tick();
      this.compositor.setAnchorTime(tUs);
      this.compositor.compositeFrame(tUs);
      this.emitTime(tUs);
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  private emitTime(tUs: number): void {
    for (const cb of this.timeListeners) cb(tUs);
  }

  private emitPlayState(playing: boolean): void {
    for (const cb of this.playStateListeners) cb(playing);
  }
}
