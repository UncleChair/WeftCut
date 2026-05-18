// Lookahead/lookbehind frame ring for one source.
//
// Plan: docs/pixi-renderer-plan.md (8c.2 — 1 s ahead / 0.5 s behind)
//
// Behavior: caller `push(frame)`es decoded VideoFrames in monotonic
// PTS order. `frameAt(tUs)` returns the frame whose presentation
// interval contains `tUs`, or `null` if not yet decoded. `setAnchor(tUs)`
// evicts frames older than `tUs - lookbehindUs` and rejects pushes for
// PTS more than `lookaheadUs` ahead — the caller's decode loop can
// pause when push() returns false.

const DEFAULT_LOOKAHEAD_US = 1_000_000;
const DEFAULT_LOOKBEHIND_US = 500_000;

interface RingEntry {
  ptsUs: number;
  durationUs: number;
  frame: VideoFrame;
}

export interface FrameRingInit {
  lookaheadUs?: number;
  lookbehindUs?: number;
}

export class FrameRing {
  private entries: RingEntry[] = [];
  private anchorUs = 0;
  private lookaheadUs: number;
  private lookbehindUs: number;

  constructor(init: FrameRingInit = {}) {
    this.lookaheadUs = init.lookaheadUs ?? DEFAULT_LOOKAHEAD_US;
    this.lookbehindUs = init.lookbehindUs ?? DEFAULT_LOOKBEHIND_US;
  }

  /// Set the current play / scrub position. Evicts anything older
  /// than `anchorUs - lookbehindUs`.
  setAnchor(tUs: number): void {
    this.anchorUs = tUs;
    const minKeepUs = tUs - this.lookbehindUs;
    while (this.entries.length > 0) {
      const first = this.entries[0]!;
      if (first.ptsUs + first.durationUs <= minKeepUs) {
        first.frame.close();
        this.entries.shift();
      } else {
        break;
      }
    }
  }

  /// Whether a frame at `tUs` is *needed* given the current anchor +
  /// window. Caller's decode loop uses this to decide if it should
  /// keep pumping.
  needsFrameAt(tUs: number): boolean {
    return (
      tUs >= this.anchorUs - this.lookbehindUs &&
      tUs <= this.anchorUs + this.lookaheadUs
    );
  }

  /// True if the decode pump should pause — the lookahead is full.
  isLookaheadFull(): boolean {
    const last = this.entries[this.entries.length - 1];
    if (!last) return false;
    return last.ptsUs >= this.anchorUs + this.lookaheadUs;
  }

  /// Push a decoded frame. Caller transfers ownership; we close the
  /// frame on eviction. PTS is `frame.timestamp` in microseconds.
  push(frame: VideoFrame): void {
    const ptsUs = frame.timestamp;
    const durationUs = frame.duration ?? 0;
    // If this frame is already behind the lookbehind window, drop it.
    if (ptsUs + durationUs < this.anchorUs - this.lookbehindUs) {
      frame.close();
      return;
    }
    this.entries.push({ ptsUs, durationUs, frame });
    // Keep sorted by PTS. Decoder output is usually in display order
    // but B-frames can cause minor reordering on some encoders.
    this.entries.sort((a, b) => a.ptsUs - b.ptsUs);
  }

  /// Look up the frame whose presentation interval contains `tUs`.
  /// Returns a borrowed reference — caller MUST NOT `.close()` it.
  /// Returns `null` when no covering frame is cached.
  frameAt(tUs: number): VideoFrame | null {
    // Binary search by ptsUs.
    let lo = 0;
    let hi = this.entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = this.entries[mid]!;
      if (e.ptsUs <= tUs && tUs < e.ptsUs + (e.durationUs || Number.POSITIVE_INFINITY)) {
        return e.frame;
      }
      if (e.ptsUs > tUs) hi = mid - 1;
      else lo = mid + 1;
    }
    // Fall back to the nearest preceding frame so a tUs that landed
    // between samples still paints something.
    if (hi >= 0) {
      return this.entries[hi]!.frame;
    }
    return null;
  }

  /// Drop everything. Use on seek beyond the lookahead window.
  flush(): void {
    for (const e of this.entries) e.frame.close();
    this.entries = [];
  }

  size(): number {
    return this.entries.length;
  }

  dispose(): void {
    this.flush();
  }
}
