// Transport for the new PixiJS renderer. Owns the SyntheticClock,
// wires the Compositor and AudioGraph, and exposes play/pause/seek/scrub.
//
// Plan: docs/pixi-renderer-plan.md
//
// P0 stub — full implementation lands in P1 (decode + clock + scrub).
// The shape here is intentionally close to the existing
// `preview/dom/PlaybackEngine.ts` so the React mount layer (PreviewSurface)
// can swap implementations with minimal churn when LiveLayers is replaced.

import { UPDATE_PRIORITY, type Ticker } from "pixi.js";

import type { Compositor } from "./Compositor";
import { SyntheticClock } from "./clock";
import { ScrubCoalescer } from "./decoder/scrub";

export interface PlaybackEngineInit {
  compositor: Compositor;
  /// PixiJS ticker driving the tick callback. Pass `app.ticker` in
  /// production; tests pass a standalone `new Ticker()` and drive it
  /// manually with `update()`. Registered at UPDATE_PRIORITY.HIGH so
  /// our scene-graph mutation runs before TickerPlugin's render (LOW)
  /// in the same frame — kills the 1-frame lag two independent rAF
  /// loops would otherwise introduce.
  ticker: Ticker;
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
  private ticker: Ticker;
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
    this.ticker = init.ticker;
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
    // Always-on tick. SyntheticClock.tick is a no-op when paused
    // (returns the same time); compositeFrame still runs each tick
    // so async-arrived decoded frames present even when the
    // playhead isn't moving. HIGH puts us before TickerPlugin's
    // render (LOW) within the same ticker.update() so this tick's
    // scene-graph mutation lands in this frame's render, not next.
    this.ticker.add(this.tick, this, UPDATE_PRIORITY.HIGH);
  }

  isPlaying(): boolean {
    return this.intendedPlaying;
  }

  positionUs(): number {
    return this.clock.positionUs();
  }

  /// Bind the composition fps so the clock snaps its position to
  /// frame. Called by the host (`PixiPreview`) on project load and on
  /// fps changes.
  bindFps(num: number, den: number): void {
    this.clock.bindFps(num, den);
  }

  play(): void {
    if (this.intendedPlaying) return;
    // If the playhead is parked at the last frame of playable material,
    // treat play as "play from the start". Under the frame-anchor
    // playhead rule, "at end" means `position >= endUs − F` (the start
    // of the last visible frame). Without this restart, the button
    // looks dead — clock would advance one frame to endUs, immediately
    // re-fire auto-pause, and emit no visible change because the last
    // frame is already painted.
    const endUs = this.autoPauseEndUs();
    const lastFrameStart = this.compositor.lastFrameAnchorUs(endUs);
    if (endUs > 0 && this.clock.positionUs() >= lastFrameStart) {
      this.clock.setPosition(0);
      this.lastEmittedUs = 0;
      this.emitTime(0);
      this.compositor.setAnchorTime(0);
      this.compositor.compositeFrame(0);
    }
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
    // Must `remove` BEFORE Pixi destroys its ticker (e.g. @pixi/react
    // unmount). React useEffect cleanup runs inner→outer, so as long
    // as PixiPreview's dispose effect runs before <Application>'s,
    // the ticker is still alive here. Reference identity matters:
    // `this.tick` is a stable class-field arrow so this matches the
    // exact reference passed to `add` in the constructor.
    this.ticker.remove(this.tick, this);
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

  /// Effective end-of-timeline used for auto-pause and the
  /// "restart from 0" gesture on play(). Prefers the end of playable
  /// material (max enabled-layer `t_end_us`) over the authored
  /// composition duration, falling back to composition duration only
  /// when the project has no enabled layers at all. The fallback
  /// preserves the legacy guard so a brand-new empty project still
  /// auto-pauses at composition end if the user manages to start
  /// playback.
  private autoPauseEndUs(): number {
    const playable = this.compositor.playableEndUs();
    if (playable > 0) return playable;
    return this.compositor.compositionDurationUs();
  }

  private cancelWarmup(): void {
    if (this.warmupHandle !== null) {
      cancelAnimationFrame(this.warmupHandle);
      this.warmupHandle = null;
    }
  }

  private lastEmittedUs = -1;

  /// Arrow-function class field so `this` binds correctly when the
  /// Ticker invokes it, and so reference identity is stable for
  /// `ticker.remove(this.tick, this)` in dispose.
  private tick = (): void => {
    try {
      const { tUs } = this.clock.tick();
      // Auto-pause when the playhead reaches the end of the last
      // piece of playable material — not just the composition's
      // authored duration. Composition duration auto-extends to fit
      // added layers but doesn't auto-shrink when layers are deleted
      // or trimmed; without this distinction the clock keeps
      // advancing through an empty black tail to the stale
      // composition end. Only checked while the clock is actually
      // running (not during play() warm-up where the clock is held
      // but `intendedPlaying` is already true) so we don't fire
      // before the user sees any frames.
      const endUs = this.autoPauseEndUs();
      if (this.clock.isPlaying() && endUs > 0 && tUs >= endUs) {
        // Park the clock at the START of the last visible frame
        // (frame-anchor playhead rule — see docs/data-model.md). That
        // value is already inside the final layer's exclusive
        // `[t_start, t_end)` interval, so the same value can drive
        // both the emitted timecode AND the composite. No more
        // `endUs − 1 µs` hack: the parked position IS the painted
        // frame, end-of-comp display reads as the true last frame
        // (e.g. `00:00:09:29` for a 10 s 30 fps comp).
        //
        // Exact-rational `lastFrameAnchorUs` is required here — the
        // naive `endUs − pre-rounded-frameDurUs` drifts ~1 µs/frame
        // and at frame 299 lands above the true grid value, so the
        // compositor's frame lookup drops into the SECOND-to-last
        // sample's PTS interval and paints the wrong frame.
        const parkUs = this.compositor.lastFrameAnchorUs(endUs);
        this.clock.setPosition(parkUs);
        this.compositor.setAnchorTime(parkUs);
        this.compositor.compositeFrame(parkUs);
        if (parkUs !== this.lastEmittedUs) {
          this.lastEmittedUs = parkUs;
          this.emitTime(parkUs);
        }
        this.pause();
        return;
      }
      this.compositor.setAnchorTime(tUs);
      this.compositor.compositeFrame(tUs);
      if (tUs !== this.lastEmittedUs) {
        this.lastEmittedUs = tUs;
        this.emitTime(tUs);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[weftcut/pixi] tick threw — keeping ticker alive:", e);
      // Don't re-throw: ticker would happily call us again next
      // frame, but a thrown error inside a ticker listener prints a
      // noisy stack — caught here for diagnostic clarity.
    }
  };

  private emitTime(tUs: number): void {
    for (const cb of this.timeListeners) cb(tUs);
  }

  private emitPlayState(playing: boolean): void {
    for (const cb of this.playStateListeners) cb(playing);
  }
}
