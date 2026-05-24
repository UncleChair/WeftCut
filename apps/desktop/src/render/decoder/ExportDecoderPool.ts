// Export-only decoder pool. Drops every preview-tuned mechanism the
// SourceDecoderPool needs (lookahead window, per-frame setAnchor, ring
// eviction, polling-based catch-up) in favor of two batched primitives:
//
//   `decodeRange(aUs, bUs)` — feed every sample whose interval covers
//   [aUs, bUs] in one shot, then `await decoder.flush()` so the caller
//   resumes with every output frame already in the store.
//
//   `evictBefore(cutoffUs)` — drop frames whose presentation interval
//   ends at or before `cutoffUs`. Called after the export chunk is
//   encoded so memory stays bounded.
//
// The store + handle expose `frameAt` / `containsPts` / `ensureReady`
// / `requestFrameAt` (no-op) / `onFirstFrame` (no-op) so the Compositor
// can plug this in as a drop-in replacement for `SourceDecoderPool`.
//
// Plan: docs/pixi-renderer-plan.md (P8 perf fix)

import { Demuxer, type VideoTrackMeta } from "./Demuxer";
import type { DecoderHandle, DecoderPool, FrameStore, SourceHandleInit } from "./SourceDecoderPool";
import { handleDecodeError } from "./decoderFallback";

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
        if (this.containsPts(w.tUs)) {
          w.resolve();
        } else {
          stillWaiting.push(w);
        }
      }
      this.waiters = stillWaiting;
    }
  }

  /// Await a frame whose presentation interval contains `tUs`. If
  /// already in the store, resolves synchronously; otherwise
  /// resolves the next time `push()` delivers a covering frame.
  /// Producer→consumer sync point for the export Worker.
  waitForPts(tUs: number): Promise<void> {
    if (this.containsPts(tUs)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push({ tUs, resolve });
    });
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
  readonly demuxer: Demuxer;
  readonly ring: ExportFrameStore;
  private decoder: VideoDecoder | null = null;
  private meta: VideoTrackMeta | null = null;
  private readyP: Promise<VideoTrackMeta> | null = null;
  /// Highest sample index we've fed to the decoder. -1 = none yet.
  private lastDispatchedIndex = -1;
  /// Frames emitted by the decoder since (re)configure. Drives the
  /// first-frame software-fallback heuristic.
  private outputFrameCount = 0;
  /// True after a software-fallback downgrade. Prevents repeated
  /// downgrade attempts on subsequent errors.
  private downgraded = false;
  private _disposed = false;

  get disposed(): boolean {
    return this._disposed;
  }

  constructor(init: SourceHandleInit) {
    this.mediaId = init.mediaId;
    this.demuxer = new Demuxer({ assetUrl: init.proxyAssetUrl });
    this.ring = new ExportFrameStore();
  }

  async ensureReady(): Promise<VideoTrackMeta> {
    if (this.meta) return this.meta;
    if (this.readyP) return this.readyP;
    this.readyP = this._doEnsureReady();
    return this.readyP;
  }

  private async _doEnsureReady(): Promise<VideoTrackMeta> {
    const meta = await this.demuxer.open();
    await this.demuxer.ensureSamplesLoaded();
    const descPreview = Array.from(meta.description.slice(0, 16))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/export] source ${this.mediaId} ready: codec=${meta.codec} ` +
        `${meta.codedWidth}x${meta.codedHeight} samples=${meta.nbSamples} ` +
        `desc[0..16]=${descPreview} (total ${meta.description.byteLength}B)`,
    );
    // Identity gate — see SourceDecoderPool for rationale.
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
          // Worker context — Tauri `invoke` isn't reachable here, so the
          // inactivity warning lands in the Worker's console instead of
          // the LogBus. Main-thread postMessage relay is a future polish.
          // eslint-disable-next-line no-console
          log: (msg) => console.warn(`[weftcut/export] ${msg}`),
        });
        if (action.kind === "downgrade-to-software") {
          this.downgradeToSoftware();
        } else if (action.kind === "inactivity-rebuild") {
          this.rebuildAfterInactivity();
        }
      },
    });
    this.decoder = dec;
    // Probe support before configuring. We test BOTH hardware and
    // software variants so we can see in the log whether hardware
    // decode is actually available in this Worker context — Chrome's
    // default "no-preference" sometimes silently lands on software in
    // Worker scope, and software 1080p decode is ~2 fps which made
    // the export look stuck.
    if (typeof VideoDecoder.isConfigSupported === "function") {
      for (const hw of ["prefer-hardware", "prefer-software"] as const) {
        try {
          const supported = await VideoDecoder.isConfigSupported({
            codec: meta.codec,
            codedWidth: meta.codedWidth,
            codedHeight: meta.codedHeight,
            description: meta.description,
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
    // Configure with prefer-hardware. The OS / browser still gets the
    // last word — if HW decode isn't available in Worker scope, it
    // falls back to software regardless. The probe above tells us which
    // it actually picked.
    this.decoder.configure(this.buildConfig(meta));
    this.meta = meta;
    return meta;
  }

  /// Build the decoder config for `meta`, honoring the current
  /// `downgraded` flag. Used by initial configure + the software-
  /// fallback rebuild.
  private buildConfig(meta: VideoTrackMeta): VideoDecoderConfig {
    return {
      codec: meta.codec,
      codedWidth: meta.codedWidth,
      codedHeight: meta.codedHeight,
      description: meta.description,
      hardwareAcceleration: this.downgraded ? "prefer-software" : "prefer-hardware",
    };
  }

  /// Software-fallback path: flip the downgraded flag, reset the
  /// existing decoder, reconfigure with prefer-software, and rewind
  /// the dispatch cursor so the next `decodeRange` re-feeds from the
  /// current GOP's IDR. Frames already in the store stay.
  private downgradeToSoftware(): void {
    if (!this.meta || !this.decoder) return;
    this.downgraded = true;
    try {
      this.decoder.reset();
      this.decoder.configure(this.buildConfig(this.meta));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `[weftcut/export] decoder ${this.mediaId} software-fallback reconfigure failed:`,
        e,
      );
      return;
    }
    // Rewind so the next decodeRange re-issues the GOP we were on.
    // The dispatch cursor is the "highest sample index fed"; setting
    // it back to (idr - 1) would require recomputing idr here. Simpler:
    // -1, forcing the next decodeRange's IDR-jump branch to take over.
    this.lastDispatchedIndex = -1;
  }

  /// Inactivity recovery: drop the dead decoder so `ensureReady`
  /// lazily rebuilds on the next `decodeRange` call. `Demuxer.open()`
  /// is idempotent, so the rebuild only reconstructs the `VideoDecoder`.
  /// Theoretical for the export path — the Worker stays active for the
  /// run — but kept for symmetry with the preview pool and as belt-and-
  /// suspenders against very long exports. `downgraded` and the in-store
  /// frames stay; `lastDispatchedIndex = -1` so the next decodeRange
  /// re-feeds the current GOP's IDR through the rebuilt decoder.
  private rebuildAfterInactivity(): void {
    try {
      this.decoder?.close();
    } catch {
      // Decoder may already be closed.
    }
    this.decoder = null;
    this.readyP = null;
    this.meta = null;
    this.lastDispatchedIndex = -1;
  }

  /// Compositor's `setAnchorTime` reaches us through this. Export
  /// drives decoding via `decodeRange` instead, so this is a no-op.
  requestFrameAt(_tUs: number): Promise<void> {
    return Promise.resolve();
  }

  /// Preview uses this to schedule a paint when the first frame lands;
  /// export composites frames synchronously, so we don't need it.
  onFirstFrame(_cb: () => void): void {
    // intentional no-op
  }

  /// Decode every sample whose presentation interval intersects
  /// [aUs, bUs]. Returns once `decoder.flush()` resolves — every
  /// dispatched chunk has produced its output frame into the ring.
  ///
  /// Sequential forward calls are cheap: if `aUs` lies inside the GOP
  /// we're already mid-flow on, we just dispatch the next contiguous
  /// run of samples. We never reset the decoder; IDR samples reset
  /// internal state implicitly when fed in order, and `decoder.flush()`
  /// drains without re-configure being required afterward.
  async decodeRange(aUs: number, bUs: number): Promise<void> {
    if (!this.meta || !this.decoder) await this.ensureReady();
    if (!this.meta || !this.decoder) return;
    const totalSamples = this.meta.nbSamples;
    if (totalSamples === 0) return;

    const targetA = this.demuxer.sampleIndexForPtsUs(aUs);
    const targetB = Math.min(
      this.demuxer.sampleIndexForPtsUs(bUs),
      totalSamples - 1,
    );
    if (targetB < targetA) return;
    const idr = this.demuxer.idrAtOrBefore(targetA);

    // If we haven't yet reached this GOP, jump to its IDR. (IDR samples
    // are self-contained so the decoder accepts a jump without reset.)
    // Otherwise continue from where we left off in the current flow.
    const startIdx =
      this.lastDispatchedIndex < idr ? idr : this.lastDispatchedIndex + 1;
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/export] ${this.mediaId} decodeRange ` +
        `pts=[${aUs}..${bUs}]us → samples [${startIdx}..${targetB}] ` +
        `(idr=${idr}, lastDispatched=${this.lastDispatchedIndex})`,
    );
    if (startIdx > targetB) {
      // Nothing new to dispatch — everything needed is already in
      // flight or already in the ring. No flush: the consumer's
      // `waitForPts` resolves as outputs trickle in.
      return;
    }

    // Dispatch in GOP-aligned batches. The fixed-size BATCH=24 we
    // tried first wedged Chrome's WebCodecs decoder: it cuts mid-GOP,
    // leaving B-frames at the batch's tail waiting on a P-frame in
    // the *next* batch. Chrome's flush() doesn't drain those — they
    // sit in the reorder buffer forever, blocking new input.
    //
    // Snapping `batchEnd` to the next IDR (inclusive) gives the
    // decoder every reference it needs for the GOP we just fed:
    // closed GOPs are fully self-contained; open-GOP B-frames that
    // reference the next GOP's IDR now have it available without
    // an explicit flush.
    //
    // We DO NOT `await decoder.flush()` between batches. flush()
    // forces the decoder to drain its reorder buffer immediately —
    // but emitting buffered frames requires VideoFrame pool slots
    // (Chrome's hardware decoder caps outstanding frames at ~8).
    // When the export Worker holds frames in the ExportFrameStore
    // pending its encode loop, those slots are taken and flush
    // deadlocks. Instead, dispatch and return — the Worker awaits
    // each frame via `ring.waitForPts(srcPts)`, which resolves on
    // the decoder's async `output` callback. The encoder loop runs
    // concurrently with the decoder, evicting (closing) source
    // frames after composition; the pool stays drained naturally.
    let pos = startIdx;
    while (pos <= targetB) {
      // batchEnd = next IDR strictly after `pos`, or last sample if
      // we're in the file's final GOP. Use sampleMetaAt here — we
      // only need the keyframe flag, and sampleAt would trigger byte
      // fetches for every block we scan, thrashing the LRU.
      let batchEnd = totalSamples - 1;
      for (let i = pos + 1; i < totalSamples; i++) {
        const s = this.demuxer.sampleMetaAt(i);
        if (s?.keyframe) {
          batchEnd = i;
          break;
        }
      }

      // Fault in the GOP-block bytes BEFORE the dispatch loop. The
      // new on-demand byte cache means sampleAt returns null on a
      // cache miss; the preview pump's `if (!s) break;` handles that
      // by retrying next rAF, but the export's synchronous dispatch
      // would silently exit with zero chunks fed and the worker
      // would deadlock on `waitForPts`. ensureBlocksLoaded awaits
      // the Range fetches so sampleAt below always returns non-null.
      await this.demuxer.ensureBlocksLoaded(pos, batchEnd);

      let dispatched = 0;
      for (let i = pos; i <= batchEnd; i++) {
        const s = this.demuxer.sampleAt(i);
        if (!s) break;
        try {
          this.decoder.decode(
            new EncodedVideoChunk({
              type: s.keyframe ? "key" : "delta",
              timestamp: s.ptsUs,
              duration: s.durationUs,
              data: s.data,
            }),
          );
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `[weftcut/export] ${this.mediaId} decode threw at sample ${i} ` +
              `(pts=${s.ptsUs}us, key=${s.keyframe}):`,
            err,
          );
          throw err;
        }
        this.lastDispatchedIndex = i;
        dispatched++;
      }

      // eslint-disable-next-line no-console
      console.log(
        `[weftcut/export] ${this.mediaId} GOP batch [${pos}..${batchEnd}] ` +
          `→ ${dispatched} dispatched (queue=${this.decoder.decodeQueueSize})`,
      );

      pos = batchEnd + 1;
    }
  }

  evictBefore(cutoffUs: number): void {
    this.ring.evictBefore(cutoffUs);
  }

  dispose(): void {
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
        // Already closed; ignore.
      }
      this.decoder = null;
    }
    this.ring.dispose();
    this.demuxer.dispose();
    this.meta = null;
    this.readyP = null;
    this.outputFrameCount = 0;
    this.downgraded = false;
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
