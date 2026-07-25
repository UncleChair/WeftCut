// Lookahead/lookbehind frame ring for one source — the preview-side
// FrameStore. Holds decoded frames from either preview lane:
// `ImageBitmap`s (WebCodecs snapshots, native GPU lane) or
// `NativeNv12Frame`s (native SW lane's CPU planes, converted later in the
// Compositor's `Nv12Ingest` — see nv12Frame.ts); the ring treats both
// alike through their shared `close()`. Anchor / eviction / lookup
// semantics live on the methods below.
//
// Plan: docs/render.md §Decoder pool — 1 s lookahead / 0.5 s lookbehind per clip

import {
  frameRingByteBudget,
  registerFrameRing,
  unregisterFrameRing,
} from "./frameRingBudget";
import { isNativeNv12Frame } from "./nv12Frame";
import type { TransportFrame } from "./transports/DecodeTransport";

const DEFAULT_LOOKAHEAD_US = 1_000_000;
const DEFAULT_LOOKBEHIND_US = 500_000;

/// Frames ahead of the anchor the byte budget may NEVER pause the pump below.
/// The window is what degrades under memory pressure, but not to the point of
/// thrash: `PlaybackEngine`'s warm-up gate needs ~150 ms of ring past the play
/// position before it releases the clock, which is 10 frames at 60 fps content.
/// This floor OVERRIDES the budget — see frameRingBudget.ts.
const MIN_LOOKAHEAD_FRAMES = 10;

/// LANDMINE: lookbehind is evicted by its TIME window only — the byte budget
/// deliberately does not trim it. An earlier version did, to reclaim the ~0.5 GB
/// a 4K lookbehind holds, and it measurably backfired: the shallower ring got
/// its trimmed frames re-requested, and on a long-GOP source a single re-seek
/// re-decodes the whole GOP prefix. Decode throughput rose 40 % and drops went
/// 7.2 % → 55.5 %. Byte pressure is expressed on the FORWARD fill only
/// (`isLookaheadFull`), where pausing costs nothing already decoded.

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
  frame: TransportFrame;
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
  private _pushCount = 0;
  private _retainedBytes = 0;
  private disposed = false;

  constructor(init: FrameRingInit = {}) {
    this.lookaheadUs = init.lookaheadUs ?? DEFAULT_LOOKAHEAD_US;
    this.lookbehindUs = init.lookbehindUs ?? DEFAULT_LOOKBEHIND_US;
    registerFrameRing();
  }

  /// Decoded-frame bytes this ring is holding. An `ImageBitmap` is GPU-backed
  /// RGBA, so its cost is not `byteLength` of anything reachable from JS —
  /// width × height × 4 is the honest figure.
  get retainedBytes(): number {
    return this._retainedBytes;
  }

  private static bytesOf(frame: TransportFrame): number {
    return isNativeNv12Frame(frame)
      ? frame.data.byteLength
      : frame.width * frame.height * 4;
  }

  /// Drop the oldest entry, keeping the byte tally in step.
  private evictFirst(): void {
    const first = this.entries.shift();
    if (!first) return;
    this._retainedBytes -= FrameRing.bytesOf(first.frame);
    first.frame.close();
  }

  /// Count of entries at or after the anchor. `entries` also holds lookbehind,
  /// so this — not `entries.length` — is what a lookahead floor must compare.
  private framesAhead(): number {
    if (this.entries.length === 0) return 0;
    if (this.entries[0]!.ptsUs >= this.anchorUs) return this.entries.length;
    return this.entries.length - 1 - this.findLatestAtOrBefore(this.anchorUs);
  }

  /// Monotonic count of frames accepted into the ring since construction.
  /// Drops (behind the lookbehind window) don't count; eviction and flush
  /// don't reset it. The decode-bench throughput scenario diffs this.
  get pushCount(): number {
    return this._pushCount;
  }

  /// Set the current play / scrub position. Evicts anything older
  /// than `anchorUs - lookbehindUs`.
  setAnchor(tUs: number): void {
    this.anchorUs = tUs;
    const minKeepUs = tUs - this.lookbehindUs;
    while (this.entries.length > 0) {
      const first = this.entries[0]!;
      if (first.ptsUs + first.durationUs <= minKeepUs) {
        this.evictFirst();
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

  /// True if the decode pump should pause — the lookahead is full, EITHER in
  /// time or in retained bytes.
  ///
  /// The byte arm is the backpressure that keeps a 4K timeline from pinning
  /// gigabytes of GPU-backed bitmaps: pausing here stops the decode *before*
  /// the bytes are allocated, rather than decoding and then evicting. It is
  /// floored on frames AHEAD of the anchor so the pump can never be starved
  /// into thrash and the warm-up gate still clears.
  isLookaheadFull(): boolean {
    const last = this.entries[this.entries.length - 1];
    if (!last) return false;
    if (last.ptsUs >= this.anchorUs + this.lookaheadUs) return true;
    if (this._retainedBytes < frameRingByteBudget()) return false;
    return this.framesAhead() >= MIN_LOOKAHEAD_FRAMES;
  }

  /// Push a decoded frame. Caller transfers ownership; we close the frame on
  /// eviction. `ptsUs` and `durationUs` come from the source
  /// `VideoFrame.timestamp` / `.duration` (saved before the source frame was
  /// closed, since `ImageBitmap` itself carries no PTS metadata).
  push(frame: TransportFrame, ptsUs: number, durationUs: number): void {
    // If this frame is already behind the lookbehind window, drop it.
    if (ptsUs + durationUs < this.anchorUs - this.lookbehindUs) {
      frame.close();
      return;
    }
    this._pushCount += 1;
    this._retainedBytes += FrameRing.bytesOf(frame);
    // Fast path: append in order. The proxy disables B-frames
    // (`-bf 0`, see proxy.rs) so the decoder emits frames in PTS
    // order; the async `createImageBitmap` step is sequenced via
    // microtasks per output, so consecutive resolves preserve order
    // in practice too. When the new entry's PTS is >= the current
    // tail, the array stays sorted by construction and we skip the
    // O(n log n) sort entirely. Only out-of-order arrivals (B-frame
    // sources, async-bitmap races on closely-spaced frames) hit the
    // safety-net sort.
    const prevLast = this.entries[this.entries.length - 1];
    this.entries.push({ ptsUs, durationUs, frame });
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
  /// Implementation: locate the latest entry whose PTS is `<= tUs`, WITHOUT
  /// relying on `VideoFrame.duration` — WebCodecs may report it null even when
  /// the input chunk set it, and a duration-based upper bound mis-selects
  /// (lands on an earlier entry, not the latest `ptsUs <= tUs`).
  frameAt(tUs: number): TransportFrame | null {
    return this.entryAt(tUs)?.frame ?? null;
  }

  /// Same selection rule as `frameAt`, plus the presentation identity retained
  /// by the ring. ImageBitmap carries no timing metadata of its own, so callers
  /// that need to prove what was painted must read it here atomically.
  selectFrame(tUs: number): { frame: TransportFrame; ptsUs: number; durationUs: number } | null {
    const selected = this.entryAt(tUs);
    if (!selected) return null;
    return {
      frame: selected.frame,
      ptsUs: selected.ptsUs,
      durationUs: selected.durationUs,
    };
  }

  private entryAt(tUs: number): RingEntry | null {
    if (this.entries.length === 0) return null;
    const firstPts = this.entries[0]!.ptsUs;
    if (tUs < firstPts) {
      // Clamp to first only when the gap is small (CTS / edit-list
      // offset); otherwise the painter should hold its previous
      // frame rather than flash a wrong-region frame.
      if (firstPts - tUs > CLAMP_TO_FIRST_GAP_US) return null;
      return this.entries[0]!;
    }
    const idx = this.findLatestAtOrBefore(tUs);
    return idx === -1 ? null : this.entries[idx]!;
  }

  /// True when the ring holds frames but NONE of them can ever serve `tUs`,
  /// because they all sit too far in the FUTURE. This is the backward-seek case
  /// `setAnchor` structurally cannot fix: it evicts from the FRONT only (older
  /// than `anchor - lookbehind`), so a jump back past everything cached leaves
  /// the whole ring in place, `frameAt` returning null forever (the gap exceeds
  /// `CLAMP_TO_FIRST_GAP_US`), and the painter pinned to a wrong-region frame.
  /// The caller's remedy is `flush()`. Same threshold as `entryAt`'s clamp, so
  /// this is exactly "the clamp can't rescue this target".
  strandedAheadOf(tUs: number): boolean {
    const first = this.entries[0];
    return first !== undefined && first.ptsUs - tUs > CLAMP_TO_FIRST_GAP_US;
  }

  /// Drop everything. Use on seek beyond the lookahead window.
  flush(): void {
    for (const e of this.entries) e.frame.close();
    this.entries = [];
    this._retainedBytes = 0;
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

  /// Idempotent: a second call must not unregister twice, or every OTHER live
  /// ring silently gets a smaller share of the byte budget.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.flush();
    unregisterFrameRing();
  }
}
