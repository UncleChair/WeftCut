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
    // Always-running rAF loop. SyntheticClock.tick is a no-op when
    // paused (returns the same time); compositeFrame still runs each
    // tick so async-arrived decoded frames present even when the
    // playhead isn't moving.
    this.startLoop();
  }

  isPlaying(): boolean {
    return this.clock.isPlaying();
  }

  positionUs(): number {
    return this.clock.positionUs();
  }

  play(): void {
    if (this.clock.isPlaying()) return;
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] engine.play() @ tUs=${this.clock.positionUs()}`);
    this.clock.play();
    this.emitPlayState(true);
  }

  pause(): void {
    if (!this.clock.isPlaying()) return;
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] engine.pause() @ tUs=${this.clock.positionUs()}`);
    this.clock.pause();
    this.emitPlayState(false);
  }

  /// Hard seek to a composition time. P1 wires this into decoder
  /// scrub coalescing.
  seek(tUs: number): void {
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] engine.seek(${tUs}) from=${this.clock.positionUs()}`);
    this.clock.setPosition(tUs);
    this.compositor.setAnchorTime(tUs);
    this.compositor.compositeFrame(tUs);
    this.lastEmittedUs = tUs;
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

  private lastEmittedUs = -1;
  /// Diagnostic: confirm the rAF loop is actually firing. Logs at
  /// frame 1, 10, 60, 300 so the user can see it's still alive.
  private tickCount = 0;

  private startLoop(): void {
    const tick = () => {
      try {
        this.tickCount += 1;
        if (
          this.tickCount === 1 ||
          this.tickCount === 10 ||
          this.tickCount === 60 ||
          this.tickCount === 300
        ) {
          // eslint-disable-next-line no-console
          console.log(`[weftcut/pixi] rAF tick #${this.tickCount}`);
        }
        const { tUs } = this.clock.tick();
        this.compositor.setAnchorTime(tUs);
        this.compositor.compositeFrame(tUs);
        if (tUs !== this.lastEmittedUs) {
          this.lastEmittedUs = tUs;
          this.emitTime(tUs);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[weftcut/pixi] rAF tick threw — loop dying:", e);
        // Don't re-throw: keep the loop alive so the user gets
        // diagnostic visibility on subsequent ticks.
      }
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
