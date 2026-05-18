// One VideoDecoder per source media (not per clip). Multiple clips
// referencing the same MediaId share one decoder. Lazy-create on
// first frame request; idle-dispose 5 s after the source's last clip
// leaves the lookahead window.
//
// Plan: docs/pixi-renderer-plan.md (8b.2 + 8c.2 + P1)

import { Demuxer, type VideoTrackMeta } from "./Demuxer";
import { FrameRing } from "./FrameRing";

const IDLE_DISPOSE_MS = 5_000;

export interface SourceHandleInit {
  mediaId: string;
  /// `asset://` URL of the source's 1080p master proxy.
  proxyAssetUrl: string;
}

export class SourceHandle {
  readonly mediaId: string;
  readonly demuxer: Demuxer;
  readonly ring: FrameRing;
  private decoder: VideoDecoder | null = null;
  private meta: VideoTrackMeta | null = null;
  /// Last sample index we issued to the decoder. -1 means none yet.
  private lastDecodedIndex = -1;
  /// First sample index of the currently-flowing decode run. We need
  /// this so we can issue an IDR before a non-keyframe target.
  private decodeFloor = 0;
  private lastUseMs = 0;

  constructor(init: SourceHandleInit) {
    this.mediaId = init.mediaId;
    this.demuxer = new Demuxer({ assetUrl: init.proxyAssetUrl });
    this.ring = new FrameRing();
  }

  /// Initialize the decoder + open the demuxer. Idempotent.
  async ensureReady(): Promise<VideoTrackMeta> {
    if (this.meta) return this.meta;
    const meta = await this.demuxer.open();
    await this.demuxer.ensureSamplesLoaded();
    this.decoder = new VideoDecoder({
      output: (frame: VideoFrame) => this.ring.push(frame),
      error: (e: unknown) => {
        // VideoDecoder errors are surfaced via a callback rather
        // than rejection; log and let the caller decide what to do
        // by observing ring emptiness.
        // eslint-disable-next-line no-console
        console.error(`SourceHandle(${this.mediaId}) decoder error:`, e);
      },
    });
    this.decoder.configure({
      codec: meta.codec,
      codedWidth: meta.codedWidth,
      codedHeight: meta.codedHeight,
      description: meta.description,
      // `hardwareAcceleration` defaults to no-preference; WebCodecs
      // picks the implementation. The encoder side will explicitly
      // `prefer-hardware`.
    });
    this.meta = meta;
    return meta;
  }

  /// Schedule decode of the GOP containing `tUs` and forward up to
  /// the lookahead window. Idempotent: callers can request many
  /// times per second; we skip work already done.
  async requestFrameAt(tUs: number): Promise<void> {
    if (!this.meta || !this.decoder) await this.ensureReady();
    if (!this.meta || !this.decoder) return;
    this.lastUseMs = performance.now();
    this.ring.setAnchor(tUs);

    const targetIndex = this.demuxer.sampleIndexForPtsUs(tUs);
    const idr = this.demuxer.idrAtOrBefore(targetIndex);

    // If we've already decoded past the target *and* we're inside
    // the current GOP, no action needed.
    if (this.lastDecodedIndex >= targetIndex && this.decodeFloor <= idr) {
      // Pump lookahead frames if we haven't filled the window.
      this.pumpLookahead();
      return;
    }

    // If the target is in a new (earlier or different) GOP, reset
    // the decoder so we start from a fresh IDR.
    if (this.lastDecodedIndex < idr || this.decodeFloor !== idr) {
      this.decoder.reset();
      this.decoder.configure({
        codec: this.meta.codec,
        codedWidth: this.meta.codedWidth,
        codedHeight: this.meta.codedHeight,
        description: this.meta.description,
      });
      this.lastDecodedIndex = idr - 1;
      this.decodeFloor = idr;
    }

    // Decode forward through target + lookahead window.
    this.pumpLookahead();
  }

  private pumpLookahead(): void {
    if (!this.meta || !this.decoder) return;
    let i = this.lastDecodedIndex + 1;
    while (i < this.meta.nbSamples && !this.ring.isLookaheadFull()) {
      const s = this.demuxer.sampleAt(i);
      if (!s) break;
      // EncodedVideoChunk timestamps are in microseconds.
      const chunk = new EncodedVideoChunk({
        type: s.keyframe ? "key" : "delta",
        timestamp: s.ptsUs,
        duration: s.durationUs,
        data: s.data,
      });
      this.decoder.decode(chunk);
      this.lastDecodedIndex = i;
      i++;
    }
  }

  /// `nowMs` from the pool's sweep tick. Returns true if this handle
  /// has been idle longer than the dispose threshold.
  isIdle(nowMs: number): boolean {
    return this.lastUseMs > 0 && nowMs - this.lastUseMs > IDLE_DISPOSE_MS;
  }

  /// Drop the decode pipeline + cached frames. Safe to re-init later
  /// via `ensureReady()`.
  flush(): void {
    this.decoder?.reset();
    this.lastDecodedIndex = -1;
    this.decodeFloor = 0;
    this.ring.flush();
  }

  dispose(): void {
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
        // Decoder may already be in a closed state; ignore.
      }
      this.decoder = null;
    }
    this.ring.dispose();
    this.demuxer.dispose();
    this.meta = null;
  }
}

/// Process-wide pool. One instance lives in the Compositor.
export class SourceDecoderPool {
  private handles = new Map<string, SourceHandle>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /// Acquire (or create) a handle for `mediaId`. The handle is
  /// initialized lazily by the first `await ensureReady()` call.
  acquire(init: SourceHandleInit): SourceHandle {
    let h = this.handles.get(init.mediaId);
    if (!h) {
      h = new SourceHandle(init);
      this.handles.set(init.mediaId, h);
      this.startSweeperIfNeeded();
    }
    return h;
  }

  /// Drop the handle for `mediaId` if present.
  release(mediaId: string): void {
    const h = this.handles.get(mediaId);
    if (!h) return;
    h.dispose();
    this.handles.delete(mediaId);
  }

  dispose(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const h of this.handles.values()) h.dispose();
    this.handles.clear();
  }

  private startSweeperIfNeeded(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => {
      const now = performance.now();
      for (const [mediaId, h] of this.handles) {
        if (h.isIdle(now)) {
          h.dispose();
          this.handles.delete(mediaId);
        }
      }
      if (this.handles.size === 0 && this.sweepTimer !== null) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = null;
      }
    }, 1_000);
  }
}
