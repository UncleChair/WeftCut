// Lookahead/lookbehind frame ring for one source — the preview-side
// FrameStore. Holds decoded frames from either preview lane:
// `ImageBitmap`s (WebCodecs snapshots, native GPU lane) or CPU-plane frames
// from the native SW transport — `NativeNv12Frame`s, plus `TenBitFrame`s for
// a 10-bit videotoolbox-lane session — converted later in the Compositor's
// ingest passes (see nv12Frame.ts / tenBitFrame.ts); the ring treats every
// kind alike through the shared `close()`. Anchor / eviction / lookup
// semantics live on the methods below.
//
// See docs/render.md §Decoder pool.

import {
  frameRingByteBudget,
  registerFrameRing,
  unregisterFrameRing,
} from "./frameRingBudget";
import { isNativeNv12Frame } from "./nv12Frame";
import { isTenBitFrame } from "./tenBitFrame";
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
  /// Whether `selectFrame` ever returned this entry. Read on removal to
  /// separate "held long enough to be painted" from "decoded and thrown away".
  served: boolean;
}

export interface FrameRingInit {
  lookaheadUs?: number;
  lookbehindUs?: number;
}

/// Where every decoded frame this ring was offered actually WENT, and how every
/// selection resolved. Cumulative since construction; unaffected by eviction or
/// flush (a counter that reset on flush could not measure churn).
///
/// Why counters and not just `size()`: `decodeFps` is a `pushCount` diff, so it
/// reads identically whether frames are pushed and painted or pushed and
/// discarded. The measured failure this exists to explain is a ring reading
/// EMPTY while its decoder reports full-rate delivery (docs/playback-perf.md),
/// and telling those apart needs to know a frame's fate, not the ring's depth.
///
/// Conservation identity, useful as a self-check when reading a report:
///   `pushed === size() + evicted + flushed`
/// and separately `offered === pushed + staleDropped`. If the first does not
/// hold, a frame left the ring by a path that is not accounted for here.
export interface FrameRingFate {
  /// Frames accepted into the ring. Same value as `pushCount`.
  pushed: number;
  /// Frames REJECTED by `push` because they arrived already behind
  /// `anchor - lookbehind`. Decode produced them and the ring never held them,
  /// so a decoder can report full-rate delivery while this climbs and the ring
  /// stays empty. That is the exact signature of a re-seek churn loop: on a
  /// long-GOP source, serving the playhead re-decodes the whole GOP prefix, and
  /// every prefix frame older than the window lands here.
  staleDropped: number;
  /// Frames removed by `setAnchor`'s lookbehind time window.
  evicted: number;
  /// Of `evicted`, those `selectFrame` never returned — decoded, retained, and
  /// discarded without ever reaching the compositor. Work paid for and wasted.
  evictedUnserved: number;
  /// `flush()` calls. Each is a seek or an adaptive resync; a rising count
  /// during steady playback IS the churn, whatever the frame numbers say.
  flushes: number;
  /// Frames destroyed by `flush()`, and of those the ones never served.
  flushed: number;
  flushedUnserved: number;
  /// `selectFrame` returned an entry found by the binary search.
  serveHit: number;
  /// `selectFrame` clamped to the first entry (a CTS / edit-list offset within
  /// `CLAMP_TO_FIRST_GAP_US`). A hit, counted apart because a steady stream of
  /// clamps means the ring is persistently starting later than asked.
  serveClamp: number;
  /// `selectFrame` returned the SAME PTS as the previous call — the compositor
  /// painted a HELD frame. This is the judder the dropped-frame indicator is
  /// blind to: `judgeFrameSelection` only asks whether the bound frame is stale,
  /// so a repeated frame reads as a successful selection.
  serveRepeat: number;
  /// `selectFrame` found nothing because the ring was empty.
  serveMissEmpty: number;
  /// `selectFrame` found nothing because every entry sat further ahead than
  /// `CLAMP_TO_FIRST_GAP_US` — the `strandedAheadOf` shape, a backward seek the
  /// window cannot serve.
  serveMissGap: number;
}

export class FrameRing {
  private entries: RingEntry[] = [];
  private anchorUs = 0;
  private lookaheadUs: number;
  private lookbehindUs: number;
  private _pushCount = 0;
  private _retainedBytes = 0;
  private disposed = false;
  /// See `FrameRingFate`. Counted in one object so a snapshot is one spread.
  private _fate: FrameRingFate = {
    pushed: 0,
    staleDropped: 0,
    evicted: 0,
    evictedUnserved: 0,
    flushes: 0,
    flushed: 0,
    flushedUnserved: 0,
    serveHit: 0,
    serveClamp: 0,
    serveRepeat: 0,
    serveMissEmpty: 0,
    serveMissGap: 0,
  };
  /// PTS of the entry `selectFrame` last returned, for `serveRepeat`. A PTS and
  /// not the entry reference on purpose: holding the reference would keep one
  /// evicted entry (and its closed frame) alive past its eviction.
  private lastServedPtsUs: number | null = null;

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
    // CPU-plane kinds carry their exact byte cost (NV12 = 1.5 B/px, I420P10 =
    // 3 B/px — the honest figure the p10 lane's doubled bandwidth must show up
    // as); an ImageBitmap is GPU-backed RGBA, estimated w×h×4.
    return isNativeNv12Frame(frame) || isTenBitFrame(frame)
      ? frame.data.byteLength
      : frame.width * frame.height * 4;
  }

  /// Where every frame went — see `FrameRingFate`. A copy, so a caller holding
  /// a snapshot across ticks reads a fixed sample rather than a live object.
  get fate(): FrameRingFate {
    return { ...this._fate };
  }

  /// Drop the oldest entry, keeping the byte tally in step.
  private evictFirst(): void {
    const first = this.entries.shift();
    if (!first) return;
    this._retainedBytes -= FrameRing.bytesOf(first.frame);
    this._fate.evicted += 1;
    if (!first.served) this._fate.evictedUnserved += 1;
    first.frame.close();
  }

  /// Count of entries at or after the anchor. `entries` also holds lookbehind,
  /// so this — not `entries.length` — is what a lookahead floor must compare.
  private framesAhead(): number {
    if (this.entries.length === 0) return 0;
    if (this.entries[0]!.ptsUs >= this.anchorUs) return this.entries.length;
    const idx = this.findLatestAtOrBefore(this.anchorUs);
    // "At or after": an entry sitting exactly ON the anchor is ahead-inclusive,
    // and the binary search classes it as at-or-before — without the correction
    // the MIN_LOOKAHEAD_FRAMES floor is 10 or 11 depending on grid alignment.
    const atAnchor = this.entries[idx]!.ptsUs === this.anchorUs ? 1 : 0;
    return this.entries.length - 1 - idx + atAnchor;
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
    // If this frame is already behind the lookbehind window, drop it. COUNTED:
    // this is decode output the ring refuses, and it is invisible in
    // `pushCount` (deliberately — that is a throughput measure of frames the
    // ring accepted) and in the producers' own `decodedFrameCount`, which both
    // engines increment before calling here.
    if (ptsUs + durationUs < this.anchorUs - this.lookbehindUs) {
      this._fate.staleDropped += 1;
      frame.close();
      return;
    }
    this._pushCount += 1;
    this._fate.pushed += 1;
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
    this.entries.push({ ptsUs, durationUs, frame, served: false });
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
  ///
  /// This is also the ONLY lookup that counts towards `fate`, and the only one
  /// that marks an entry served. `frameAt` and `containsPts` are readiness
  /// probes — the Compositor's swap path polls `frameAt` per tick
  /// (`Compositor.pollSwap`) — so counting them would inflate hits with
  /// selections nothing ever painted, and would mark entries served that never
  /// reached a sprite. "Served" here means exactly "handed to the compositor's
  /// paint path".
  selectFrame(tUs: number): { frame: TransportFrame; ptsUs: number; durationUs: number } | null {
    const { entry, how } = this.lookup(tUs);
    if (!entry) {
      if (how === "empty") this._fate.serveMissEmpty += 1;
      else this._fate.serveMissGap += 1;
      return null;
    }
    if (how === "clamp") this._fate.serveClamp += 1;
    else this._fate.serveHit += 1;
    if (this.lastServedPtsUs === entry.ptsUs) this._fate.serveRepeat += 1;
    this.lastServedPtsUs = entry.ptsUs;
    entry.served = true;
    return {
      frame: entry.frame,
      ptsUs: entry.ptsUs,
      durationUs: entry.durationUs,
    };
  }

  private entryAt(tUs: number): RingEntry | null {
    return this.lookup(tUs).entry;
  }

  /// The single selection implementation, plus WHY it resolved that way so
  /// `selectFrame` can attribute a miss without re-deriving the conditions.
  private lookup(tUs: number): {
    entry: RingEntry | null;
    how: "hit" | "clamp" | "empty" | "gap";
  } {
    if (this.entries.length === 0) return { entry: null, how: "empty" };
    const firstPts = this.entries[0]!.ptsUs;
    if (tUs < firstPts) {
      // Clamp to first only when the gap is small (CTS / edit-list
      // offset); otherwise the painter should hold its previous
      // frame rather than flash a wrong-region frame.
      if (firstPts - tUs > CLAMP_TO_FIRST_GAP_US) return { entry: null, how: "gap" };
      return { entry: this.entries[0]!, how: "clamp" };
    }
    const idx = this.findLatestAtOrBefore(tUs);
    if (idx === -1) return { entry: null, how: "empty" };
    return { entry: this.entries[idx]!, how: "hit" };
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
    this._fate.flushes += 1;
    for (const e of this.entries) {
      this._fate.flushed += 1;
      if (!e.served) this._fate.flushedUnserved += 1;
      e.frame.close();
    }
    this.entries = [];
    this._retainedBytes = 0;
    // A flushed ring can re-push the same PTS, and the compositor painting it
    // again is a genuine new selection rather than a held frame.
    this.lastServedPtsUs = null;
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
