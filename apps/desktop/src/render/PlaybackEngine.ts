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
import { ScrubCoalescer } from "./decoder/scrub";

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
  /// Debounces rapid `seek()` calls during timeline drag. While the
  /// debounce window is active, `Compositor.scrubbing` is true so the
  /// rAF loop's `setAnchorTime` is a no-op — the decoder isn't
  /// churned for each interim seek target. When the debounce expires
  /// with a stable target, we clear `scrubbing` + reissue
  /// setAnchorTime so the decoder catches up to the final position.
  private scrubCoalescer: ScrubCoalescer;

  constructor(init: PlaybackEngineInit) {
    this.compositor = init.compositor;
    this.scrubCoalescer = new ScrubCoalescer({
      debounceMs: 50,
      onStableSeek: async (tUs: number) => {
        // Resume normal decoder behavior and force a precise
        // setAnchorTime for the stable target.
        this.compositor.setScrubbing(false);
        this.compositor.setAnchorTime(tUs);
        this.compositor.compositeFrame(tUs);
      },
    });
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
    // If a scrub-debounce is still pending, cancel it and exit
    // scrubbing immediately so the rAF loop's setAnchorTime resumes
    // feeding the decoder as time advances. Otherwise the user would
    // see up to 50 ms of stale frame at the start of playback.
    this.scrubCoalescer.cancel();
    this.compositor.setScrubbing(false);
    this.compositor.setMasterPlayState(true);
    this.clock.play();
    this.emitPlayState(true);
  }

  pause(): void {
    if (!this.clock.isPlaying()) return;
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] engine.pause() @ tUs=${this.clock.positionUs()}`);
    this.compositor.setMasterPlayState(false);
    this.clock.pause();
    this.emitPlayState(false);
  }

  /// Hard seek to a composition time. Routes through the
  /// ScrubCoalescer: clock + visual feedback are immediate; the
  /// decoder is asked to actually fetch the target frame only after
  /// 50 ms of no further seeks (a "stable target"). Rapid scrubs
  /// during a timeline drag thus paint the nearest-cached frame
  /// each rAF without thrashing the decoder, and the precise frame
  /// snaps in within 50 ms of the user releasing the drag.
  seek(tUs: number): void {
    this.clock.setPosition(tUs);
    // Immediate visual feedback: paint whatever's currently in the
    // ring nearest to this position. compositeFrame doesn't issue
    // new decoder work.
    this.compositor.setScrubbing(true);
    this.compositor.compositeFrame(tUs);
    this.lastEmittedUs = tUs;
    this.emitTime(tUs);
    // Schedule the precise decoder seek + final paint after the
    // debounce window.
    this.scrubCoalescer.requestSeek(tUs);
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
    this.scrubCoalescer.cancel();
    this.timeListeners.clear();
    this.playStateListeners.clear();
  }

  private lastEmittedUs = -1;

  private startLoop(): void {
    const tick = () => {
      try {
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
