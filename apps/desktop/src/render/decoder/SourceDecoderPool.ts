// One VideoDecoder per source media (not per clip). Multiple clips
// referencing the same MediaId share one decoder. Lazy-create on
// first frame request; idle-dispose 5 s after the source's last clip
// leaves the lookahead window.
//
// Plan: docs/pixi-renderer-plan.md (8b.2 + 8c.2 + P1; robustness in P9.5)

import { logEmit } from "../../ipc";
import { Demuxer, type VideoTrackMeta } from "./Demuxer";
import { FrameRing } from "./FrameRing";
import { handleDecodeError } from "./decoderFallback";

const IDLE_DISPOSE_MS = 5_000;

export interface SourceHandleInit {
  mediaId: string;
  /// `asset://` URL of the source's 1080p master proxy.
  proxyAssetUrl: string;
}

/// Minimal frame-by-PTS surface the Compositor reads through. Implemented
/// by `FrameRing` (preview) and `ExportFrameStore` (export).
export interface FrameStore {
  frameAt(tUs: number): VideoFrame | null;
  containsPts(tUs: number): boolean;
}

/// Minimal decoder-handle surface the Compositor depends on. Both the
/// preview `SourceHandle` and the export `ExportSourceHandle` satisfy
/// it — the Compositor doesn't care which it gets.
export interface DecoderHandle {
  readonly mediaId: string;
  readonly ring: FrameStore;
  ensureReady(): Promise<VideoTrackMeta>;
  /// Preview calls this every tick to nudge the decoder's lookahead;
  /// export ignores it and pre-stages frames via its own driver.
  requestFrameAt(tUs: number): Promise<void>;
  /// Preview subscribes to repaint on first decoded frame; export
  /// no-ops because the composite runs synchronously.
  onFirstFrame(cb: () => void): void;
  dispose(): void;
}

/// Pool surface used by the Compositor. Concrete pools may expose extra
/// surface (preview's idle sweeper, export's `handles` access for the
/// worker) but the Compositor only needs these two methods.
export interface DecoderPool {
  acquire(init: SourceHandleInit): DecoderHandle;
  dispose(): void;
}

export class SourceHandle {
  readonly mediaId: string;
  readonly demuxer: Demuxer;
  readonly ring: FrameRing;
  private decoder: VideoDecoder | null = null;
  private meta: VideoTrackMeta | null = null;
  /// In-flight `ensureReady` promise, cached so concurrent callers
  /// don't each create a fresh `VideoDecoder` and overwrite each
  /// other. Cleared on dispose.
  private readyP: Promise<VideoTrackMeta> | null = null;
  /// Last sample index we issued to the decoder. -1 means none yet.
  private lastDecodedIndex = -1;
  /// First sample index of the currently-flowing decode run. We need
  /// this so we can issue an IDR before a non-keyframe target.
  private decodeFloor = 0;
  private lastUseMs = 0;
  /// Notification fired after the first decoded frame lands in the
  /// ring. Lets the Compositor schedule a repaint even when the
  /// playhead is paused (otherwise the canvas stays blank because
  /// `compositeFrame` is never called).
  private onFirstFrameCb: (() => void) | null = null;
  private firedFirstFrame = false;
  /// Total frames the decoder has emitted since the last reset.
  /// Drives the first-frame software-fallback heuristic.
  private outputFrameCount = 0;
  /// True once we've reconfigured with `hardwareAcceleration:
  /// 'prefer-software'`. Prevents repeated downgrade attempts when
  /// the software path also errors.
  private downgraded = false;

  constructor(init: SourceHandleInit) {
    this.mediaId = init.mediaId;
    this.demuxer = new Demuxer({ assetUrl: init.proxyAssetUrl });
    this.ring = new FrameRing();
  }

  /// Subscribe to "first frame decoded" notification. Fires exactly
  /// once per SourceHandle. If the first frame already landed before
  /// the caller subscribed, the callback fires synchronously.
  onFirstFrame(cb: () => void): void {
    if (this.firedFirstFrame) {
      cb();
      return;
    }
    this.onFirstFrameCb = cb;
  }

  /// Initialize the decoder + open the demuxer. Idempotent across
  /// concurrent callers.
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
      `[weftcut/pixi] source ${this.mediaId} ready: codec=${meta.codec} ` +
        `${meta.codedWidth}x${meta.codedHeight} samples=${meta.nbSamples} ` +
        `desc[0..16]=${descPreview} (total ${meta.description.byteLength}B)`,
    );
    // Capture the decoder identity so that stale error callbacks from
    // a decoder we've since replaced (via inactivity-rebuild) bail
    // before re-firing the recovery path. Chrome can deliver multiple
    // errors against a dying decoder; without this gate we'd log N
    // warnings per reclaim event and call rebuild recursively.
    let dec: VideoDecoder;
    dec = new VideoDecoder({
      output: (frame: VideoFrame) => {
        if (this.decoder !== dec) {
          frame.close();
          return;
        }
        this.outputFrameCount += 1;
        this.ring.push(frame);
        if (!this.firedFirstFrame) {
          this.firedFirstFrame = true;
          // eslint-disable-next-line no-console
          console.log(`[weftcut/pixi] source ${this.mediaId} first frame decoded`);
          this.onFirstFrameCb?.();
          this.onFirstFrameCb = null;
        }
      },
      error: (e: unknown) => {
        if (this.decoder !== dec) return;
        const err = e instanceof Error ? e : new Error(String(e));
        // eslint-disable-next-line no-console
        console.error(`[weftcut/pixi] decoder ${this.mediaId} error:`, err.message);
        const action = handleDecodeError({
          err,
          outputFrameCount: this.outputFrameCount,
          alreadyDowngraded: this.downgraded,
          mediaId: this.mediaId,
          log: (msg) => {
            void logEmit({
              level: "warn",
              category: { kind: "Other", name: "Render" },
              source: { kind: "System" },
              message: msg,
            });
          },
        });
        if (action.kind === "downgrade-to-software") {
          this.downgradeToSoftware();
        } else if (action.kind === "inactivity-rebuild") {
          this.rebuildAfterInactivity();
        }
      },
    });
    this.decoder = dec;
    this.decoder.configure(this.buildConfig(meta));
    this.meta = meta;
    return meta;
  }

  /// Build the decoder config for `meta`, honoring the current
  /// `downgraded` flag. Used by initial configure + GOP-reset
  /// reconfigure + the software-fallback rebuild.
  private buildConfig(meta: VideoTrackMeta): VideoDecoderConfig {
    return {
      codec: meta.codec,
      codedWidth: meta.codedWidth,
      codedHeight: meta.codedHeight,
      description: meta.description,
      hardwareAcceleration: this.downgraded ? "prefer-software" : "prefer-hardware",
    };
  }

  /// Software-fallback path: flip the downgraded flag, reset + reconfigure
  /// the existing decoder, and rewind the decode cursor so the next pump
  /// re-feeds the current GOP from its IDR. Frames already in the ring
  /// stay — they're valid regardless of which path decoded them.
  private downgradeToSoftware(): void {
    if (!this.meta || !this.decoder) return;
    this.downgraded = true;
    try {
      this.decoder.reset();
      this.decoder.configure(this.buildConfig(this.meta));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `[weftcut/pixi] decoder ${this.mediaId} software-fallback reconfigure failed:`,
        e,
      );
      return;
    }
    // Re-pump from the current GOP's IDR. `decodeFloor` already points at
    // the IDR; rewind `lastDecodedIndex` so `pumpLookahead` re-issues it.
    this.lastDecodedIndex = this.decodeFloor - 1;
  }

  /// Inactivity recovery: drop the dead decoder + clear the readiness
  /// promise so the next `ensureReady` lazily rebuilds. `Demuxer.open()`
  /// is idempotent (guards on `streamingStarted`), so the rebuild
  /// short-circuits the streaming work and only reconstructs the
  /// `VideoDecoder`. Ring entries get flushed on the next
  /// `requestFrameAt` via the GOP-crossing reset path; we accept that
  /// short blank window as the cost of inactivity recovery. We don't
  /// reset `outputFrameCount` or `downgraded`: a source that needed
  /// software fallback before still needs it now, and the heuristic
  /// shouldn't re-arm.
  private rebuildAfterInactivity(): void {
    try {
      this.decoder?.close();
    } catch {
      // Decoder may already be closed.
    }
    this.decoder = null;
    this.readyP = null;
    this.meta = null;
    this.lastDecodedIndex = -1;
    this.decodeFloor = 0;
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

    // Reset the decoder + flush the ring when the target falls
    // outside what we can currently produce. Two genuine cases:
    //
    //   1. Target is in a different GOP than the one we're flowing
    //      from (`idr !== decodeFloor`). The decoder needs a fresh
    //      IDR before it can produce delta-frame output for the new
    //      GOP. (Forward GOP-crossing, backward GOP-crossing, or a
    //      seek that lands in a not-yet-decoded region.)
    //
    //   2. We've decoded past the target AND the target's sample is
    //      no longer in the ring (lookbehind has evicted it). The
    //      decoder can't rewind without a fresh IDR; reset + decode
    //      from `idr` forward.
    //
    // Critical: `targetIndex < lastDecodedIndex` alone is NOT a
    // valid backward-seek signal — when the playhead is held at any
    // tUs, `pumpLookahead` advances `lastDecodedIndex` past the
    // target naturally to fill the lookahead window. The previous
    // version of this check fired on every tick after the first
    // pump, resetting + flushing perpetually and starving the ring.
    let needsReset = idr !== this.decodeFloor;
    if (!needsReset && targetIndex <= this.lastDecodedIndex) {
      const targetSample = this.demuxer.sampleAt(targetIndex);
      if (targetSample && !this.ring.containsPts(targetSample.ptsUs)) {
        // We've dispatched a chunk for this target but the ring
        // doesn't contain a frame at its PTS. Two cases:
        //   (a) Decoder hasn't emitted it yet — still in queue.
        //   (b) Decoder emitted it but lookbehind evicted it.
        // Only case (b) needs a reset; case (a) just needs us to
        // wait for the async output callback. Distinguish via
        // `decodeQueueSize`: if the decoder still has queued work,
        // assume in-flight output is on the way.
        if (this.decoder.decodeQueueSize === 0) {
          needsReset = true;
        }
      }
    }

    if (needsReset) {
      // eslint-disable-next-line no-console
      console.log(
        `[weftcut/pixi] decoder reset: target=${targetIndex} idr=${idr} ` +
          `lastDecoded=${this.lastDecodedIndex} prevFloor=${this.decodeFloor}`,
      );
      this.decoder.reset();
      this.decoder.configure(this.buildConfig(this.meta));
      // Drop stale cached frames so `frameAt` can't return a frame
      // from the wrong region of the timeline.
      this.ring.flush();
      this.lastDecodedIndex = idr - 1;
      this.decodeFloor = idr;
    }

    // Decode forward through target + lookahead window.
    this.pumpLookahead();
  }

  private pumpLookahead(): void {
    if (!this.meta || !this.decoder) return;
    // Backpressure cap. VideoDecoder.decode() is sync (queues
    // internally) but the OUTPUT callback fires asynchronously, so
    // checking `ring.isLookaheadFull()` inside this loop is useless
    // — the ring stays empty until the next microtask. Cap on the
    // decoder's own internal queue depth instead. ~12 frames at
    // 60fps is ~200ms of buffered decode work, well below the
    // implementations' soft limits (~24 typically), and gives the
    // output callback plenty of time to fire before we issue more.
    const MAX_QUEUE = 12;
    let i = this.lastDecodedIndex + 1;
    while (
      i < this.meta.nbSamples &&
      this.decoder.decodeQueueSize < MAX_QUEUE &&
      !this.ring.isLookaheadFull()
    ) {
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
    this.readyP = null;
    this.onFirstFrameCb = null;
    this.outputFrameCount = 0;
    this.downgraded = false;
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
