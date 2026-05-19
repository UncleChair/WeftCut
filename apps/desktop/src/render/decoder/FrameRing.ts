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
      // eslint-disable-next-line no-console
      console.warn(
        `[weftcut/pixi] ring.push DROP: ptsUs=${ptsUs} dur=${durationUs} ` +
          `anchor=${this.anchorUs} lookbehind=${this.lookbehindUs}`,
      );
      frame.close();
      return;
    }
    this.entries.push({ ptsUs, durationUs, frame });
    // Keep sorted by PTS. Decoder output is usually in display order
    // but B-frames can cause minor reordering on some encoders.
    this.entries.sort((a, b) => a.ptsUs - b.ptsUs);
    if (this.entries.length === 1) {
      // eslint-disable-next-line no-console
      console.log(
        `[weftcut/pixi] ring.push first frame: ptsUs=${ptsUs} dur=${durationUs} ` +
          `anchor=${this.anchorUs} size=${this.entries.length}`,
      );
    }
  }

  /// Look up the frame to display at `tUs`. Returns a borrowed
  /// reference — caller MUST NOT `.close()` it. Returns `null` only
  /// when the ring is completely empty.
  ///
  /// Clamping policy: out-of-range timestamps clamp to the nearest
  /// available frame. This matters because real-world proxies often
  /// start at a non-zero PTS (an `-ss` or edit-list offset in the
  /// source can leave the first decoded frame at PTS=33333µs even
  /// though the timeline says t=0). Returning the nearest available
  /// frame is the correct UX — the renderer paints SOMETHING at
  /// every t, instead of going blank because the asked-for timestamp
  /// fell outside the cached window.
  frameAt(tUs: number): VideoFrame | null {
    if (this.entries.length === 0) return null;

    // Before the earliest cached frame → clamp to first.
    const first = this.entries[0]!;
    if (tUs < first.ptsUs) {
      return first.frame;
    }

    // After the latest cached frame's interval → clamp to last.
    const last = this.entries[this.entries.length - 1]!;
    if (tUs >= last.ptsUs + (last.durationUs || 0)) {
      return last.frame;
    }

    // Binary search for the entry whose interval contains tUs.
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

    // Fallback: nearest preceding (only reachable if duration is
    // zero on multiple consecutive entries, which shouldn't happen
    // in practice).
    return this.entries[hi]?.frame ?? this.entries[0]!.frame;
  }

  /// Drop everything. Use on seek beyond the lookahead window.
  flush(): void {
    for (const e of this.entries) e.frame.close();
    this.entries = [];
  }

  size(): number {
    return this.entries.length;
  }

  /// PTS in microseconds of the earliest cached frame, or null if
  /// the ring is empty. Diagnostic helper.
  firstPtsUs(): number | null {
    return this.entries[0]?.ptsUs ?? null;
  }

  /// PTS in microseconds of the latest cached frame, or null if
  /// the ring is empty. Diagnostic helper.
  lastPtsUs(): number | null {
    return this.entries[this.entries.length - 1]?.ptsUs ?? null;
  }

  dispose(): void {
    this.flush();
  }
}
