// Export-only decoder pool. Drops every preview-tuned mechanism the
// SourceDecoderPool needs (lookahead window, per-frame setAnchor, polling-
// based catch-up) in favor of two batched primitives:
//
//   `decodeRange(aUs, bUs)` — an async seek-and-forward loop over the
//   mediabunny EncodedPacketSink: seek to the GOP key at/before `aUs` (or
//   continue from the packet cursor when the range moves forward of the
//   dispatch frontier), then dispatch packets in DECODE order through the
//   first key packet strictly after `bUs`, so every frame with presentation
//   PTS ≤ bUs — including open-GOP B-frames referencing the next GOP's key —
//   is fed. No `decoder.flush()` between ranges (flushing would deadlock
//   against the VideoFrame pool slots the worker holds); the worker awaits
//   each output frame via `ring.waitForPts`. Awaiting `getNextPacket` faults
//   in uncached bytes natively, so there is no byte pre-fault.
//
//   `evictBefore(cutoffUs)` — drop frames whose presentation interval
//   ends at or before `cutoffUs`. Called after the export chunk is
//   encoded so memory stays bounded.
//
// The store + handle expose `frameAt` / `containsPts` / `ensureReady`
// / `requestFrameAt` (no-op) / `onFirstFrame` (no-op) so the Compositor
// can plug this in as a drop-in replacement for `SourceDecoderPool`.

import type { EncodedPacket } from "mediabunny";
import type { DecoderHandle, DecoderPool, FrameStore, SourceHandleInit } from "./SourceDecoderPool";
import { withDefaultColorSpace } from "./colorSpaceDefault";
import { handleDecodeError } from "./decoderFallback";
import { openMediaInput, type OpenedMedia } from "./mediaInput";

interface RingEntry {
  ptsUs: number;
  durationUs: number;
  frame: VideoFrame;
}

export class ExportFrameStore implements FrameStore {
  private entries: RingEntry[] = [];
  /// Pending `waitForPts` resolvers. On every `push` we resolve and
  /// remove the ones whose tUs is now covered. The Worker uses this
  /// to await each source frame before composing the next output
  /// frame — keeps the WebCodecs decoder pool from piling up
  /// unconsumed frames (pool exhaustion at ~8 outstanding frames
  /// was the export-stuck wedge).
  private waiters: Array<{ tUs: number; resolve: () => void }> = [];

  push(frame: VideoFrame): void {
    this.entries.push({
      ptsUs: frame.timestamp,
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
    }
  }

  /// Await a frame whose presentation interval contains `tUs`. If
  /// already in the store, resolves synchronously; otherwise
  /// resolves the next time `push()` delivers a covering frame.
  /// Producer→consumer sync point for the export Worker.
  waitForPts(tUs: number): Promise<void> {
    if (this.isReadyFor(tUs)) return Promise.resolve();
    const p = new Promise<void>((resolve) => {
      this.waiters.push({ tUs, resolve });
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
    return last !== null && last > tUs;
  }

  frameAt(tUs: number): VideoFrame | null {
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
    let n = 0;
    while (n < this.entries.length) {
      const e = this.entries[n]!;
      if (e.ptsUs + (e.durationUs || 0) <= cutoffUs) {
        e.frame.close();
        n++;
      } else {
        break;
      }
    }
    if (n > 0) this.entries.splice(0, n);
  }

  flush(): void {
    for (const e of this.entries) e.frame.close();
    this.entries = [];
    // Any caller still awaiting waitForPts is now in a state where
    // their wait will never resolve naturally. Don't resolve them —
    // that would mislead the caller into thinking a frame is
    // present. Caller is expected to bail out via the dispose path.
    this.waiters = [];
  }

  size(): number {
    return this.entries.length;
  }

  dispose(): void {
    this.flush();
  }
}

export class ExportSourceHandle implements DecoderHandle {
  readonly mediaId: string;
  private readonly proxyAssetUrl: string;
  readonly ring: ExportFrameStore;
  private opened: OpenedMedia | null = null;
  private config: VideoDecoderConfig | null = null;
  private decoder: VideoDecoder | null = null;
  private readyP: Promise<void> | null = null;
  /// Last packet dispatched to the decoder (decode order); null = unpositioned.
  private cursor: EncodedPacket | null = null;
  /// Presentation PTS (µs) of `cursor` — the dispatch frontier. Sentinel
  /// until the first dispatch; used to decide seek-vs-continue per range.
  private lastDispatchedPtsUs = Number.NEGATIVE_INFINITY;
  private outputFrameCount = 0;
  private downgraded = false;
  private _disposed = false;
  /// In-flight end-of-stream `decoder.flush()` (floated, never awaited inline —
  /// see `issueEosFlush`). A subsequent `decodeRange` on this handle awaits it
  /// before feeding new packets, so a re-decode never races a pending flush.
  private flushP: Promise<void> | null = null;

  get disposed(): boolean {
    return this._disposed;
  }

  constructor(init: SourceHandleInit) {
    this.mediaId = init.mediaId;
    this.proxyAssetUrl = init.proxyAssetUrl;
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
    // Untagged sources get a resolution-keyed default matrix so WebView2's
    // decode matches the rest of the toolchain (see colorSpaceDefault).
    this.config = withDefaultColorSpace(config);
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/export] source ${this.mediaId} ready: codec=${config.codec} ` +
        `${config.codedWidth ?? "?"}x${config.codedHeight ?? "?"}`,
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
        if (this.outputFrameCount === 1 || this.outputFrameCount % 30 === 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[weftcut/export] ${this.mediaId} output #${this.outputFrameCount}: ` +
              `pts=${frame.timestamp}us`,
          );
        }
        this.ring.push(frame);
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

  /// Build the decoder config, honoring `downgraded`. Spreads the full
  /// mediabunny config (colorSpace etc.) and overrides only hwAccel.
  private buildConfig(): VideoDecoderConfig {
    if (!this.config) {
      throw new Error(`[weftcut/export] ${this.mediaId}: buildConfig before ready`);
    }
    return {
      ...this.config,
      hardwareAcceleration: this.downgraded ? "prefer-software" : "prefer-hardware",
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
    // The fresh decoder supersedes any in-flight EOS flush on the old one (its
    // .then/.catch are identity-guarded and settle harmlessly).
    this.flushP = null;
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

    // A prior range hit end-of-stream and floated a decoder flush, leaving the
    // decoder drained + reset (cursor cleared). Await the drain before feeding
    // new packets so this re-decode never races a pending flush. By now the
    // encode loop has freed the pool, so this resolves promptly.
    if (this.flushP) {
      await this.flushP;
      this.flushP = null;
      if (this._disposed) return;
    }

    // Position: continue from the cursor when aUs is at/ahead of the frontier
    // (the normal forward-export case); otherwise seek to aUs's GOP key.
    let pkt: EncodedPacket | null;
    if (this.cursor !== null && aUs >= this.lastDispatchedPtsUs) {
      pkt = await packetSink.getNextPacket(this.cursor);
    } else {
      pkt = await packetSink.getKeyPacket(aUs / 1e6);
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
        `(start=${pkt ? Math.round(pkt.timestamp * 1e6) : "none"}us, ` +
        `frontier=${this.lastDispatchedPtsUs}us)`,
    );

    let dispatched = 0;
    while (pkt) {
      const ptsUs = Math.round(pkt.timestamp * 1e6);
      this.decoder.decode(pkt.toEncodedVideoChunk());
      this.cursor = pkt;
      this.lastDispatchedPtsUs = ptsUs;
      dispatched++;
      // Stop AFTER dispatching the first key strictly past bUs — that key
      // begins the GOP after bUs, so everything with PTS ≤ bUs (incl.
      // open-GOP B-refs) has now been fed.
      if (pkt.type === "key" && ptsUs > bUs) break;
      pkt = await packetSink.getNextPacket(pkt);
      if (this._disposed) return;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/export] ${this.mediaId} decodeRange dispatched ${dispatched} ` +
        `(queue=${this.decoder.decodeQueueSize})`,
    );

    // End-of-stream discriminator: the loop exited because `getNextPacket`
    // returned null (`pkt === null`) after dispatching at least one packet —
    // NOT via the key-past-bUs `break` (which leaves `pkt` holding that key).
    // At EOS we fed every remaining packet, so a mid-stream chunk's drain
    // mechanism (the next GOP key flushing the prior GOP's reorder buffer) can
    // never fire — the final GOP's trailing B-frames stay parked in the
    // decoder's reorder buffer until an explicit flush.
    if (dispatched > 0 && pkt === null) {
      this.issueEosFlush();
    }
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
  /// from a keyframe, so reset the cursor → the next `decodeRange` (e.g. a final
  /// GOP spanning multiple chunks) re-seeks instead of continuing from a stale
  /// cursor into a reset decoder.
  private issueEosFlush(): void {
    const dec = this.decoder;
    if (!dec) return;
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/export] ${this.mediaId} EOS — flushing decoder reorder buffer ` +
        `(queue=${dec.decodeQueueSize}, ring=${this.ring.size()})`,
    );
    this.flushP = dec
      .flush()
      .then(() => {
        if (this.decoder !== dec) return; // superseded by rebuild/dispose
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
    this.outputFrameCount = 0;
    this.downgraded = false;
    this.flushP = null;
    this._disposed = true;
  }
}

export class ExportDecoderPool implements DecoderPool {
  readonly handles = new Map<string, ExportSourceHandle>();

  /// Export keeps the original mediaId-keyed sharing: the Worker drives
  /// decoding sequentially per output frame, so the preview-side anchor-
  /// thrash failure (multiple clips of one media racing each other in
  /// the same tick) doesn't manifest here. The `init.layerId` field is
  /// accepted for interface symmetry with the preview pool but ignored.
  /// (Note: same-source clips with disjoint source-time ranges in one
  /// chunk still cost an extra GOP jump per output frame — a separate
  /// optimisation, not a correctness issue.)
  acquire(init: SourceHandleInit): ExportSourceHandle {
    let h = this.handles.get(init.mediaId);
    if (!h) {
      h = new ExportSourceHandle(init);
      this.handles.set(init.mediaId, h);
    }
    return h;
  }

  release(mediaId: string): void {
    const h = this.handles.get(mediaId);
    if (!h) return;
    h.dispose();
    this.handles.delete(mediaId);
  }

  dispose(): void {
    for (const h of this.handles.values()) h.dispose();
    this.handles.clear();
  }
}
