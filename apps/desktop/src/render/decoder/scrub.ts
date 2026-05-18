// Debounced scrub coalescer.
//
// Plan: docs/pixi-renderer-plan.md (8d.2 — fresh WebCodecs-native)
//
// Behavior: caller `requestSeek(tUs)` may fire at scroll-wheel speed
// (hundreds of times per second). The coalescer batches into one
// `decoder.flush()` + seek-to-IDR + decode-forward operation per ~20ms
// stable target. Mid-scrub frames are discarded; only the latest
// target frame paints.
//
// P0 stub — implementation lands in P1.

export interface ScrubCoalescerInit {
  /// Debounce window in ms. Default: 20.
  debounceMs?: number;
  /// Callback invoked with the stable target after the debounce window.
  onStableSeek: (tUs: number) => Promise<void>;
}

export class ScrubCoalescer {
  private debounceMs: number;
  private onStableSeek: (tUs: number) => Promise<void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingTarget: number | null = null;
  private inFlight = false;

  constructor(init: ScrubCoalescerInit) {
    this.debounceMs = init.debounceMs ?? 20;
    this.onStableSeek = init.onStableSeek;
  }

  requestSeek(tUs: number): void {
    this.pendingTarget = tUs;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), this.debounceMs);
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingTarget = null;
  }

  private async fire(): Promise<void> {
    if (this.inFlight) {
      // Re-debounce if a seek is in flight; let it finish, then process latest.
      this.timer = setTimeout(() => this.fire(), this.debounceMs);
      return;
    }
    const target = this.pendingTarget;
    if (target === null) return;
    this.pendingTarget = null;
    this.timer = null;
    this.inFlight = true;
    try {
      await this.onStableSeek(target);
    } finally {
      this.inFlight = false;
      // If new target arrived during seek, fire again.
      if (this.pendingTarget !== null) {
        this.timer = setTimeout(() => this.fire(), this.debounceMs);
      }
    }
  }
}
