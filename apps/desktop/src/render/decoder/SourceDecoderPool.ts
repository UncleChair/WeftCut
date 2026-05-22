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

/// Forward-seek threshold (in samples) past which we reset the
/// decoder + jump the pump cursor instead of slogging through the
/// intervening chunks. Sized to roughly one lookahead window (~60
/// frames ≈ 1 s at 60 fps source); seeks within this distance
/// catch up naturally as the pump dispatches forward, seeks beyond
/// would otherwise stall the user waiting for the decoder to chew
/// through hundreds of chunks. See ADR 0003.
const FORWARD_SEEK_RESET_THRESHOLD = 60;

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
  /// PTS in microseconds of the latest cached frame, or null if
  /// the store is empty. Used to gauge how much lookahead the
  /// decoder has produced past a given playhead position.
  lastPtsUs(): number | null;
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
  /// Diagnostic throughput counter: outputs in the current ~1s
  /// window. Logged + reset every 1000ms so we can read actual
  /// decoder fps from the console (vs reasoning about it from
  /// timing in user-visible behavior).
  private outputsInWindow = 0;
  private windowStartMs = 0;

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
        // Throughput diagnostic: log decoder fps once per second.
        const nowMs = performance.now();
        if (this.windowStartMs === 0) this.windowStartMs = nowMs;
        this.outputsInWindow += 1;
        if (nowMs - this.windowStartMs >= 1000) {
          // eslint-disable-next-line no-console
          console.log(
            `[weftcut/pixi] decoder throughput: ${this.outputsInWindow} frames in ` +
              `${(nowMs - this.windowStartMs).toFixed(0)}ms ` +
              `(${((this.outputsInWindow * 1000) / (nowMs - this.windowStartMs)).toFixed(1)} fps)`,
          );
          this.outputsInWindow = 0;
          this.windowStartMs = nowMs;
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
    // The IDR of the GOP the pump is currently flowing through. The
    // decoder's reference state comes from this IDR; chunks from
    // earlier GOPs can't decode against it.
    const pumpGopIdr =
      this.lastDecodedIndex >= 0
        ? this.demuxer.idrAtOrBefore(this.lastDecodedIndex)
        : 0;

    // Reset the decoder + flush the ring when the target lies past
    // what the pump can sequentially deliver. Two genuine cases:
    //
    //   1. Target's IDR is far past our pump frontier (long forward
    //      seek). The pump COULD catch up sequentially — IDR chunks
    //      self-refresh references mid-stream — but slogging through
    //      hundreds of intervening chunks burns seconds of decode
    //      work. Threshold = one lookahead window's worth of samples;
    //      anything within that, the pump catches up naturally;
    //      beyond, jump.
    //
    //   2. Target's frame is missing from the ring AND the decoder
    //      can't reach it by continuing to pump forward — either the
    //      pump is idle (queue empty, the frame was evicted from
    //      lookbehind) or target's IDR is BEHIND the pump's current
    //      GOP (decoder's references are stale; only a reset can
    //      restore them). Forward-pumpable misses (queue still busy,
    //      target's IDR ≥ pump's GOP) just need to wait for the
    //      output callback — no reset.
    //
    // Continuous forward play — including crossing GOP boundaries —
    // does NOT reset. The pump dispatches the new GOP's IDR through
    // the same VideoDecoder in stream and the ring carries
    // continuously across the boundary. See ADR 0003 — re-adding
    // an unconditional `idr !== decodeFloor` reset re-introduces a
    // visible playback stall at every GOP boundary, which is the
    // bug the ADR exists to prevent.
    //
    // Critical: `targetIndex < lastDecodedIndex` alone is NOT a
    // valid backward-seek signal — when the playhead is held at any
    // tUs, `pumpLookahead` advances `lastDecodedIndex` past the
    // target naturally to fill the lookahead window. A prior
    // version of this check fired on every tick after the first
    // pump, resetting + flushing perpetually and starving the ring.
    let needsReset = idr > this.lastDecodedIndex + FORWARD_SEEK_RESET_THRESHOLD;
    if (!needsReset && targetIndex <= this.lastDecodedIndex) {
      const targetSample = this.demuxer.sampleAt(targetIndex);
      if (targetSample && !this.ring.containsPts(targetSample.ptsUs)) {
        // Target's PTS isn't in the ring. Reset only if the decoder
        // can't reach it by continuing to pump forward:
        //   - Target's PTS is BEFORE the ring's first entry: the
        //     lookbehind evicted it (or we just backward-seeked
        //     past it). Pump only goes forward; in-flight chunks
        //     can't deliver it. Reset to re-dispatch from target's
        //     IDR. Covers both within-GOP-beyond-lookbehind AND
        //     backward-GOP-crossing in one signal — both manifest
        //     as "target's PTS is older than what we still cache."
        //   - Idle queue (`decodeQueueSize === 0`): nothing in
        //     flight to fill the gap, so a missing target's frame
        //     must have already been emitted and evicted.
        // Otherwise (queue still busy, target's PTS within or ahead
        // of ring) the output callback will deliver soon — wait
        // rather than reset.
        //
        // Note: an earlier version also checked `idr < pumpGopIdr`
        // (target's IDR behind pump's current GOP). That fired in a
        // reset loop during paused state once the pump's lookahead
        // naturally crossed a GOP boundary ahead of the playhead —
        // each loop iteration flushed away the target frame the
        // decoder was about to emit, restarting from chunk 0. The
        // `targetIsBeforeRing` signal already covers the
        // backward-GOP case (target's PTS < ring's first PTS) and
        // doesn't misfire during normal lookahead-filling.
        const firstPts = this.ring.firstPtsUs();
        const targetIsBeforeRing =
          firstPts !== null && targetSample.ptsUs < firstPts;
        if (targetIsBeforeRing || this.decoder.decodeQueueSize === 0) {
          needsReset = true;
        }
      }
    }

    // Diagnostic: log notable backward seeks (target way behind ring's
    // current first entry). Catches the case where lookbehind has
    // evicted the target's GOP and a reset SHOULD fire. Useful for
    // tracking down "jump-to-head shows wrong frame" reports.
    const firstPtsDiag = this.ring.firstPtsUs();
    const targetPtsDiag = this.demuxer.sampleAt(targetIndex)?.ptsUs ?? -1;
    if (firstPtsDiag !== null && targetPtsDiag >= 0 && targetPtsDiag + 100_000 < firstPtsDiag) {
      // eslint-disable-next-line no-console
      console.log(
        `[weftcut/pixi] backward seek beyond ring: target=${targetIndex} (pts=${targetPtsDiag}) ` +
          `ringFirst=${firstPtsDiag} ringLast=${this.ring.lastPtsUs()} ` +
          `lastDec=${this.lastDecodedIndex} idr=${idr} pumpGopIdr=${pumpGopIdr} ` +
          `needsReset=${needsReset}`,
      );
    }

    if (needsReset) {
      // eslint-disable-next-line no-console
      console.log(
        `[weftcut/pixi] decoder reset: target=${targetIndex} idr=${idr} ` +
          `lastDecoded=${this.lastDecodedIndex} pumpGopIdr=${pumpGopIdr} ` +
          `prevFloor=${this.decodeFloor}`,
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
    // decoder's own internal queue depth instead. 24 is sized at
    // the typical implementation soft limit and keeps the queue
    // from running dry between pump calls — important during scrub
    // where `setAnchorTime` is suppressed (scrubbing flag) so pump
    // only runs once per `scrubCoalescer.onStableSeek` (~every
    // 50ms). At a 12 cap the decoder would idle between drag
    // pauses; at 24 it stays fed.
    const MAX_QUEUE = 24;
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
