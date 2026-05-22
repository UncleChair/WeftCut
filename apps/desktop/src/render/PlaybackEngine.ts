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

/// Minimum decoded lookahead (microseconds past the play position)
/// before `play()` releases the clock. Picked at ~9 frames of 60 fps
/// content — enough to absorb hardware-decoder first-frame jitter
/// without making the user wait noticeably for a stable decoder.
const WARMUP_MIN_LOOKAHEAD_US = 150_000;

/// Safety cap on how long `play()` waits for warm-up before starting
/// the clock anyway. Without a cap, a wedged or never-ready source
/// would block playback indefinitely; with the cap, the worst case
/// degrades to the prior behavior (brief stutter) rather than a
/// frozen play button.
const WARMUP_MAX_WAIT_MS = 250;

export class PlaybackEngine {
  private clock = new SyntheticClock();
  private rafHandle: number | null = null;
  private timeListeners = new Set<TimeListener>();
  private playStateListeners = new Set<PlayStateListener>();
  private compositor: Compositor;
  /// User-intent play state — tracked separately from `clock.isPlaying()`
  /// because `play()` may briefly hold the clock paused while the
  /// decoder warms up. Listeners and external `isPlaying()` callers
  /// want the intent, not the clock state, so the play button feels
  /// instantly responsive even during the warm-up gate.
  private intendedPlaying = false;
  /// Handle for the rAF-driven warm-up poller. Set while `play()` is
  /// waiting for the ring to fill; null otherwise. Cancelled by
  /// `pause()` so the user can abort a warm-up by clicking pause.
  private warmupHandle: number | null = null;
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
        // eslint-disable-next-line no-console
        console.log(`[weftcut/pixi] scrubCoalescer.onStableSeek(${tUs})`);
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
    return this.intendedPlaying;
  }

  positionUs(): number {
    return this.clock.positionUs();
  }

  play(): void {
    if (this.intendedPlaying) return;
    this.intendedPlaying = true;
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] engine.play() @ tUs=${this.clock.positionUs()}`);
    // If a scrub-debounce is still pending, cancel it and exit
    // scrubbing immediately so the rAF loop's setAnchorTime resumes
    // feeding the decoder as time advances. Otherwise the user would
    // see up to 50 ms of stale frame at the start of playback.
    this.scrubCoalescer.cancel();
    this.compositor.setScrubbing(false);
    // UI gets the new play state immediately — the button updates,
    // the user feels the click. The clock + master-audio state are
    // gated on decoder warm-up below; the rAF loop's compositeFrame
    // still runs each tick at the held position, so the canvas
    // shows the start frame instead of a stutter.
    this.emitPlayState(true);
    this.scheduleClockStart();
  }

  pause(): void {
    if (!this.intendedPlaying) return;
    this.intendedPlaying = false;
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] engine.pause() @ tUs=${this.clock.positionUs()}`);
    this.cancelWarmup();
    this.compositor.setMasterPlayState(false);
    if (this.clock.isPlaying()) this.clock.pause();
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
    this.cancelWarmup();
    this.scrubCoalescer.cancel();
    this.timeListeners.clear();
    this.playStateListeners.clear();
  }

  /// rAF-paced poll waiting for the decoder to fill `WARMUP_MIN_LOOKAHEAD_US`
  /// of ring past the current play position; on success or deadline
  /// hit, releases the clock + master-play state. The rAF loop keeps
  /// running throughout (compositeFrame still paints at the held
  /// position), so the canvas shows the start frame frozen during
  /// warm-up rather than stuttering through partial outputs.
  ///
  /// `clock.positionUs()` is re-read every poll iteration so a `seek()`
  /// arriving mid-warm-up retargets the lookahead check at the new
  /// position instead of clearing the gate against the stale one.
  private scheduleClockStart(): void {
    const deadline = performance.now() + WARMUP_MAX_WAIT_MS;
    const tryStart = (): void => {
      this.warmupHandle = null;
      if (!this.intendedPlaying) return;
      if (this.clock.isPlaying()) return;
      const tUs = this.clock.positionUs();
      const lookaheadReady = this.compositor.hasLookaheadAt(
        tUs,
        WARMUP_MIN_LOOKAHEAD_US,
      );
      const deadlineHit = performance.now() >= deadline;
      if (lookaheadReady || deadlineHit) {
        this.compositor.setMasterPlayState(true);
        this.clock.play();
        return;
      }
      this.warmupHandle = requestAnimationFrame(tryStart);
    };
    tryStart();
  }

  private cancelWarmup(): void {
    if (this.warmupHandle !== null) {
      cancelAnimationFrame(this.warmupHandle);
      this.warmupHandle = null;
    }
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
