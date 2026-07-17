// Export-only decoder pool. Drops every preview-tuned mechanism the
// SourceDecoderPool needs (lookahead window, per-frame setAnchor, polling-
// based catch-up) in favor of two batched primitives: `decodeRange(aUs, bUs)`
// (seek-and-forward dispatch; NO `decoder.flush()` between ranges — the
// deadlock landmine lives on the method) and `evictBefore(cutoffUs)`
// (bounded memory after each encoded chunk).
//
// The store + handle expose `frameAt` / `containsPts` / `ensureReady`
// / `requestFrameAt` (no-op) / `onFirstFrame` (no-op) so the Compositor
// can plug this in as a drop-in replacement for `SourceDecoderPool`.

import type { EncodedPacket } from "mediabunny";
import type { DecoderPool, ExportDecodeSession, FrameStore, SourceHandleInit } from "./session";
import { NativeExportSourceHandle } from "../worker/nativeExportSource";
import { withDefaultColorSpace } from "./colorSpaceDefault";
import { handleDecodeError } from "./decoderFallback";
import { openMediaInput, type OpenedMedia } from "./mediaInput";
import type { NativeNv12Frame } from "./nv12Frame";
import { copyToTenBit, isTenBitDecoderFormat, isTenBitFrame, type TenBitFrame } from "./tenBitFrame";
import { frameToSourceUs, packetToSourceUs, sourceToContainerUs } from "./ptsOffset";

/// SW 10-bit decoders hold a reorder tail internally and the chunked model
/// never mid-flushes, so feed a bounded lead-in past the stop key to push the
/// tail out; H.264's max DPB is 16.
const TENBIT_REORDER_MARGIN = 16;

/// 10-bit ring cap, derived from coded frame size: a byte target / frame bytes,
/// clamped to [MIN, MAX]. The MIN floor is the deadlock guard — output is
/// presentation-ordered, so an unsatisfied waiter implies everything held is
/// evictable, but the floor keeps headroom over the DPB-16 reorder window.
/// No cross-ring budget: N simultaneous 10-bit sources stack N× this bound.
const TENBIT_RING_TARGET_BYTES = 320 << 20;
const TENBIT_RING_MIN_ENTRIES = 20;
const TENBIT_RING_MAX_ENTRIES = 48;

/// Entry high-water for a ring whose frames are `frameBytes` each. Exported
/// for unit tests; pure.
export function tenBitHighWaterFor(frameBytes: number): number {
  return Math.min(
    TENBIT_RING_MAX_ENTRIES,
    Math.max(TENBIT_RING_MIN_ENTRIES, Math.floor(TENBIT_RING_TARGET_BYTES / frameBytes)),
  );
}

interface RingEntry {
  ptsUs: number;
  durationUs: number;
  frame: VideoFrame | TenBitFrame | NativeNv12Frame;
}

/// E2E color diagnostic captured off the FIRST decoded frame of a handle.
/// Surfaced through the export `done` perf message (`window.__weftcutExportPerf`)
/// so a test can see, without Worker console access, what colorSpace we asked
/// the decoder for vs what the decoder actually stamped on its output frames —
/// the crux of whether Chromium/Electron's VideoDecoder propagates config.colorSpace.
export interface ExportColorDiag {
  mediaId: string;
  /// `config.colorSpace` handed to `decoder.configure` (post-withDefaultColorSpace).
  configColor: VideoColorSpaceInit | null;
  /// `frame.colorSpace` the decoder stamped on its output (the real tag the
  /// downstream YUV→RGB conversion honors).
  frameColor: VideoColorSpaceInit | null;
  /// `frame.format` (NV12 / I420 / RGBA / …) — RGBA would mean the conversion
  /// already happened in the decoder.
  frameFormat: string | null;
}

export class ExportFrameStore implements FrameStore {
  private entries: RingEntry[] = [];
  /// EOS drain lifecycle. `draining`: the end-of-stream flush was ISSUED —
  /// frames may still arrive, but eviction pins the last held entry so a late
  /// finalization always has a clamp target. `ended`: the flush COMPLETED — no
  /// frame will ever arrive again; `isReadyFor` clamps any target while a
  /// frame is held.
  private draining = false;
  private ended = false;
  /// Pending `waitForPts` resolvers. On every `push` we resolve and
  /// remove the ones whose tUs is now covered. The Worker uses this
  /// to await each source frame before composing the next output
  /// frame — keeps the WebCodecs decoder pool from piling up
  /// unconsumed frames (pool exhaustion at ~8 outstanding frames
  /// was the export-stuck wedge).
  private waiters: Array<{ tUs: number; resolve: () => void; reject: (e: Error) => void }> = [];
  /// Pending resolvers parked at the 10-bit high-water gate (I2 backpressure).
  private gateWaiters: Array<() => void> = [];
  /// Non-null once `fail()` is called; subsequent waitForPts calls reject.
  private failure: string | null = null;
  /// Resolution-derived entry cap for the 10-bit gate. Starts at the ceiling
  /// (plain VideoFrame rings never derive) and is set ONCE from the first
  /// TenBitFrame's actual plane bytes — exact, no estimate, and constant for
  /// the ring's lifetime (one source = one coded size). Public read for
  /// tests/diagnostics.
  private derivedTenBitHighWater: number | null = null;

  get tenBitHighWater(): number {
    return this.derivedTenBitHighWater ?? TENBIT_RING_MAX_ENTRIES;
  }

  push(frame: VideoFrame | TenBitFrame | NativeNv12Frame, ptsUs = frame.timestamp): void {
    if (this.derivedTenBitHighWater === null && isTenBitFrame(frame)) {
      this.derivedTenBitHighWater = tenBitHighWaterFor(frame.data.byteLength);
    }
    this.entries.push({
      ptsUs,
      durationUs: frame.duration ?? 0,
      frame,
    });
    // Decoder output for a single GOP is usually monotonic, but B-frame
    // streams can reorder. Sort defensively — cost is negligible for
    // chunk-sized stores (~60 entries).
    this.entries.sort((a, b) => a.ptsUs - b.ptsUs);
    if (this.waiters.length > 0) {
      const stillWaiting: typeof this.waiters = [];
      for (const w of this.waiters) {
        if (this.isReadyFor(w.tUs)) {
          w.resolve();
        } else {
          stillWaiting.push(w);
        }
      }
      this.waiters = stillWaiting;
    }
    this.freeBehindWaiters();
  }

  /// Free WebCodecs VideoFrame-pool slots while a consumer is PARKED: drop
  /// frames strictly below the lowest still-pending waiter's target, keeping
  /// the immediate lower neighbour (the frame `frameAt` / `isReadyFor` may
  /// still need to satisfy that waiter under PTS-grid drift — see `isReadyFor`).
  ///
  /// Without this, a long re-decode from a GOP key (e.g. a long-GOP DirectExport
  /// source: x264 default keyint=250) piles decoded-but-unconsumed frames into
  /// the ring while the export's encode loop is awaiting a far-ahead frame. The
  /// decoder's hardware pool (~13 slots) exhausts, the decoder stalls, and the
  /// per-frame `evictBefore` that would free the pool only runs AFTER the await
  /// resolves → circular wait → permanent deadlock (observed: export frozen at
  /// frame 250, the 2nd GOP key). Freeing on `push` breaks the cycle: the
  /// producer can always make forward progress toward the awaited frame.
  private freeBehindWaiters(): void {
    if (this.waiters.length === 0 || this.entries.length === 0) return;
    let minTus = Number.POSITIVE_INFINITY;
    for (const w of this.waiters) if (w.tUs < minTus) minTus = w.tUs;
    // Highest entry index whose pts is at/below the lowest waiter — the
    // immediate lower neighbour. Keep it + everything above; drop below it.
    let keepFrom = 0;
    for (let i = 0; i < this.entries.length; i++) {
      if (this.entries[i]!.ptsUs <= minTus) keepFrom = i;
      else break;
    }
    if (keepFrom > 0) {
      for (let i = 0; i < keepFrom; i++) this.entries[i]!.frame.close();
      this.entries.splice(0, keepFrom);
      this.notifyShrink();
    }
  }

  /// Await a frame whose presentation interval contains `tUs`. If
  /// already in the store, resolves synchronously; otherwise
  /// resolves the next time `push()` delivers a covering frame.
  /// Producer→consumer sync point for the export Worker.
  waitForPts(tUs: number): Promise<void> {
    if (this.failure) return Promise.reject(new Error(this.failure));
    if (this.isReadyFor(tUs)) return Promise.resolve();
    const p = new Promise<void>((resolve, reject) => {
      this.waiters.push({ tUs, resolve, reject });
    });
    // KICK a possibly-stalled decoder: free pool slots behind this newly-parked
    // waiter NOW. Frames can pile up during a chunk's `decodeRange` dispatch
    // (before any waiter exists), filling the WebCodecs pool so the decoder
    // stalls and stops firing `push` — at which point `push`-side freeing can
    // never run. Freeing here, when the consumer parks, gives the stalled
    // decoder slots to resume toward the awaited frame.
    this.freeBehindWaiters();
    return p;
  }

  /// The end-of-stream `decoder.flush()` was issued. From now on `evictBefore`
  /// keeps the last held entry: the consumer's per-frame cutoff can overrun the
  /// final frame's interval (composition grid extending past the video track),
  /// and an emptied ring would leave `finishEosDrain` nothing to clamp to.
  beginEosDrain(): void {
    this.draining = true;
  }

  /// The end-of-stream flush completed: every frame the source will ever
  /// produce has been pushed. Remaining wait targets are final — resolve them
  /// (and all future ones) by clamping to the nearest held frame. Must NOT be
  /// called while the drain is still emitting: clamping early hands a stale
  /// frame to a waiter whose real frame is still on its way (silent dup-frame
  /// corruption across the export tail).
  finishEosDrain(): void {
    this.draining = true;
    this.ended = true;
    if (this.waiters.length === 0) return;
    const stillWaiting: typeof this.waiters = [];
    for (const w of this.waiters) {
      if (this.isReadyFor(w.tUs)) {
        w.resolve();
      } else {
        stillWaiting.push(w);
      }
    }
    this.waiters = stillWaiting;
  }

  /// A re-seek (backward clip-reuse jump / decoder rebuild) makes new frames
  /// possible again — finalized clamping and tail-pinning must deactivate.
  clearEosDrain(): void {
    this.draining = false;
    this.ended = false;
  }

  /// Readiness gate for `waitForPts`. The source frame to display at `tUs`
  /// is FINAL — and `frameAt(tUs)` will return it, clamping to the nearest
  /// held frame — once either its interval is held, or a frame with a
  /// strictly later PTS has been decoded. Decoder output is PTS-ordered, so
  /// once any frame past `tUs` exists, no future frame can be a better match.
  ///
  /// Gating on strict interval containment alone WEDGES the export: the
  /// decoder's PTS grid (e.g. 0, 33333, 66666, 100000 … — irregular 33333/
  /// 33334 steps) drifts off the integer `i × frameDurUs` output grid (0,
  /// 33333, 66666, 99999 …). At a drift point the target (99999) lands in a
  /// 1µs gap between two frames' [pts, pts+dur) intervals, and `evictBefore`
  /// has already dropped the lower neighbour — so `containsPts` is false even
  /// though later frames are present, and the wait never resolves.
  private isReadyFor(tUs: number): boolean {
    if (this.containsPts(tUs)) return true;
    const last = this.lastPtsUs();
    if (last !== null && last > tUs) return true;
    // Source fully drained: no better frame can arrive — clamp to what's held.
    return this.ended && this.entries.length > 0;
  }

  frameAt(tUs: number): VideoFrame | TenBitFrame | NativeNv12Frame | null { // satisfies DecodedFrame | null
    if (this.entries.length === 0) return null;
    const first = this.entries[0]!;
    if (tUs < first.ptsUs) return first.frame;
    const last = this.entries[this.entries.length - 1]!;
    if (tUs >= last.ptsUs + (last.durationUs || 0)) return last.frame;
    let lo = 0;
    let hi = this.entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = this.entries[mid]!;
      const end = e.ptsUs + (e.durationUs || Number.POSITIVE_INFINITY);
      if (e.ptsUs <= tUs && tUs < end) return e.frame;
      if (e.ptsUs > tUs) hi = mid - 1;
      else lo = mid + 1;
    }
    return this.entries[hi]?.frame ?? this.entries[0]!.frame;
  }

  lastPtsUs(): number | null {
    return this.entries[this.entries.length - 1]?.ptsUs ?? null;
  }

  firstPtsUs(): number | null {
    return this.entries[0]?.ptsUs ?? null;
  }

  containsPts(tUs: number): boolean {
    if (this.entries.length === 0) return false;
    let lo = 0;
    let hi = this.entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = this.entries[mid]!;
      const end = e.ptsUs + (e.durationUs || 0);
      if (e.ptsUs <= tUs && tUs < end) return true;
      if (e.ptsUs > tUs) hi = mid - 1;
      else lo = mid + 1;
    }
    return false;
  }

  evictBefore(cutoffUs: number): void {
    // During/after the EOS drain the last entry is pinned as the clamp target
    // for grid-overhang waits (see `beginEosDrain`).
    const stop = this.draining ? Math.max(0, this.entries.length - 1) : this.entries.length;
    let n = 0;
    while (n < stop) {
      const e = this.entries[n]!;
      if (e.ptsUs + (e.durationUs || 0) <= cutoffUs) {
        e.frame.close();
        n++;
      } else {
        break;
      }
    }
    if (n > 0) {
      this.entries.splice(0, n);
      this.notifyShrink();
    }
  }

  flush(): void {
    for (const e of this.entries) e.frame.close();
    this.entries = [];
    this.draining = false;
    this.ended = false;
    // Any caller still awaiting waitForPts is now in a state where
    // their wait will never resolve naturally. Don't resolve them —
    // that would mislead the caller into thinking a frame is
    // present. Caller is expected to bail out via the dispose path.
    this.waiters = [];
    this.notifyShrink();
  }

  /// Backpressure gate for the 10-bit copy chain (I2). Resolves immediately
  /// when the ring is below the high-water mark OR the ring has failed (so
  /// chain links drain and the failure surfaces at `waitForPts`).
  waitBelowTenBitHighWater(): Promise<void> {
    if (this.entries.length < this.tenBitHighWater || this.failure !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.gateWaiters.push(resolve);
    });
  }

  /// Resolve all gateWaiters if the ring has shrunk below the high-water mark.
  /// Called whenever entries are removed (evictBefore, freeBehindWaiters, flush).
  private notifyShrink(): void {
    if (this.gateWaiters.length === 0) return;
    if (this.entries.length < this.tenBitHighWater) {
      const waiters = this.gateWaiters.splice(0);
      for (const r of waiters) r();
    }
  }

  /// Mark the ring as failed and reject all pending waiters + gate-waiters.
  /// Future `waitForPts` calls will reject immediately. Gate-waiters are
  /// resolved (not rejected) so copy-chain links drain and the failure
  /// surfaces at the next `waitForPts` call.
  fail(reason: string): void {
    if (this.failure) return; // idempotent
    this.failure = reason;
    // Drain gate-waiters so any in-flight copy chain links exit cleanly.
    const gates = this.gateWaiters.splice(0);
    for (const r of gates) r();
    // Reject pending waitForPts waiters.
    const err = new Error(reason);
    const pending = this.waiters.splice(0);
    for (const w of pending) w.reject(err);
  }

  size(): number {
    return this.entries.length;
  }

  dispose(): void {
    this.flush();
  }
}

export class ExportSourceHandle implements ExportDecodeSession {
  readonly mediaId: string;
  private readonly proxyAssetUrl: string;
  /// Source color tags (ffprobe-mapped), for original AND proxy decode
  /// targets (a proxy preserves the source's colorimetry). Threaded into
  /// `withDefaultColorSpace`; the target's own colr tag outranks per-field.
  private readonly sourceColor: VideoColorSpaceInit | undefined;
  private readonly knownStartPtsUs: number | null;
  private sourceStartPtsUs = 0;
  /// Copy >8-bit decoder output to CPU planes (TenBitFrame) instead of
  /// holding VideoFrames. Also activates the reorder-margin extension in
  /// `decodeRange` so SW decoders drain their reorder tail.
  private readonly tenBitLane: boolean;
  /// Pre-configure the decoder as prefer-software. For Hi10P this skips a
  /// doomed HW attempt (no HW path exists); for AV1-10 it is a CORRECTNESS
  /// requirement — the HW decoder succeeds but emits opaque format=null
  /// frames with no copyTo, so the error-fallback never fires.
  private readonly preferSoftware: boolean;
  readonly ring: ExportFrameStore;
  /// E2E-only: colorSpace of the first decoded frame vs the config we passed.
  /// Read by the export worker and forwarded in the `done` perf payload.
  firstFrameDiag: ExportColorDiag | null = null;
  private opened: OpenedMedia | null = null;
  private config: VideoDecoderConfig | null = null;
  private decoder: VideoDecoder | null = null;
  private readyP: Promise<void> | null = null;
  /// Last packet dispatched to the decoder (decode order); null = unpositioned.
  private cursor: EncodedPacket | null = null;
  /// Presentation PTS (µs) of the last dispatched packet. Diagnostic only —
  /// the stop-after-key rule overshoots it to the NEXT GOP's key, so it must
  /// NOT drive the seek-vs-continue decision (see `lastRangeAUs`): treating a
  /// forward range below the overshot key as a backward jump re-feeds the
  /// whole stream prefix behind the consumer, and the decoder's stale
  /// re-emissions then get composited into the output (observed: source
  /// frame 12 at output frame 150 around a 5s-GOP boundary).
  private lastDispatchedPtsUs = Number.NEGATIVE_INFINITY;
  /// `aUs` of the previous `decodeRange`. Ranges are monotonic per handle in
  /// the export's forward march; `aUs < lastRangeAUs` is a true backward jump
  /// (same-media clip reuse) and the only case that re-seeks.
  private lastRangeAUs = Number.NEGATIVE_INFINITY;
  /// Presentation time strictly below which EVERY packet has been dispatched.
  /// Advanced to the stop key's PTS on a key-break exit (the leading-B peek
  /// makes that claim exact even for open-GOP streams) and to +∞ at EOS. A
  /// forward range with `bUs < coveredThroughUs` needs no dispatch at all —
  /// its frames are already in the decoder/ring pipeline.
  private coveredThroughUs = Number.NEGATIVE_INFINITY;
  private outputFrameCount = 0;
  /// Serialized copy chain for the 10-bit lane (C1+C2 fix). Each decoder
  /// output callback appends to this chain so copies land in emit order and
  /// the EOS flush `.then` awaits the chain before calling finishEosDrain.
  private copyChain: Promise<void> = Promise.resolve();
  /// Cumulative packets fed to the decoder across all `decodeRange` calls.
  /// With a 1:1 export this should track the frame count; a large excess means
  /// re-decode waste (the long-GOP re-seek redundancy). Read by the export
  /// worker for the E2E perf diagnostic.
  dispatchedTotal = 0;
  private downgraded = false;
  private _disposed = false;
  /// Source PTS where the EOS drain began — the `aUs` of the range whose
  /// dispatch ran out of packets. Ranges at/after it need no packet dispatch
  /// (everything was already fed; frames arrive via the floated flush); a range
  /// before it is a true backward clip-reuse jump and re-seeks through a
  /// decoder rebuild. null = EOS not reached.
  private eosFrontierUs: number | null = null;

  get disposed(): boolean {
    return this._disposed;
  }

  constructor(init: SourceHandleInit) {
    this.mediaId = init.mediaId;
    this.proxyAssetUrl = init.proxyAssetUrl;
    this.sourceColor = init.sourceColor;
    this.knownStartPtsUs = init.sourceStartPtsUs ?? null;
    this.tenBitLane = init.tenBitLane ?? false;
    this.preferSoftware = init.preferSoftware ?? false;
    this.ring = new ExportFrameStore();
  }

  async ensureReady(): Promise<void> {
    if (this.config && this.decoder) return;
    if (this.readyP) return this.readyP;
    this.readyP = this._doEnsureReady();
    return this.readyP;
  }

  private async _doEnsureReady(): Promise<void> {
    this.opened = await openMediaInput(this.proxyAssetUrl);
    const config = await this.opened.videoTrack.getDecoderConfig();
    if (!config) {
      throw new Error(`[weftcut/export] ${this.mediaId}: no decoder config`);
    }
    // Match preview: offset comes from the decode target's first packet, not
    // import-time metadata (re-encoded proxies start at PTS 0).
    const first = await this.opened.packetSink.getFirstPacket();
    this.sourceStartPtsUs = first
      ? Math.round(first.timestamp * 1e6)
      : (this.knownStartPtsUs ?? 0);
    // Untagged sources get a resolution-keyed default matrix so Chromium/Electron's
    // decode matches the rest of the toolchain (see colorSpaceDefault).
    // `sourceColor` carries the source's ffprobe tags as the middle-priority
    // layer (below the decode target's own mediabunny colr tag, above the
    // resolution default) — for original AND proxy decodes alike (a proxy
    // preserves the source's colorimetry).
    this.config = withDefaultColorSpace(config, this.sourceColor);
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/export] source ${this.mediaId} ready: codec=${config.codec} ` +
        `${config.codedWidth ?? "?"}x${config.codedHeight ?? "?"} ` +
        `startPts=${this.sourceStartPtsUs}us`,
    );
    // Diagnostic: log whether HW decode is actually available in Worker scope
    // (Chrome sometimes silently lands on software; software 1080p ≈ 2 fps).
    if (typeof VideoDecoder.isConfigSupported === "function") {
      for (const hw of ["prefer-hardware", "prefer-software"] as const) {
        try {
          const supported = await VideoDecoder.isConfigSupported({
            ...config,
            hardwareAcceleration: hw,
          });
          // eslint-disable-next-line no-console
          console.log(
            `[weftcut/export] ${this.mediaId} isConfigSupported(${hw})=${supported.supported}`,
          );
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[weftcut/export] isConfigSupported(${hw}) threw:`, e);
        }
      }
    }
    this.decoder = this.buildDecoder();
    this.decoder.configure(this.buildConfig());
  }

  /// Construct a fresh `VideoDecoder` with the identity-guarded output/error
  /// callbacks. Used by initial ready + the rebuild recovery paths.
  private buildDecoder(): VideoDecoder {
    let dec: VideoDecoder;
    dec = new VideoDecoder({
      output: (frame: VideoFrame) => {
        if (this.decoder !== dec) {
          frame.close();
          return;
        }
        this.outputFrameCount += 1;
        if (!this.firstFrameDiag) {
          const cs = frame.colorSpace;
          this.firstFrameDiag = {
            mediaId: this.mediaId,
            configColor: this.config?.colorSpace ?? null,
            frameColor: cs
              ? {
                  matrix: cs.matrix ?? null,
                  primaries: cs.primaries ?? null,
                  transfer: cs.transfer ?? null,
                  fullRange: cs.fullRange ?? null,
                }
              : null,
            frameFormat: frame.format ?? null,
          };
        }
        if (this.outputFrameCount === 1 || this.outputFrameCount % 30 === 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[weftcut/export] ${this.mediaId} output #${this.outputFrameCount}: ` +
              `pts=${frame.timestamp}us`,
          );
        }
        if (this.tenBitLane && isTenBitDecoderFormat(frame.format)) {
          this.copyChain = this.copyChain.then(async () => {
            // Backpressure: while the ring is at high water (resolution-derived,
            // see tenBitHighWaterFor), block the copy chain here. Note: SW
            // decoders don't stall on held frames the way HW decoders do (no
            // pool slots), so this gate bounds the RING entry count, not the
            // decoder. The un-copied frames backlogged in the chain are bounded
            // by the dispatch window (chunk/GOP + TENBIT_REORDER_MARGIN), which
            // for long-GOP 4K sources can be large — see the known-limitation
            // note on TENBIT_RING_TARGET_BYTES.
            await this.ring.waitBelowTenBitHighWater();
            const tb = await copyToTenBit(frame);
            const ptsUs = frameToSourceUs(tb.timestamp, this.sourceStartPtsUs);
            frame.close();
            if (this.decoder !== dec) return;
            this.ring.push(tb, ptsUs);
          }).catch((e: unknown) => {
            try { frame.close(); } catch { /* already closed */ }
            if (this.decoder !== dec) return;
            const msg = `[weftcut/export] ${this.mediaId} 10-bit copyTo failed: ${String(e)}`;
            // eslint-disable-next-line no-console
            console.error(msg);
            // I1: a dropped frame is silent corruption and a parked-forever waiter —
            // fail the ring loudly so the worker's waitForPts rejects the export.
            this.ring.fail(msg);
          });
          return;
        }
        this.ring.push(frame, frameToSourceUs(frame.timestamp, this.sourceStartPtsUs));
      },
      error: (e: unknown) => {
        if (this.decoder !== dec) return;
        const err = e instanceof Error ? e : new Error(String(e));
        // eslint-disable-next-line no-console
        console.error(`[weftcut/export] decoder ${this.mediaId} error:`, err.message);
        const action = handleDecodeError({
          err,
          outputFrameCount: this.outputFrameCount,
          alreadyDowngraded: this.downgraded,
          mediaId: this.mediaId,
          // eslint-disable-next-line no-console
          log: (msg) => console.warn(`[weftcut/export] ${msg}`),
        });
        if (action.kind === "downgrade-to-software") {
          this.downgraded = true;
          this.rebuildDecoder();
        } else if (action.kind === "inactivity-rebuild") {
          this.rebuildDecoder();
        }
      },
    });
    return dec;
  }

  /// Build the decoder config, honoring `downgraded` and `preferSoftware`.
  /// Spreads the full mediabunny config (colorSpace etc.) and overrides only
  /// hwAccel. `preferSoftware` pre-configures SW for codecs known to have no
  /// HW path (e.g. Hi10P), skipping the error-fallback round-trip.
  private buildConfig(): VideoDecoderConfig {
    if (!this.config) {
      throw new Error(`[weftcut/export] ${this.mediaId}: buildConfig before ready`);
    }
    return {
      ...this.config,
      hardwareAcceleration: this.downgraded || this.preferSoftware ? "prefer-software" : "prefer-hardware",
    };
  }

  /// Recovery: WebCodecs closes the codec before firing `error`, so
  /// reset()/configure() on the dead decoder throws — rebuild instead.
  /// Keeps the opened media; resets the cursor so the next decodeRange
  /// re-seeks a key packet into the fresh decoder. `downgraded` + in-store
  /// frames stay.
  private rebuildDecoder(): void {
    try {
      this.decoder?.close();
    } catch {
      // already closed
    }
    this.decoder = this.buildDecoder();
    this.decoder.configure(this.buildConfig());
    this.cursor = null;
    this.lastDispatchedPtsUs = Number.NEGATIVE_INFINITY;
    this.lastRangeAUs = Number.NEGATIVE_INFINITY;
    this.coveredThroughUs = Number.NEGATIVE_INFINITY;
    // The fresh decoder supersedes any in-flight EOS flush on the old one (its
    // .then/.catch are identity-guarded and settle harmlessly), and can produce
    // frames again — reset the EOS frontier and the ring's finalized state.
    this.eosFrontierUs = null;
    this.ring.clearEosDrain();
    // Stale copy-chain links are identity-guarded; reset so new copies from the
    // rebuilt decoder don't chain behind an old settled tail.
    this.copyChain = Promise.resolve();
  }

  /// Compositor's `setAnchorTime` reaches us here; export drives decoding via
  /// `decodeRange`, so this is a no-op.
  requestFrameAt(_tUs: number): Promise<void> {
    return Promise.resolve();
  }

  /// Export composites synchronously; no first-frame repaint needed.
  onFirstFrame(_cb: () => void): void {
    // intentional no-op
  }

  /// Decode every packet needed to cover the presentation range [aUs, bUs].
  /// Async: seeks to the GOP key at/before `aUs` (or continues from the
  /// cursor when the range moves forward of the dispatch frontier), then
  /// dispatches in DECODE order through the first key packet strictly after
  /// `bUs` (inclusive) — so every frame with presentation PTS ≤ bUs, incl.
  /// open-GOP B-frames referencing the next key, is fed. No flush (the
  /// worker awaits each frame via `ring.waitForPts`; flushing would deadlock
  /// against the held VideoFrame pool slots). Awaiting `getNextPacket`
  /// faults in uncached bytes natively — no pre-fault needed.
  async decodeRange(aUs: number, bUs: number): Promise<void> {
    if (!this.config || !this.decoder) await this.ensureReady();
    if (!this.config || !this.decoder) return;
    const packetSink = this.opened?.packetSink;
    if (!packetSink) return;

    // End-of-stream handling. A forward tail range was already fully fed by
    // the range that hit EOS — return immediately so the worker proceeds to
    // `waitForPts`, which frees the pool slots the floated flush needs to keep
    // emitting. Blocking here on the flush deadlocks the export: the final
    // GOP's drain can span multiple chunks, and nothing frees slots until the
    // consumer loop runs (the observed freeze at 12660/12731).
    if (this.eosFrontierUs !== null) {
      if (aUs >= this.eosFrontierUs) return;
      // True backward jump (same-media clip reuse) into a drained/draining
      // decoder. A re-seek must restart from a keyframe anyway, and the
      // in-flight flush may be stalled on pool slots — rebuild instead of
      // awaiting it; the superseded flush settles harmlessly (identity-guarded
      // callbacks).
      // eslint-disable-next-line no-console
      console.log(
        `[weftcut/export] ${this.mediaId} backward range pts=[${aUs}..${bUs}]us ` +
          `across EOS frontier — rebuilding decoder`,
      );
      this.rebuildDecoder();
    }

    // Forward ranges (the export's normal march) continue from the cursor;
    // only a true backward jump (aUs before the previous range — same-media
    // clip reuse) re-seeks. The per-packet frontier `lastDispatchedPtsUs` must
    // NOT drive this: the stop-after-key rule overshoots it to the next GOP's
    // key, and misreading that as "backward" re-feeds the whole stream prefix
    // behind the consumer (stale-frame corruption at GOP boundaries).
    const forward = this.cursor !== null && aUs >= this.lastRangeAUs;
    this.lastRangeAUs = aUs;

    // Fully covered by a prior overshooting dispatch: every packet this range
    // needs is already in the decoder/ring pipeline — feed nothing.
    if (forward && bUs < this.coveredThroughUs) {
      return;
    }

    let pkt: EncodedPacket | null;
    if (forward) {
      pkt = await packetSink.getNextPacket(this.cursor!);
    } else {
      pkt = await packetSink.getKeyPacket(this.toContainerPtsUs(aUs) / 1e6);
      // `getKeyPacket` is null when `aUs` precedes the first key packet — a
      // trimmed / edit-list source whose first frame PTS is past the requested
      // time (e.g. ffmpeg `-ss` clips). Fall back to the track's first packet
      // (always the opening keyframe) so the decode starts from the GOP head
      // instead of feeding from nothing and wedging the export. Mirrors the
      // same fallback in `probeSourceDecodable`.
      if (!pkt) {
        pkt = await packetSink.getFirstPacket();
      }
    }
    if (this._disposed) return;

    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/export] ${this.mediaId} decodeRange pts=[${aUs}..${bUs}]us ` +
        `(start=${pkt ? this.toSourcePtsUs(pkt) : "none"}us, ` +
        `frontier=${this.lastDispatchedPtsUs}us)`,
    );

    let dispatched = 0;
    // PTS of the stop key once dispatched. The loop then keeps feeding ONLY
    // the packets that decode after the key but display before it (open-GOP
    // leading B-frames) so "everything strictly below the key's PTS is fed"
    // becomes an exact invariant — what `coveredThroughUs` claims.
    let stopKeyPtsUs: number | null = null;
    while (pkt) {
      const ptsUs = this.toSourcePtsUs(pkt);
      if (stopKeyPtsUs !== null && ptsUs >= stopKeyPtsUs) break;
      this.decoder.decode(pkt.toEncodedVideoChunk());
      this.cursor = pkt;
      this.lastDispatchedPtsUs = ptsUs;
      dispatched++;
      this.dispatchedTotal++;
      // Mark the first key strictly past bUs — that key begins the GOP after
      // bUs, so everything with PTS ≤ bUs has been fed once its leading
      // B-frames (if any) follow.
      if (stopKeyPtsUs === null && pkt.type === "key" && ptsUs > bUs) {
        stopKeyPtsUs = ptsUs;
      }
      pkt = await packetSink.getNextPacket(pkt);
      if (this._disposed) return;
    }
    if (this.tenBitLane) {
      let extra = 0;
      while (pkt && extra < TENBIT_REORDER_MARGIN) {
        this.decoder.decode(pkt.toEncodedVideoChunk());
        this.cursor = pkt;
        this.lastDispatchedPtsUs = this.toSourcePtsUs(pkt);
        dispatched++;
        this.dispatchedTotal++;
        extra++;
        pkt = await packetSink.getNextPacket(pkt);
        if (this._disposed) return;
      }
    }
    if (stopKeyPtsUs !== null) {
      this.coveredThroughUs = Math.max(this.coveredThroughUs, stopKeyPtsUs);
    }
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/export] ${this.mediaId} decodeRange dispatched ${dispatched} ` +
        `(queue=${this.decoder.decodeQueueSize})`,
    );

    // End-of-stream discriminator: `getNextPacket` returned null (`pkt ===
    // null`), NOT the key-past-bUs `break` (which leaves `pkt` holding that
    // key). Either this range dispatched to exhaustion, or — `dispatched === 0`
    // with a positioned cursor — a PREVIOUS range's stop-after-key break
    // already consumed the stream's final packet and this range found nothing
    // left. Both are true EOS: the final GOP's trailing frames stay parked in
    // the decoder's reorder buffer until an explicit flush (the mid-stream
    // drain mechanism — the next GOP key — can never arrive).
    if (pkt === null && (dispatched > 0 || this.cursor !== null)) {
      this.eosFrontierUs = aUs;
      this.coveredThroughUs = Number.POSITIVE_INFINITY;
      this.issueEosFlush();
    }
  }

  private toContainerPtsUs(sourceUs: number): number {
    return sourceToContainerUs(sourceUs, this.sourceStartPtsUs);
  }

  private toSourcePtsUs(packet: EncodedPacket): number {
    return packetToSourceUs(packet.timestamp, this.sourceStartPtsUs);
  }

  /// Drain the decoder's reorder buffer at true end-of-stream. The chunked
  /// `decodeRange` is otherwise flush-free by design (flushing mid-export would
  /// deadlock against the VideoFrame pool slots the worker holds). But the final
  /// GOP has no "next key" to drain it, so its trailing B-frames never emit —
  /// the export's `waitForPts` for the last output frames hangs forever (the
  /// observed "stuck at the last frame" wedge).
  ///
  /// Crucially we do NOT await the flush here. The worker's encode loop is the
  /// only thing that frees pool slots (`waitForPts` → `freeBehindWaiters`), and
  /// a full pool stalls the decoder mid-flush; awaiting would block that loop →
  /// the exact circular deadlock the "no flush between ranges" rule avoids.
  /// Floating it lets the encode loop run concurrently: it parks on each trailing
  /// frame, frees the pool behind the waiter, the flush makes progress, the
  /// trailing frames emit, and the waiters resolve. A flushed decoder must resume
  /// from a keyframe, so reset the cursor; forward ranges across the tail skip
  /// dispatch entirely (`eosFrontierUs`), and a backward clip-reuse range
  /// re-seeks through a decoder rebuild.
  private issueEosFlush(): void {
    const dec = this.decoder;
    if (!dec) return;
    this.ring.beginEosDrain();
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/export] ${this.mediaId} EOS — flushing decoder reorder buffer ` +
        `(queue=${dec.decodeQueueSize}, ring=${this.ring.size()})`,
    );
    void dec
      .flush()
      .then(() => this.copyChain)
      .then(() => {
        if (this.decoder !== dec) return; // superseded by rebuild/dispose
        // Every frame the source will ever produce is now in the ring (or
        // already consumed) — finalize so grid-overhang tail waits clamp to
        // the last held frame instead of parking forever.
        this.ring.finishEosDrain();
        // eslint-disable-next-line no-console
        console.log(
          `[weftcut/export] ${this.mediaId} EOS flush drained ` +
            `(output #${this.outputFrameCount}, ring=${this.ring.size()})`,
        );
      })
      .catch((e: unknown) => {
        if (this.decoder !== dec) return; // superseded by rebuild/dispose
        // eslint-disable-next-line no-console
        console.warn(`[weftcut/export] ${this.mediaId} EOS flush errored:`, e);
      });
    this.cursor = null;
    this.lastDispatchedPtsUs = Number.NEGATIVE_INFINITY;
  }

  evictBefore(cutoffUs: number): void {
    this.ring.evictBefore(cutoffUs);
  }

  dispose(): void {
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
        // already closed
      }
      this.decoder = null;
    }
    this.ring.dispose();
    this.opened?.dispose();
    this.opened = null;
    this.config = null;
    this.readyP = null;
    this.cursor = null;
    this.lastDispatchedPtsUs = Number.NEGATIVE_INFINITY;
    this.lastRangeAUs = Number.NEGATIVE_INFINITY;
    this.coveredThroughUs = Number.NEGATIVE_INFINITY;
    this.outputFrameCount = 0;
    this.downgraded = false;
    this.eosFrontierUs = null;
    this.copyChain = Promise.resolve();
    this._disposed = true;
  }
}

/// Pool key for an export handle. Clips of one media whose timeline→source
/// offset (`srcInUs - tStartUs`, the "phase") is EQUAL march through source
/// time in lockstep — at any output time they want the SAME source PTS, so
/// their per-chunk ranges coincide and one decoder + ring serves them all (a
/// stacked copy costs no extra decode). Clips at a DIFFERENT phase want
/// source times a constant gap apart: serving both from one ring would have
/// to hold the whole gap's worth of frames (deadlocking the ~13-slot
/// WebCodecs pool once the gap exceeds it), and their concurrent
/// `decodeRange` calls would corrupt the shared cursor + evict each other's
/// frames (the same-source overlap export wedge) — so each phase gets its
/// own pipeline.
export function exportHandleKey(
  mediaId: string,
  srcInUs: number,
  tStartUs: number,
): string {
  return `${mediaId}#${srcInUs - tStartUs}`;
}

export class ExportDecoderPool implements DecoderPool {
  /// Values are the `ExportDecodeSession` contract — a runtime mix of the
  /// WebCodecs `ExportSourceHandle` and the native `NativeExportSourceHandle`,
  /// chosen per-acquire by `init.nativeExport`.
  readonly handles = new Map<string, ExportDecodeSession>();

  /// Handles are keyed by `init.handleKey` — the export Worker and the
  /// export-mode Compositor both pass `exportHandleKey(...)`, giving one
  /// decode pipeline per (media, phase) group — falling back to `mediaId`
  /// for callers that don't group. Keying by bare mediaId let two
  /// overlapping clips of one source race a single handle: interleaved
  /// `decodeRange` calls corrupted the packet cursor and each clip's
  /// per-frame evict dropped frames the other still needed — the export's
  /// frame counter froze mid-run.
  acquire(init: SourceHandleInit): ExportDecodeSession {
    const key = init.handleKey ?? init.mediaId;
    let h = this.handles.get(key);
    if (!h) {
      // `nativeExport` (export-only, set by the routed 6a acquire) selects the
      // native session over the frame relay; otherwise the WebCodecs proxy path.
      h = init.nativeExport ? new NativeExportSourceHandle(init) : new ExportSourceHandle(init);
      this.handles.set(key, h);
    }
    return h;
  }

  release(key: string): void {
    const h = this.handles.get(key);
    if (!h) return;
    h.dispose();
    this.handles.delete(key);
  }

  dispose(): void {
    for (const h of this.handles.values()) h.dispose();
    this.handles.clear();
  }
}
