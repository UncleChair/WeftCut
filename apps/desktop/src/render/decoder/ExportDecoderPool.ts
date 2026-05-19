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
    this.decoder = new VideoDecoder({
      output: (frame: VideoFrame) => this.ring.push(frame),
      error: (e: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`[weftcut/export] decoder ${this.mediaId} error:`, e);
      },
    });
    this.decoder.configure({
      codec: meta.codec,
      codedWidth: meta.codedWidth,
      codedHeight: meta.codedHeight,
      description: meta.description,
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
    if (startIdx > targetB) {
      // Nothing new to dispatch — everything needed is already in flight
      // or already in the ring.
      await this.decoder.flush();
      return;
    }

    for (let i = startIdx; i <= targetB; i++) {
      const s = this.demuxer.sampleAt(i);
      if (!s) break;
      this.decoder.decode(
        new EncodedVideoChunk({
          type: s.keyframe ? "key" : "delta",
          timestamp: s.ptsUs,
          duration: s.durationUs,
          data: s.data,
        }),
      );
      this.lastDispatchedIndex = i;
    }

    await this.decoder.flush();
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
