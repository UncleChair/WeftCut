// Playback transport for the PixiJS renderer. Owns the SyntheticClock,
// wires the Compositor and AudioGraph, and exposes play/pause/seek/scrub
// plus the warmup gate (defers the clock start until the decoder ring is
// filled). Plan: docs/render.md

import { UPDATE_PRIORITY, type Ticker } from "pixi.js";

import type { Compositor } from "./Compositor";
import { SyntheticClock } from "./clock";
import { ScrubCoalescer } from "./decoder/scrub";
import {
  STAGE,
  stageAdd,
  stageFrameBegin,
  stageFrameEnd,
  stageNow,
} from "./perf/stageTimers";

export interface PlaybackEngineInit {
  compositor: Compositor;
  /// PixiJS ticker driving the tick callback. Pass `app.ticker` in
  /// production; tests pass a standalone `new Ticker()` and drive it
  /// manually with `update()`.
  ticker: Ticker;
}

type TimeListener = (tUs: number) => void;
type PlayStateListener = (playing: boolean) => void;

/// What released the warmup gate. `lookahead-ready` is the happy
/// path (decoder produced enough lookahead within the budget);
/// `deadline-hit` means we ran out the safety cap and started
/// anyway — user may see initial-frame stutter. The HUD surfaces
/// the reason so we can tell whether warmup is bounded by I/O or
/// by the cap.
export type WarmupReason = "lookahead-ready" | "deadline-hit";

export interface WarmupStats {
  /// Most recent warmup duration in ms, or null if no warmup has
  /// completed since the last `resetWarmupStats()` (or process
  /// start).
  lastMs: number | null;
  /// Running max since the last `resetWarmupStats()`.
  maxMs: number;
  /// Reason the last warmup released.
  lastReason: WarmupReason | null;
}

/// Minimum decoded lookahead (microseconds past the play position)
/// before `play()` releases the clock. Picked at ~9 frames of 60 fps
/// content — enough to absorb hardware-decoder first-frame jitter
/// without making the user wait noticeably for a stable decoder.
const WARMUP_MIN_LOOKAHEAD_US = 150_000;

/// Safety cap on how long `play()` waits for warm-up before starting
/// the clock anyway. Without a cap, a wedged or never-ready source
/// would block playback indefinitely; with the cap, the worst case is
/// a brief initial-frame stutter rather than a frozen play button.
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
  /// `performance.now()` at the moment `play()` was called for the
  /// current attempt; null while not in warmup. Used by
  /// `scheduleClockStart` to stamp `lastWarmupMs` on release.
  private warmupStartMs: number | null = null;
  private lastWarmupMs: number | null = null;
  private maxWarmupMs = 0;
  private lastWarmupReason: WarmupReason | null = null;
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
    // Audio-master clock: bind the preview master bus's AudioContext so
    // the playing position derives from the audio hardware clock (null in
    // export mode / when the graph is absent — wall-clock fallback).
    this.clock.bindAudio(init.compositor.getAudioGraph()?.ctx ?? null);
    this.scrubCoalescer = new ScrubCoalescer({
      debounceMs: 50,
      // Ceiling so an unbroken drag still re-targets the decoder a few
      // times/sec (live scrub preview) instead of staying frozen on the
      // last cached frame until the user pauses. Safe because the proxy
      // is short-GOP (ADR 0008): a seek decodes only a few frames, well
      // within this window, so each fire's frame lands before the next
      // re-target (no churn). > debounceMs so a real pause fires first.
      maxWaitMs: 180,
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
    this.warmupStartMs = performance.now();
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

  /// Hard seek to a composition time. Clock + visual feedback are
  /// immediate; the precise decoder fetch is deferred through
  /// `scrubCoalescer` (see its field doc for the debounce contract).
  seek(tUs: number): void {
    this.clock.setPosition(tUs);
    // `setPosition` while playing RE-ANCHORS the clock; the compositor must
    // see the fresh anchor BEFORE the composite below, or its audio pass maps
    // the new position through the old anchor — for a backward in-play seek
    // that crosses a chunk boundary, that plans an immediate-start chunk the
    // old schedule is still playing over (a frame of doubled audio the next
    // tick's teardown cannot recall once the read wins the rAF race).
    this.compositor.setClockAnchor(this.clock.getAnchor());
    // In-play seek flushes the decoder rings — arm the underrun
    // tracker's grace window so the rebuild interval doesn't count as
    // dropped frames on every timeline click during playback.
    if (this.intendedPlaying) this.compositor.noteSeekWhilePlaying();
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
        // Stamp warmup duration + reason for the HUD before
        // releasing the clock. `warmupStartMs` is null if `pause()`
        // raced in mid-warmup; skip the record in that case.
        if (this.warmupStartMs !== null) {
          const elapsed = performance.now() - this.warmupStartMs;
          this.lastWarmupMs = elapsed;
          if (elapsed > this.maxWarmupMs) this.maxWarmupMs = elapsed;
          this.lastWarmupReason = lookaheadReady ? "lookahead-ready" : "deadline-hit";
          this.warmupStartMs = null;
        }
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
  /// when the project has no enabled layers at all — so a brand-new
  /// empty project still auto-pauses at composition end if the user
  /// manages to start playback.
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
    // Discard the in-flight warmup timestamp — pausing during
    // warmup is a "didn't actually warm up" case, recording it
    // would skew the HUD's max with the time the user was
    // hovering on pause.
    this.warmupStartMs = null;
  }

  /// HUD getter. Cheap — no allocation per call.
  getWarmupStats(): WarmupStats {
    return {
      lastMs: this.lastWarmupMs,
      maxMs: this.maxWarmupMs,
      lastReason: this.lastWarmupReason,
    };
  }

  /// Called by PerfHUD's reset button alongside Compositor's
  /// `resetPerfPeaks()` so a one-off cold-start spike doesn't pin
  /// the displayed max forever.
  resetWarmupStats(): void {
    this.lastWarmupMs = null;
    this.maxWarmupMs = 0;
    this.lastWarmupReason = null;
  }

  private lastEmittedUs = -1;

  /// Arrow-function class field so `this` binds correctly when the
  /// Ticker invokes it, and so reference identity is stable for
  /// `ticker.remove(this.tick, this)` in dispose.
  private tick = (): void => {
    // The rAF timestamp Pixi was handed for THIS frame, reconstructed because
    // `Ticker.update` assigns `lastTime = currentTime` only AFTER its listeners
    // run — so during the tick `lastTime` is still the previous frame's stamp
    // and `elapsedMS` is the (uncapped) gap to this one. Verified equal to
    // `document.timeline.currentTime` inside the callback. Gives the profiler
    // the split between "the frame arrived late" and "the frame never arrived".
    const t0 = stageFrameBegin(this.ticker.lastTime + this.ticker.elapsedMS);
    try {
      const tClock = stageNow();
      const { tUs } = this.clock.tick();
      stageAdd(STAGE.ClockTick, tClock);
      // Forward THE clock anchor so the AudioMixers schedule against the
      // exact pair the playhead derives from (docs/audio.md §Clock).
      // Cheap: a reference set; null while paused or audio-suspended.
      this.compositor.setClockAnchor(this.clock.getAnchor());
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
        // (frame-anchor playhead rule — docs/data-model.md). That value is
        // inside the final layer's exclusive `[t_start, t_end)` interval,
        // so one value drives both the emitted timecode AND the composite.
        // Exact-rational `lastFrameAnchorUs` is required — a pre-rounded
        // frame duration drifts onto the second-to-last frame (see
        // `Compositor.fpsNum`).
        const parkUs = this.compositor.lastFrameAnchorUs(endUs);
        this.clock.setPosition(parkUs);
        // Same anchor-forwarding rule as seek(): the park re-anchored the
        // clock while `Compositor.playing` is still true, so the composite
        // below runs an audio pass — against the stale anchor unless it is
        // refreshed here first.
        this.compositor.setClockAnchor(this.clock.getAnchor());
        this.compositor.setAnchorTime(parkUs);
        this.compositor.compositeFrame(parkUs);
        if (parkUs !== this.lastEmittedUs) {
          this.lastEmittedUs = parkUs;
          this.emitTime(parkUs);
        }
        this.pause();
        return;
      }
      const tAnchor = stageNow();
      this.compositor.setAnchorTime(tUs);
      stageAdd(STAGE.Anchor, tAnchor);
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
    } finally {
      // Every exit closes the frame it opened — the auto-pause early return
      // above and the catch included.
      stageAdd(STAGE.TickTotal, t0);
      stageFrameEnd();
    }
  };

  private emitTime(tUs: number): void {
    for (const cb of this.timeListeners) cb(tUs);
  }

  private emitPlayState(playing: boolean): void {
    for (const cb of this.playStateListeners) cb(playing);
  }
}
