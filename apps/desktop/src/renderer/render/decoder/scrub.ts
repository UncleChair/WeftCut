// Debounced scrub coalescer. Caller `requestSeek(tUs)` may fire at
// scroll-wheel speed (hundreds/sec); the coalescer batches into one
// seek-to-IDR + decode per target — mid-scrub frames are discarded, only
// the latest target frame paints. Two timers gate a fire (whichever
// elapses first): DEBOUNCE (quiet period, reset per seek) and MAX-WAIT
// (ceiling, armed once per pending sequence) — semantics + the GOP-bound
// landmine live on `ScrubCoalescerInit`.
//
// See docs/render.md#scrub.

export interface ScrubCoalescerInit {
  /// Debounce window in ms. Default: 20.
  debounceMs?: number;
  /// Ceiling (ms) after which a pending target fires even under an
  /// unbroken stream of `requestSeek` calls — without it, a drag that
  /// never pauses for `debounceMs` keeps resetting the debounce timer and
  /// the preview stays frozen on the last cached frame for the whole drag.
  /// Must be > `debounceMs` so a real pause still fires first, and ≥ the
  /// worst-case decode time from a keyframe: if a seek's decode outruns
  /// this interval, every fire flushes an unfinished decode and nothing
  /// ever paints (safe with the short-GOP proxy — ADR 0008; a ~1 s GOP
  /// churns exactly that way). Default: 180.
  maxWaitMs?: number;
  /// Callback invoked with the stable target after the debounce window.
  onStableSeek: (tUs: number) => Promise<void>;
}

export class ScrubCoalescer {
  private debounceMs: number;
  private maxWaitMs: number;
  private onStableSeek: (tUs: number) => Promise<void>;
  /// Quiet-period timer — reset on every `requestSeek`.
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /// Ceiling timer — armed once per pending sequence, never reset, so a
  /// continuous drag still fires.
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTarget: number | null = null;
  private inFlight = false;

  constructor(init: ScrubCoalescerInit) {
    this.debounceMs = init.debounceMs ?? 20;
    this.maxWaitMs = init.maxWaitMs ?? 180;
    this.onStableSeek = init.onStableSeek;
  }

  requestSeek(tUs: number): void {
    this.pendingTarget = tUs;
    // Quiet-period timer: reset each call so a pause fires promptly.
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.fire(), this.debounceMs);
    // Ceiling timer: arm once per pending sequence; do NOT reset, so an
    // unbroken drag still fires every `maxWaitMs`.
    if (this.maxWaitTimer === null) {
      this.maxWaitTimer = setTimeout(() => this.fire(), this.maxWaitMs);
    }
  }

  cancel(): void {
    this.clearTimers();
    this.pendingTarget = null;
  }

  private clearTimers(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxWaitTimer !== null) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }
  }

  private async fire(): Promise<void> {
    if (this.inFlight) {
      // A seek is still running; let it finish, then process the latest
      // target via the quiet-period timer (the ceiling already elapsed).
      if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.fire(), this.debounceMs);
      return;
    }
    const target = this.pendingTarget;
    if (target === null) {
      this.clearTimers();
      return;
    }
    this.pendingTarget = null;
    this.clearTimers(); // both timers reset; next requestSeek re-arms the ceiling
    this.inFlight = true;
    try {
      await this.onStableSeek(target);
    } finally {
      this.inFlight = false;
      // A new target arrived mid-seek → schedule it.
      if (this.pendingTarget !== null) {
        this.debounceTimer = setTimeout(() => this.fire(), this.debounceMs);
      }
    }
  }
}
