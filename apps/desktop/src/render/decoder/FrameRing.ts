// Lookahead/lookbehind frame ring for one source.
//
// Plan: docs/render.md (8c.2 — 1 s ahead / 0.5 s behind)
//
// Behavior: caller `push(frame)`es decoded VideoFrames in monotonic
// PTS order. `frameAt(tUs)` returns the frame whose presentation
// interval contains `tUs`, or `null` if not yet decoded. `setAnchor(tUs)`
// evicts frames older than `tUs - lookbehindUs` and rejects pushes for
// PTS more than `lookaheadUs` ahead — the caller's decode loop can
// pause when push() returns false.

const DEFAULT_LOOKAHEAD_US = 1_000_000;
const DEFAULT_LOOKBEHIND_US = 500_000;

/// Maximum gap (microseconds) between requested `tUs` and the ring's
/// first entry's PTS for `frameAt` to clamp to the first entry. Within
/// this gap, clamping is the right UX — it handles real-world sources
/// whose first decoded frame has a non-zero CTS (B-frame reorder
/// offset, edit-list `-ss` offset). Beyond this gap, clamping would
/// paint a frame from the wrong region of the timeline (e.g. after
/// lookbehind has evicted the target frame on a backward seek), so
/// `frameAt` returns null and the painter holds its previous frame
/// until the decoder catches up.
const CLAMP_TO_FIRST_GAP_US = 100_000;

interface RingEntry {
  ptsUs: number;
  durationUs: number;
  bitmap: ImageBitmap;
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
        first.bitmap.close();
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

  /// Push a decoded frame as an ImageBitmap. Caller transfers
  /// ownership; we close the bitmap on eviction. `ptsUs` and
  /// `durationUs` come from the source `VideoFrame.timestamp` /
  /// `.duration` (saved before the source frame was closed, since
  /// `ImageBitmap` itself carries no PTS metadata).
  push(bitmap: ImageBitmap, ptsUs: number, durationUs: number): void {
    // If this frame is already behind the lookbehind window, drop it.
    if (ptsUs + durationUs < this.anchorUs - this.lookbehindUs) {
      bitmap.close();
      return;
    }
    // Fast path: append in order. Proxy v4 disables B-frames
    // (`-bf 0`, see proxy.rs) so the decoder emits frames in PTS
    // order; the async `createImageBitmap` step is sequenced via
    // microtasks per output, so consecutive resolves preserve order
    // in practice too. When the new entry's PTS is >= the current
    // tail, the array stays sorted by construction and we skip the
    // O(n log n) sort entirely. Only out-of-order arrivals (B-frame
    // sources, async-bitmap races on closely-spaced frames) hit the
    // safety-net sort.
    const prevLast = this.entries[this.entries.length - 1];
    this.entries.push({ ptsUs, durationUs, bitmap });
    if (prevLast && prevLast.ptsUs > ptsUs) {
      this.entries.sort((a, b) => a.ptsUs - b.ptsUs);
    }
  }

  /// Look up the frame to display at `tUs`. Returns a borrowed
  /// reference — caller MUST NOT `.close()` it. Returns `null` when
  /// the ring is empty OR when `tUs` falls before the ring's first
  /// entry by more than `CLAMP_TO_FIRST_GAP_US` (the painter should
  /// hold its previous frame rather than display a frame from the
  /// wrong region — e.g. after a backward seek where lookbehind has
  /// evicted the target's GOP, the ring's first entry is far ahead
  /// of the target and clamping to it would visibly flash the wrong
  /// content while the decoder rebuilds).
  ///
  /// Clamping policy: clamp to first entry ONLY if the gap between
  /// `tUs` and `entries[0].ptsUs` is within `CLAMP_TO_FIRST_GAP_US`
  /// (real-world CTS / edit-list offsets are usually one frame's
  /// worth; the threshold covers them with headroom). Clamp to last
  /// entry implicitly via the binary-search returning the latest
  /// entry with `ptsUs <= tUs` (correct UX during play-time decode
  /// latency — paint latest decoded while waiting for next).
  ///
  /// Implementation: locate the latest entry whose PTS is `<= tUs`,
  /// without relying on `VideoFrame.duration`. WebCodecs allows
  /// `duration` to be null even when the input chunk had it set,
  /// and a previous version of this search used `duration ||
  /// POSITIVE_INFINITY` as the upper-bound predicate — which made
  /// the binary search land on whichever mid happened to satisfy
  /// `ptsUs <= tUs` first, not the latest such entry. With 33 frames
  /// in the ring, asking for frame 9 deterministically returned
  /// frame 7. The "stuck on frame N" symptom.
  frameAt(tUs: number): ImageBitmap | null {
    if (this.entries.length === 0) return null;
    const firstPts = this.entries[0]!.ptsUs;
    if (tUs < firstPts) {
      // Clamp to first only when the gap is small (CTS / edit-list
      // offset); otherwise the painter should hold its previous
      // frame rather than flash a wrong-region frame.
      if (firstPts - tUs > CLAMP_TO_FIRST_GAP_US) return null;
      return this.entries[0]!.bitmap;
    }
    const idx = this.findLatestAtOrBefore(tUs);
    return idx === -1 ? null : this.entries[idx]!.bitmap;
  }

  /// Drop everything. Use on seek beyond the lookahead window.
  flush(): void {
    for (const e of this.entries) e.bitmap.close();
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

  /// True if some entry's presentation interval contains `tUs`.
  /// Unlike `frameAt`, does NOT clamp out-of-range timestamps — it
  /// reports literal coverage. Used by the decoder to decide whether
  /// a backward seek requires a reset (target not cached) or can
  /// rely on existing decoded frames.
  ///
  /// Effective duration: the next entry's PTS bounds this entry's
  /// interval when one exists; otherwise we fall back to the
  /// recorded `durationUs`. This avoids depending on
  /// `VideoFrame.duration` (which WebCodecs allows to be null).
  containsPts(tUs: number): boolean {
    if (this.entries.length === 0) return false;
    const idx = this.findLatestAtOrBefore(tUs);
    if (idx === -1) return false;
    const e = this.entries[idx]!;
    if (e.ptsUs > tUs) return false;
    const next = this.entries[idx + 1];
    const end = next
      ? next.ptsUs
      : e.durationUs > 0
        ? e.ptsUs + e.durationUs
        : e.ptsUs + 1;
    return tUs < end;
  }

  /// Index of the latest entry with `ptsUs <= tUs`, or 0 if `tUs`
  /// is before every entry (preserving frameAt's clamp-to-first
  /// behavior), or -1 if the ring is empty. The search is duration-
  /// independent.
  private findLatestAtOrBefore(tUs: number): number {
    if (this.entries.length === 0) return -1;
    if (tUs < this.entries[0]!.ptsUs) return 0;
    let lo = 0;
    let hi = this.entries.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.entries[mid]!.ptsUs <= tUs) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  dispose(): void {
    this.flush();
  }
}
