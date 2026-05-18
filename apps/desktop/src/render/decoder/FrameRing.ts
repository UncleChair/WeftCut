// Lookahead/lookbehind frame ring for one source.
//
// Plan: docs/pixi-renderer-plan.md (8c.2 — 1s ahead / 0.5s behind)
//
// P0 stub — implementation lands in P1.

export interface FrameRingInit {
  /// Lookahead in microseconds. Default: 1_000_000 (1s).
  lookaheadUs?: number;
  /// Lookbehind in microseconds. Default: 500_000 (0.5s).
  lookbehindUs?: number;
}

export class FrameRing {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_init: FrameRingInit = {}) {
    // P1: VideoFrame[] keyed by PTS with the window invariant.
  }

  /// Return the decoded frame whose presentation interval contains
  /// `tUs`, or `null` if outside the cached window. Caller must
  /// `frame.close()` when done if `ownership: "transfer"` is used.
  frameAt(_tUs: number): VideoFrame | null {
    return null;
  }

  /// Push a newly-decoded frame. Evicts older frames outside the
  /// lookbehind window.
  push(_frame: VideoFrame): void {
    // P1
  }

  /// Drop all cached frames (e.g., on seek).
  flush(): void {
    // P1
  }

  dispose(): void {
    // P1: close all retained VideoFrames.
  }
}
