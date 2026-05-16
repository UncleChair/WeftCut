/// Phase A.3 — DOM preview playback engine.
///
/// Owns the synthetic master clock + RAF loop + handle registry. Pure
/// TypeScript; no React imports. Designed in `docs/preview-dom.md` Q4
/// (γ: synthetic clock as master, Web Audio is the mixer not the
/// timing source). Replaces the legacy WebCodecs `playbackEngine` from
/// the B.3 path that Phase F deleted at cutover.
///
/// Architecture:
///   - master_us advances from a `performance.now()` baseline, with
///     pause time accumulated out so resume continues where we left
///     off rather than jumping ahead.
///   - A registry of `LayerHandle`s receives `tick(masterUs, playing)`
///     every RAF frame. Each handle drives its own DOM element (a
///     `<video>`, `<audio>`, `<canvas>`, or `<div>` — the last serving
///     both generic color/text layers and template hosts via Shadow
///     DOM; see `TemplateHandle.ts` for why iframes are not used); the
///     engine never touches the DOM directly.
///   - `play()` / `pause()` / `seek()` / `beginScrub()` / `endScrub()`
///     are the entire mutating API. UI subscribes via `onTimeUpdate`
///     and `onPlayStateChange`.
///   - An optional `AudioGraph` (A.6) provides scrub-mute / unmute;
///     without it those calls are no-ops.

export interface LayerHandle {
  /// Per-RAF update. The handle is responsible for driving its DOM
  /// element to reflect `masterUs`:
  ///   - playing: do drift-nudge as needed; let media element play
  ///     naturally otherwise.
  ///   - paused/scrubbing: snap the element to the exact target time.
  tick(masterUs: number, playing: boolean): void;
  /// Tear down the handle. Engine calls this on `unregisterHandle` and
  /// on `dispose()`. Implementations should pause + disconnect their
  /// element + release Web Audio nodes here.
  dispose(): void;
}

export interface AudioGraphLike {
  /// Smoothly mute the master gain for scrub. Called from
  /// `beginScrub`; the corresponding `unmuteMaster` runs in `endScrub`.
  muteMaster(): void;
  unmuteMaster(): void;
}

interface SubscriberSlot<T> {
  cb: (value: T) => void;
}

/// Default cadence for `onTimeUpdate` callbacks. The RAF loop ticks
/// at the display refresh rate (~60 Hz on most desktops); throttling
/// to 30 Hz is plenty smooth for a timeline playhead readout and
/// halves the React reconciler load.
const TIME_UPDATE_INTERVAL_MS = 33;

export interface PlaybackEngineOptions {
  /// Optional audio graph for scrub-mute. Engine works without it; the
  /// scrub-mute path becomes a no-op (handles still mute themselves if
  /// they choose).
  audioGraph?: AudioGraphLike;
}

export class PlaybackEngine {
  private handles = new Map<string, LayerHandle>();

  /// `performance.now()` baseline established at first play(). Null
  /// when never played.
  private startedAtMs: number | null = null;
  /// Sum of all paused-window durations in ms, subtracted from
  /// `(now - startedAtMs)` to get the actual playback elapsed.
  private accumulatedPauseOffsetMs = 0;
  /// Wall-clock when the current pause began. Null when playing.
  private pausedAtMs: number | null = null;
  /// True iff master clock is currently advancing.
  private playing = false;
  /// True iff a scrub is in progress. Audio is muted; handles see
  /// playing=false.
  private scrubbing = false;

  /// Cached masterUs the engine reports without recomputing — set
  /// each tick to avoid two `performance.now()` reads per call.
  private masterUs = 0;

  private rafId: number | null = null;
  private disposed = false;

  private timeSubscribers: SubscriberSlot<number>[] = [];
  private playStateSubscribers: SubscriberSlot<boolean>[] = [];
  private lastTimeReportMs = 0;

  constructor(private readonly options: PlaybackEngineOptions = {}) {
    this.loop = this.loop.bind(this);
    this.rafId = requestAnimationFrame(this.loop);
  }

  // ===== Handle registry ==================================================

  /// Register a handle. Idempotent on `layerId` — a re-registration
  /// disposes the prior handle first (mostly to keep HMR + React
  /// strict-mode double-mount sane).
  registerHandle(layerId: string, handle: LayerHandle): void {
    const prior = this.handles.get(layerId);
    if (prior && prior !== handle) {
      try {
        prior.dispose();
      } catch (e) {
        console.warn(`PlaybackEngine: prior handle dispose failed for ${layerId}:`, e);
      }
    }
    this.handles.set(layerId, handle);
  }

  unregisterHandle(layerId: string): void {
    const h = this.handles.get(layerId);
    if (!h) return;
    this.handles.delete(layerId);
    try {
      h.dispose();
    } catch (e) {
      console.warn(`PlaybackEngine: handle dispose failed for ${layerId}:`, e);
    }
  }

  // ===== Transport ========================================================

  /// Start advancing the master clock. Idempotent if already playing.
  /// Caller is responsible for `await`ing AudioContext resume on the
  /// AudioGraph BEFORE play() — the engine itself doesn't touch audio
  /// directly (separation of concerns; A.6 owns AudioGraph).
  play(): void {
    if (this.disposed) return;
    if (this.playing) return;
    const now = performance.now();
    if (this.startedAtMs === null) {
      this.startedAtMs = now;
    } else if (this.pausedAtMs !== null) {
      this.accumulatedPauseOffsetMs += now - this.pausedAtMs;
      this.pausedAtMs = null;
    }
    this.playing = true;
    this.emitPlayState(true);
  }

  pause(): void {
    if (this.disposed) return;
    if (!this.playing) return;
    this.pausedAtMs = performance.now();
    this.playing = false;
    this.emitPlayState(false);
  }

  /// Set the master clock to `masterUs`. Works in both play and pause
  /// states; the next tick syncs every handle to the new position.
  seek(masterUs: number): void {
    if (this.disposed) return;
    if (masterUs < 0) masterUs = 0;
    this.masterUs = masterUs;
    const now = performance.now();
    const elapsedMs = masterUs / 1000;
    if (this.playing) {
      // Re-baseline `startedAtMs` so the next loop iteration computes
      // the same elapsed without a jump.
      this.startedAtMs = now - elapsedMs - this.accumulatedPauseOffsetMs;
    } else {
      // Anchor the clock at the target. On the next `play()` we'll
      // resume from here; `pausedAtMs` stays current so the
      // accumulated-offset math stays correct.
      this.startedAtMs = now - elapsedMs - this.accumulatedPauseOffsetMs;
      this.pausedAtMs = now;
    }
    // Push the new time + run a synchronous tick so the visible
    // surface updates immediately (otherwise a paused seek waits
    // until the next RAF, which is fine for play but creates a
    // visible lag on scrub).
    this.emitTime(masterUs, /*force=*/ true);
    this.runHandleTick();
  }

  /// Enter scrub mode. Mutes audio + tells handles to snap rather than
  /// drift-nudge. Use during pointermove on the playhead.
  beginScrub(): void {
    if (this.disposed) return;
    this.scrubbing = true;
    this.options.audioGraph?.muteMaster();
  }

  /// Exit scrub mode. Unmutes audio. The engine's `playing` state is
  /// unchanged — if you were playing before scrub, you're playing
  /// after.
  endScrub(): void {
    if (this.disposed) return;
    this.scrubbing = false;
    this.options.audioGraph?.unmuteMaster();
  }

  // ===== Read-only state ==================================================

  getMasterUs(): number {
    return this.masterUs;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  isScrubbing(): boolean {
    return this.scrubbing;
  }

  // ===== Subscriptions ====================================================

  onTimeUpdate(cb: (masterUs: number) => void): () => void {
    const slot = { cb };
    this.timeSubscribers.push(slot);
    return () => {
      const i = this.timeSubscribers.indexOf(slot);
      if (i >= 0) this.timeSubscribers.splice(i, 1);
    };
  }

  onPlayStateChange(cb: (playing: boolean) => void): () => void {
    const slot = { cb };
    this.playStateSubscribers.push(slot);
    return () => {
      const i = this.playStateSubscribers.indexOf(slot);
      if (i >= 0) this.playStateSubscribers.splice(i, 1);
    };
  }

  // ===== Lifecycle ========================================================

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    for (const [, h] of this.handles) {
      try {
        h.dispose();
      } catch (e) {
        console.warn("PlaybackEngine: handle dispose failed on teardown:", e);
      }
    }
    this.handles.clear();
    this.timeSubscribers.length = 0;
    this.playStateSubscribers.length = 0;
  }

  // ===== Internal =========================================================

  /// RAF loop body. Advances the master clock (if playing), updates
  /// `masterUs`, runs handle ticks, fires `onTimeUpdate` at the
  /// throttled cadence.
  private loop(): void {
    if (this.disposed) return;
    const now = performance.now();
    if (this.playing && this.startedAtMs !== null) {
      const elapsedMs = now - this.startedAtMs - this.accumulatedPauseOffsetMs;
      this.masterUs = Math.max(0, Math.round(elapsedMs * 1000));
    }
    this.runHandleTick();
    this.emitTime(this.masterUs, /*force=*/ false);
    this.rafId = requestAnimationFrame(this.loop);
  }

  /// Run a synchronous handle tick. Factored so `seek()` can drive
  /// one out-of-band update without waiting for the next RAF.
  private runHandleTick(): void {
    // The "playing" signal handles see is `playing && !scrubbing`.
    // Scrubbing handles fall into the snap-to-target path inside the
    // handle (no drift-nudge, no auto-advance) regardless of whether
    // the user was playing before scrub started.
    const handlePlaying = this.playing && !this.scrubbing;
    // Iterate over a snapshot — a handle's tick could conceivably
    // register or unregister another handle (e.g. a wrapping layer
    // managing children).
    const snapshot = Array.from(this.handles.values());
    for (const h of snapshot) {
      try {
        h.tick(this.masterUs, handlePlaying);
      } catch (e) {
        console.warn("PlaybackEngine: handle tick failed:", e);
      }
    }
  }

  private emitTime(us: number, force: boolean): void {
    const now = performance.now();
    if (!force && now - this.lastTimeReportMs < TIME_UPDATE_INTERVAL_MS) return;
    this.lastTimeReportMs = now;
    for (const s of this.timeSubscribers) {
      try {
        s.cb(us);
      } catch (e) {
        console.warn("PlaybackEngine: onTimeUpdate subscriber threw:", e);
      }
    }
  }

  private emitPlayState(playing: boolean): void {
    for (const s of this.playStateSubscribers) {
      try {
        s.cb(playing);
      } catch (e) {
        console.warn("PlaybackEngine: onPlayStateChange subscriber threw:", e);
      }
    }
  }
}
