// Playback underrun detection — the signal behind the transport-bar
// indicator (and, later, res-throttle / stop-on-drop).
//
// The playback clock free-runs off the audio hardware clock and never
// waits for decode (industry-standard NLE transport; docs/render.md).
// When the decoder falls behind, the painter deliberately holds its
// previous frame (`ActiveClip.boundFramePtsUs`), so without this module
// the only trace of an underrun is a console log.
//
// Two independent causes of "playback isn't keeping up", counted
// separately because they point at different fixes:
//
//   - **dropped** — `judgeFrameSelection` says the ring had no fresh
//     frame for a painted VideoClip. The decoder is behind.
//   - **late** — the composite loop itself ticked past one comp-frame
//     budget. The ring can be full and every selection fresh while a
//     synchronous GPU drain or a heavy raster stalls the loop; that
//     judder is invisible to the frame-selection verdict.
//
// Both drive one edge-triggered "active" flag safe to write straight
// into React state. This module owns neither the loop nor the ring:
// `Compositor` hands it the frame-selection verdict once per composite
// sweep, and the tick interval falls out of that same call's clock read.

/// Slack added to the selected frame's presentation window before it
/// counts as stale. Absorbs ±1 µs rational-rounding jitter between the
/// comp-frame grid and source PTS grids without masking a real one-frame
/// lag.
const DURATION_JITTER_US = 1_000;

/// Freshness window when the source reported no per-frame duration
/// (WebCodecs may emit `duration: null`). Same scale as the ring's
/// `CLAMP_TO_FIRST_GAP_US`: generous enough for any real media frame
/// interval (24 fps ≈ 42 ms), small enough that a visible freeze
/// still trips it.
const FALLBACK_FRESH_GAP_US = 100_000;

/// Source times within this of the media's end are exempt from lateness:
/// a clip trimmed to (or past) the last media frame legitimately holds
/// that frame forever — EOS, not underrun. Sized around one low-fps
/// media frame so the exemption never hides more than the tail frame.
const EOS_GUARD_US = 50_000;

export type FrameVerdict = "fresh" | "late";

export interface FrameSelectionJudgeInput {
  /// PTS of the frame the painter bound, or null when the ring had
  /// nothing paintable (starved — the painter held its previous image).
  selectedPtsUs: number | null;
  /// Duration of the bound frame; `<= 0` means the source didn't report
  /// one and the fallback gap applies.
  selectedDurationUs: number;
  /// Requested source time (`src_in_us` + layer-local offset).
  srcTUs: number;
  /// Media duration for the EOS exemption; null disables it.
  mediaDurationUs: number | null;
}

/// Classify one painted VideoClip frame. "late" means a newer frame
/// should exist at `srcTUs` but the decoder hasn't produced it.
export function judgeFrameSelection(input: FrameSelectionJudgeInput): FrameVerdict {
  const { selectedPtsUs, selectedDurationUs, srcTUs, mediaDurationUs } = input;
  // EOS exemption first: past the end of real media there is no newer
  // frame to be late FOR. Checked before the starved branch so a clip
  // trimmed past EOS whose ring drained doesn't flag either.
  if (mediaDurationUs !== null && srcTUs + EOS_GUARD_US >= mediaDurationUs) {
    return "fresh";
  }
  if (selectedPtsUs === null) return "late";
  const gapUs = srcTUs - selectedPtsUs;
  // Negative gap = the ring clamped forward to its first entry (CTS /
  // edit-list offset) — the decoder is ahead, not behind.
  if (gapUs <= 0) return "fresh";
  if (selectedDurationUs > 0) {
    return srcTUs < selectedPtsUs + selectedDurationUs + DURATION_JITTER_US
      ? "fresh"
      : "late";
  }
  return gapUs <= FALLBACK_FRESH_GAP_US ? "fresh" : "late";
}

export interface UnderrunSnapshot {
  /// True while an underrun of EITHER cause was observed within the last
  /// `holdMs` — drives the indicator's "lit" state. Held on briefly after
  /// recovery so a flickering ring doesn't strobe the UI.
  active: boolean;
  /// Comp frames painted from a stale ring since the current play session
  /// started. Persists after pause (Premiere-style: the count stays
  /// visible until the next play) and resets on the next `beginPlay()`.
  droppedFrames: number;
  /// Comp frames whose composite tick arrived more than one comp-frame
  /// budget after the previous one. Same session lifecycle as
  /// `droppedFrames`; a stalled loop scores here and not there.
  lateFrames: number;
}

/// Both per-session counts, for the status-log row on pause.
export interface UnderrunSessionSummary {
  droppedFrames: number;
  lateFrames: number;
}

export interface UnderrunTrackerInit {
  /// Edge-triggered + throttled observer. Fires immediately on
  /// inactive→active and active→inactive flips; count-only growth while
  /// active is coalesced to one emission per `minEmitIntervalMs`. Never
  /// fires when nothing changed — safe to feed straight into React state.
  /// (`| undefined` for exactOptionalPropertyTypes pass-through.)
  onChange?: ((snapshot: UnderrunSnapshot) => void) | undefined;
  /// How long `active` stays true after the last underrun of either cause.
  holdMs?: number;
  /// Cap on the post-seek grace window (see `noteSeekWhilePlaying`).
  graceMaxMs?: number;
  /// Minimum interval between count-growth emissions while active.
  minEmitIntervalMs?: number;
  /// Injectable clock for tests; defaults to `performance.now`.
  now?: () => number;
}

const DEFAULT_HOLD_MS = 1_500;
const DEFAULT_GRACE_MAX_MS = 1_000;
const DEFAULT_MIN_EMIT_INTERVAL_MS = 250;

/// Slack added to the comp-frame budget before a composite tick counts as
/// late. **Additive, and bounded on both sides** — do the arithmetic
/// before changing it:
///   - Upper: the measured judder cell (30 fps comp, budget 33.3 ms) has
///     a tick p99 of 38.8 ms and must trip, so slack < 5.5 ms. A
///     multiplicative 1.25× budget (41.7 ms) would silently miss it.
///   - Lower: rAF lands at 14–19 ms on a 60 Hz display, so at a 60 fps
///     comp (16.7 ms budget) the slack must absorb ~2.4 ms of healthy
///     overshoot or every tick reads late.
/// 4 ms sits inside both. The healthy reference cell (tick p95 17.4 ms at
/// a 30 fps comp) is nowhere near the resulting 37.3 ms threshold.
const TICK_SLACK_MS = 4;

/// Floor under the comp-frame budget. The composite loop is rAF-driven,
/// so it can never tick faster than the display refresh; without this a
/// composition authored above 60 fps would report EVERY tick late on an
/// ordinary display. Errs toward under-reporting, which is the right
/// direction for a user-facing indicator.
const MIN_TICK_BUDGET_MS = 1_000 / 60;

/// Budget assumed until `bindFrameBudgetMs` learns the composition's fps
/// — matches `Compositor`'s own 30 fps default.
const DEFAULT_TICK_BUDGET_MS = 1_000 / 30;

export class UnderrunTracker {
  private readonly onChange: ((s: UnderrunSnapshot) => void) | undefined;
  private readonly holdMs: number;
  private readonly graceMaxMs: number;
  private readonly minEmitIntervalMs: number;
  private readonly now: () => number;

  private active = false;
  private droppedFrames = 0;
  private lateFrames = 0;
  private activeUntilMs = 0;
  private tickBudgetMs = DEFAULT_TICK_BUDGET_MS;
  /// Comp time of the last frame counted as dropped, so a frame judged
  /// late on several rAF ticks (rAF runs faster than the comp grid)
  /// counts once.
  private lastDropFrameUs: number | null = null;
  /// The `lastDropFrameUs` twin for late ticks — same per-comp-frame
  /// dedupe, kept separate so one cause can't swallow the other's count.
  private lastLateFrameUs: number | null = null;
  /// Stamp of the previous composite tick. Written by BOTH `judgeSweep`
  /// and `tickDecay`: `tickDecay` runs on every composite while
  /// `judgeSweep` is skipped during a scrub, so if only `judgeSweep`
  /// stamped it, the whole scrub would resurface as one enormous late
  /// tick the moment judging resumed. Null = no previous tick to
  /// difference against (first tick of a play session).
  private lastTickMs: number | null = null;
  /// In-play seek grace: true while underruns of either cause are
  /// suppressed. Cleared by the first sweep that is both all-fresh and
  /// on time (pipeline re-primed) or by `graceDeadlineMs` (so genuinely
  /// wedged playback can't hide behind an eternal grace).
  private graceArmed = false;
  private graceDeadlineMs = 0;
  private lastEmitMs = -Infinity;
  private lastEmittedActive = false;
  private lastEmittedDropped = 0;
  private lastEmittedLate = 0;
  /// One-shot latch for `takeSessionSummary` — pause() fires
  /// unconditionally (including pause-during-warmup, where no new play
  /// session ever began), so without the latch a stale session's count
  /// would be re-reported.
  private sessionConsumed = false;

  constructor(init: UnderrunTrackerInit = {}) {
    this.onChange = init.onChange;
    this.holdMs = init.holdMs ?? DEFAULT_HOLD_MS;
    this.graceMaxMs = init.graceMaxMs ?? DEFAULT_GRACE_MAX_MS;
    this.minEmitIntervalMs = init.minEmitIntervalMs ?? DEFAULT_MIN_EMIT_INTERVAL_MS;
    this.now = init.now ?? (() => performance.now());
  }

  /// Teach the tracker the composition's frame budget. Called by
  /// `Compositor` wherever it recomputes `fpsNum`/`fpsDen`.
  bindFrameBudgetMs(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.tickBudgetMs = Math.max(ms, MIN_TICK_BUDGET_MS);
  }

  /// New play session (master clock released): reset counters so the
  /// indicator reflects THIS run, not history.
  beginPlay(): void {
    this.droppedFrames = 0;
    this.lateFrames = 0;
    this.lastDropFrameUs = null;
    this.lastLateFrameUs = null;
    // Drop the stamp, not just the counts: the pause before this play
    // would otherwise difference into one session-opening late tick.
    this.lastTickMs = null;
    this.active = false;
    this.activeUntilMs = 0;
    this.graceArmed = false;
    this.sessionConsumed = false;
    this.emit(true);
  }

  /// Arm the post-seek grace window. An in-play seek flushes the rings,
  /// so the following ~ring-rebuild interval — stale selections and the
  /// stalled ticks that rebuild causes alike — would otherwise score on
  /// every timeline click during playback.
  noteSeekWhilePlaying(): void {
    this.graceArmed = true;
    this.graceDeadlineMs = this.now() + this.graceMaxMs;
  }

  /// One verdict per composite sweep while the master clock is running.
  /// `anyLate` = at least one visible VideoClip painted from a stale ring;
  /// `frameUs` is the snapped comp time that was judged. The late-tick
  /// half takes no argument — it differences this call's own clock read,
  /// which already existed, so the whole classifier adds no `now()` here.
  judgeSweep(anyLate: boolean, frameUs: number): void {
    const nowMs = this.now();
    const prevTickMs = this.lastTickMs;
    this.lastTickMs = nowMs;
    const tickLate =
      prevTickMs !== null &&
      nowMs - prevTickMs > this.tickBudgetMs + TICK_SLACK_MS;
    if (this.graceArmed) {
      if (!anyLate && !tickLate) {
        this.graceArmed = false; // pipeline re-primed; judge normally again
      } else if (nowMs < this.graceDeadlineMs) {
        return;
      } else {
        this.graceArmed = false; // grace expired with playback still behind
      }
    }
    if (!anyLate && !tickLate) return;
    if (anyLate && frameUs !== this.lastDropFrameUs) {
      this.lastDropFrameUs = frameUs;
      this.droppedFrames += 1;
    }
    if (tickLate && frameUs !== this.lastLateFrameUs) {
      this.lastLateFrameUs = frameUs;
      this.lateFrames += 1;
    }
    this.activeUntilMs = nowMs + this.holdMs;
    if (!this.active) {
      this.active = true;
      this.emit(true);
    } else {
      this.emit(false);
    }
  }

  /// Hold-off decay; called every composite (playing or not) so the
  /// indicator dims after the last underrun even once judging stops. Also
  /// the tick clock's second writer, which is why its `now()` read is
  /// unconditional rather than tucked behind `active` — see `lastTickMs`.
  /// That one read is the classifier's entire per-composite cost.
  tickDecay(): void {
    const nowMs = this.now();
    this.lastTickMs = nowMs;
    if (this.active && nowMs >= this.activeUntilMs) {
      this.active = false;
      this.emit(true);
    }
  }

  snapshot(): UnderrunSnapshot {
    return {
      active: this.active,
      droppedFrames: this.droppedFrames,
      lateFrames: this.lateFrames,
    };
  }

  /// Session-end summary for the LogBus row, at most once per play
  /// session (zeroes on repeat calls until the next `beginPlay()`).
  takeSessionSummary(): UnderrunSessionSummary {
    if (this.sessionConsumed) return { droppedFrames: 0, lateFrames: 0 };
    this.sessionConsumed = true;
    return { droppedFrames: this.droppedFrames, lateFrames: this.lateFrames };
  }

  private emit(force: boolean): void {
    if (!this.onChange) return;
    const changed =
      this.active !== this.lastEmittedActive ||
      this.droppedFrames !== this.lastEmittedDropped ||
      this.lateFrames !== this.lastEmittedLate;
    if (!changed) return;
    const nowMs = this.now();
    if (!force && nowMs - this.lastEmitMs < this.minEmitIntervalMs) return;
    this.lastEmitMs = nowMs;
    this.lastEmittedActive = this.active;
    this.lastEmittedDropped = this.droppedFrames;
    this.lastEmittedLate = this.lateFrames;
    this.onChange(this.snapshot());
  }
}
