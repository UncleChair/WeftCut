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

interface RingEntry {
  ptsUs: number;
  durationUs: number;
  frame: VideoFrame;
}

export class ExportFrameStore implements FrameStore {
  private entries: RingEntry[] = [];

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
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/export] source ${this.mediaId} ready: codec=${meta.codec} ` +
        `${meta.codedWidth}x${meta.codedHeight} samples=${meta.nbSamples}`,
    );
    let outputCount = 0;
    this.decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        outputCount += 1;
        if (outputCount === 1 || outputCount % 30 === 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[weftcut/export] ${this.mediaId} output #${outputCount}: ` +
              `pts=${frame.timestamp}us`,
          );
        }
        this.ring.push(frame);
      },
      error: (e: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`[weftcut/export] decoder ${this.mediaId} error:`, e);
      },
    });
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
    this.decoder.configure({
      codec: meta.codec,
      codedWidth: meta.codedWidth,
      codedHeight: meta.codedHeight,
      description: meta.description,
      hardwareAcceleration: "prefer-hardware",
    });
    this.meta = meta;
    return meta;
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
      // Nothing new to dispatch — everything needed is already in flight
      // or already in the ring.
      await this.decoder.flush();
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
    // reference the next GOP's IDR now have it available before flush.
    const totalSamples = this.meta.nbSamples;
    let pos = startIdx;
    while (pos <= targetB) {
      // batchEnd = next IDR strictly after `pos`, or last sample if
      // we're in the file's final GOP.
      let batchEnd = totalSamples - 1;
      for (let i = pos + 1; i < totalSamples; i++) {
        const s = this.demuxer.sampleAt(i);
        if (s?.keyframe) {
          batchEnd = i;
          break;
        }
      }

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

      const flushStartMs = performance.now();
      // eslint-disable-next-line no-console
      console.log(
        `[weftcut/export] ${this.mediaId} GOP batch [${pos}..${batchEnd}] ` +
          `→ ${dispatched} dispatched (queue=${this.decoder.decodeQueueSize}); flush`,
      );
      const wd = setInterval(() => {
        // eslint-disable-next-line no-console
        console.warn(
          `[weftcut/export] ${this.mediaId} flush still pending ` +
            `(queue=${this.decoder?.decodeQueueSize}, ring=${this.ring.size()})`,
        );
      }, 5000);
      try {
        await this.decoder.flush();
      } finally {
        clearInterval(wd);
      }
      // eslint-disable-next-line no-console
      console.log(
        `[weftcut/export] ${this.mediaId} batch flush done in ` +
          `${(performance.now() - flushStartMs).toFixed(0)}ms; ` +
          `ring=${this.ring.size()} frames`,
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
  }
}

export class ExportDecoderPool implements DecoderPool {
  readonly handles = new Map<string, ExportSourceHandle>();

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
