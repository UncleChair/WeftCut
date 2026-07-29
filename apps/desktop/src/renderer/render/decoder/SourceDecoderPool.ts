// One VideoDecoder + FrameRing per *clip* (per layerId). The shared
// mediabunny `Input` + `EncodedPacketSink` for a given source media is
// hoisted into a refcounted `SourceMedia` keyed by mediaId, so clips that
// reference the same source pay the open + parse cost once but each get
// their own decoder pipeline (a per-clip `PacketPump` driving WebCodecs).
//
// Per-CLIP (not per-source) decoders: overlapping clips of one source need
// independent anchors — a shared ring thrashes its anchor across disjoint
// source regions and resets every clip per tick (nothing stabilises). The
// cost is memory + decode slots, but modern H.264/HEVC stacks allow 8–32
// concurrent HW sessions, so a handful of overlapping clips is within budget.
//
// See docs/render.md#decoder-pool (and #why-per-clip-decoders).

import type { EncodedPacketSink } from "mediabunny";
import { logEmit } from "../../ipc";
import { withDefaultColorSpace } from "./colorSpaceDefault";
import { DecodeClock } from "./decodeClock";
import { FrameRing } from "./FrameRing";
import { handleDecodeError } from "./decoderFallback";
import { openMediaInput, type OpenedMedia } from "./mediaInput";
import { PacketPump, type PumpDeps } from "./PacketPump";
import { FfmpegSource, type FfmpegSourceInit } from "./FfmpegSource";
import type { SourceHandleInit } from "./session";

const IDLE_DISPOSE_MS = 5_000;

/// Shared per-source state: the opened mediabunny `Input` (lazily-read
/// proxy) + its `EncodedPacketSink`, plus the once-per-source decoder
/// config readiness. Every `SourceHandle` for the same mediaId points at
/// the same `SourceMedia`, so the proxy is opened + parsed exactly once
/// regardless of how many overlapping clips reference it. Lifetime is
/// refcounted by the pool — disposed when the last referencing handle
/// goes away.
export class SourceMedia {
  readonly mediaId: string;
  private readonly proxyAssetUrl: string;
  /// Source color tags (ffprobe-mapped), for original AND proxy decodes (a
  /// proxy preserves the source's colorimetry). Threaded into
  /// `withDefaultColorSpace` so 601/full-range sources preview with their
  /// real matrix/range from either URL. Undefined ⇒ untagged source.
  private readonly sourceColor: VideoColorSpaceInit | undefined;
  private readonly knownStartPtsUs: number | null;
  private opened: OpenedMedia | null = null;
  private config: VideoDecoderConfig | null = null;
  private clock = DecodeClock.fromOrigin(0);
  /// Cached in-flight `ensureReady` promise so concurrent handles share
  /// one open + getDecoderConfig. Cleared on dispose so a re-acquire
  /// after dispose re-opens rather than re-awaiting a stale resolved
  /// promise (whose `Input` is gone).
  private readyP: Promise<VideoDecoderConfig> | null = null;
  private _disposed = false;

  get disposed(): boolean {
    return this._disposed;
  }

  /// The packet source for this media's primary video track. Throws if
  /// read before `ensureReady` has resolved.
  get packetSink(): EncodedPacketSink {
    if (!this.opened) {
      throw new Error(`SourceMedia ${this.mediaId}: packetSink before ready`);
    }
    return this.opened.packetSink;
  }

  /// Container PTS that represents source-time 0 for this media. Preview stores
  /// decoded frames in normalized source time so clip `src_in_us=0` means "the
  /// visible start of the source", even for edit-list / trimmed files whose
  /// first packet starts at a positive PTS.
  get sourceStartPtsUs(): number {
    return this.clock.containerUs(0);
  }

  get decodeClock(): DecodeClock {
    return this.clock;
  }

  constructor(
    mediaId: string,
    proxyAssetUrl: string,
    sourceColor?: VideoColorSpaceInit | undefined,
    sourceStartPtsUs?: number | null,
  ) {
    this.mediaId = mediaId;
    this.proxyAssetUrl = proxyAssetUrl;
    this.sourceColor = sourceColor;
    this.knownStartPtsUs = sourceStartPtsUs ?? null;
  }

  /// Open the proxy through mediabunny and resolve the WebCodecs decoder
  /// config from the primary video track. Idempotent across concurrent
  /// callers. `getDecoderConfig()` produces the WebCodecs `description`
  /// directly.
  async ensureReady(): Promise<VideoDecoderConfig> {
    if (this.config) return this.config;
    if (this.readyP) return this.readyP;
    this.readyP = (async () => {
      const opened = await openMediaInput(this.proxyAssetUrl);
      const config = await opened.videoTrack.getDecoderConfig();
      if (!config) {
        opened.dispose();
        throw new Error(`SourceMedia ${this.mediaId}: no decoder config`);
      }
      this.opened = opened;
      // Always derive the PTS offset from the file we are actually decoding.
      // Persisted metadata reflects the ORIGINAL container (ffprobe at import);
      // re-encoded proxies/quick transcodes start near PTS 0 even when the
      // source had a non-zero edit-list offset. Applying metadata here makes
      // getKeyPacket seek past EOF, the first-packet fallback decodes at PTS≈0,
      // normalized timestamps go negative, and lookbehind evicts every frame.
      const firstPacket = await opened.packetSink.getFirstPacket();
      this.clock = DecodeClock.fromFirstPacket(firstPacket, this.knownStartPtsUs ?? 0);
      // Untagged sources get a resolution-keyed default matrix so preview decode
      // matches the rest of the toolchain (see colorSpaceDefault) — and stays
      // consistent with the export pool, which applies the same default.
      // `sourceColor` carries the source's ffprobe tags as the middle-priority
      // layer (below the decode target's own mediabunny colr tag, above the
      // resolution default) for original AND proxy decodes alike.
      this.config = withDefaultColorSpace(config, this.sourceColor);
      // eslint-disable-next-line no-console
      console.log(
        `[weftcut/pixi] source ${this.mediaId} ready: codec=${config.codec} ` +
          `${config.codedWidth ?? "?"}x${config.codedHeight ?? "?"} ` +
          `startPts=${this.sourceStartPtsUs}us ` +
          `desc=${config.description ? `${(config.description as { byteLength: number }).byteLength}B` : "none"}`,
      );
      return this.config;
    })();
    return this.readyP;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.opened?.dispose(); // disposes the Input + aborts in-flight Range reads
    this.opened = null;
    this.config = null;
    this.clock = DecodeClock.fromOrigin(0);
    this.readyP = null;
  }
}

export class SourceHandle {
  readonly layerId: string;
  readonly media: SourceMedia;
  readonly ring: FrameRing;
  private decoder: VideoDecoder | null = null;
  /// The WebCodecs config from `SourceMedia.ensureReady`, cached so
  /// `buildConfig` can re-issue it on reset / software-downgrade rebuild.
  private config: VideoDecoderConfig | null = null;
  /// The async pump. Created once on first `ensureReady`; survives decoder
  /// rebuilds (its decoder adapter reads `this.decoder` live).
  private pump: PacketPump | null = null;
  /// In-flight `ensureReady` promise, cached so concurrent callers don't
  /// each build a fresh `VideoDecoder`. Cleared on dispose / rebuild.
  private readyP: Promise<void> | null = null;
  /// True once the decoder is built + configured for the current run.
  /// Cleared by `nullForRebuild` so the next `ensureReady` rebuilds.
  private ready = false;
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
  /// Diagnostic: VideoFrames decoded but not yet snapshotted to an
  /// ImageBitmap (`createImageBitmap` still in flight). Each such frame pins
  /// a HW-decoder pool slot (why that stalls decode: the snapshot comment in
  /// the output callback); the pump caps the INPUT queue (`decodeQueueSize`)
  /// but nothing caps this OUTPUT-side count. Surfaced in the throughput log
  /// (`inflight` = current, `peak` = window max) so a repro shows whether a
  /// stall is pool-pinning (high peak) vs. external GPU starvation (low
  /// peak, slow `createImageBitmap`).
  private conversionsInFlight = 0;
  private peakConversionsInWindow = 0;
  /// Same measurement as `peakConversionsInWindow` but NOT reset by the 1 s log
  /// window — the playback bench samples once per measured window, so a peak
  /// that resets every second would be whatever the last second happened to
  /// hold rather than the worst the run reached.
  private peakConversionsEver = 0;
  private _disposed = false;

  get disposed(): boolean {
    return this._disposed;
  }

  /// MediaId mirrors `this.media.mediaId`; kept on the handle for the
  /// `DecodeSession` interface (and for log lines that want to identify
  /// the source rather than the per-layer decoder instance).
  get mediaId(): string {
    return this.media.mediaId;
  }

  constructor(layerId: string, media: SourceMedia) {
    this.layerId = layerId;
    this.media = media;
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

  /// Build this handle's decoder + pump on top of the shared media's
  /// readiness. Idempotent across concurrent callers. The heavy open +
  /// parse lives on `SourceMedia`, so extra handles only pay per-handle
  /// `VideoDecoder` construction. Returns void (see the `DecodeSession`
  /// interface note — the value is unused by the Compositor).
  async ensureReady(): Promise<void> {
    if (this.ready && this.decoder) return;
    if (this.readyP) return this.readyP;
    this.readyP = this._doEnsureReady();
    return this.readyP;
  }

  private async _doEnsureReady(): Promise<void> {
    this.config = await this.media.ensureReady();
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
        // Snapshot pixels into an ImageBitmap so the source VideoFrame
        // can be closed immediately — this returns the hardware
        // decoder's buffer slot to its pool. Without this, the ring
        // pinned 8 + decoder reorder buffer ~5 = 13 buffers, hitting
        // the GPU decoder's pool ceiling (~13 on common desktop GPUs)
        // and stalling decode until eviction (`bitmap.close()` on
        // playback's anchor advance) freed a slot. The browser
        // optimizes `createImageBitmap(VideoFrame)` to keep pixels on
        // the GPU side; we pay a per-frame conversion but stop
        // holding the decoder's buffers across many ticks.
        const ptsUs = this.media.decodeClock.sourceUs(frame.timestamp);
        const durationUs = frame.duration ?? 0;
        this.conversionsInFlight += 1;
        if (this.conversionsInFlight > this.peakConversionsInWindow) {
          this.peakConversionsInWindow = this.conversionsInFlight;
        }
        if (this.conversionsInFlight > this.peakConversionsEver) {
          this.peakConversionsEver = this.conversionsInFlight;
        }
        createImageBitmap(frame).then(
          (bitmap) => {
            this.conversionsInFlight -= 1;
            frame.close();
            // Re-check decoder identity after the async hop. An
            // inactivity-rebuild or software-downgrade between the
            // output() callback and `createImageBitmap` resolution
            // could have replaced `this.decoder`; pushing into the
            // new generation's ring would mix frames from a dead
            // decoder into the live store.
            if (this.decoder !== dec) {
              bitmap.close();
              return;
            }
            this.outputFrameCount += 1;
            this.ring.push(bitmap, ptsUs, durationUs);
            if (!this.firedFirstFrame) {
              this.firedFirstFrame = true;
              // eslint-disable-next-line no-console
              console.log(
                `[weftcut/pixi] layer ${this.layerId} (source ${this.mediaId}) first frame decoded`,
              );
              this.onFirstFrameCb?.();
              this.onFirstFrameCb = null;
            }
            // Throughput diagnostic: log decoder fps once per second (inside
            // the `.then`, so the ring/total fields reflect post-push state).
            const nowMs = performance.now();
            if (this.windowStartMs === 0) this.windowStartMs = nowMs;
            this.outputsInWindow += 1;
            if (nowMs - this.windowStartMs >= 1000) {
              const ringLastUs = this.ring.lastPtsUs();
              const ringLastMs =
                ringLastUs !== null ? (ringLastUs / 1000).toFixed(0) : "—";
              // eslint-disable-next-line no-console
              console.log(
                `[weftcut/pixi] decoder throughput: ${this.outputsInWindow} frames in ` +
                  `${(nowMs - this.windowStartMs).toFixed(0)}ms ` +
                  `(${((this.outputsInWindow * 1000) / (nowMs - this.windowStartMs)).toFixed(1)} fps) ` +
                  `[total=${this.outputFrameCount} queue=${dec.decodeQueueSize} ` +
                  `ring=${this.ring.size()}@${ringLastMs}ms ` +
                  `inflight=${this.conversionsInFlight} peak=${this.peakConversionsInWindow}]`,
              );
              this.outputsInWindow = 0;
              this.peakConversionsInWindow = this.conversionsInFlight;
              this.windowStartMs = nowMs;
            }
          },
          (err: unknown) => {
            // Conversion failed — release the source frame and log;
            // the decoder keeps running, we just drop this output.
            // Common cause: an unsupported pixel format reaching
            // `createImageBitmap`. Not fatal; the next output may
            // succeed (the decoder isn't required to emit identical
            // formats every chunk).
            this.conversionsInFlight -= 1;
            try {
              frame.close();
            } catch {
              // Already closed; ignore.
            }
            // eslint-disable-next-line no-console
            console.warn(
              `[weftcut/pixi] createImageBitmap failed for source ${this.mediaId} ` +
                `(pts=${ptsUs}us):`,
              err,
            );
          },
        );
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
    this.decoder.configure(this.buildConfig());
    if (!this.pump) this.pump = new PacketPump(this.makePumpDeps());
    this.ready = true;
  }

  /// Adapter wiring the live `VideoDecoder` + `FrameRing` + media
  /// packetSink into the pump's narrow deps. Reads `this.decoder` live so
  /// a rebuild (new VideoDecoder) is transparent to the pump.
  private makePumpDeps(): PumpDeps {
    const handle = this;
    return {
      decoder: {
        decode: (chunk: EncodedVideoChunk) => handle.decoder?.decode(chunk),
        reset: () => handle.decoder?.reset(),
        configure: () => {
          if (handle.decoder) handle.decoder.configure(handle.buildConfig());
        },
        flush: () => handle.decoder?.flush() ?? Promise.resolve(),
        get decodeQueueSize() {
          return handle.decoder?.decodeQueueSize ?? 0;
        },
        get state(): CodecState {
          return handle.decoder?.state ?? "unconfigured";
        },
      },
      packetSink: handle.media.packetSink,
      ring: handle.ring,
      decodeClock: handle.media.decodeClock,
      log: (msg: string) => {
        // eslint-disable-next-line no-console
        console.warn(`[weftcut/pixi] pump ${handle.mediaId}: ${msg}`);
      },
    };
  }

  /// Build the decoder config, honoring `downgraded`. Spreads the full
  /// mediabunny config (preserving colorSpace etc.) and only overrides
  /// `hardwareAcceleration`.
  private buildConfig(): VideoDecoderConfig {
    if (!this.config) {
      throw new Error(`SourceHandle ${this.mediaId}: buildConfig before ready`);
    }
    return {
      ...this.config,
      hardwareAcceleration: this.downgraded ? "prefer-software" : "prefer-hardware",
    };
  }

  /// Tear down the dead decoder + clear readiness so the next
  /// `ensureReady` rebuilds a fresh `VideoDecoder`. WebCodecs moves the
  /// codec to "closed" BEFORE firing the error callback, so
  /// reset()/configure() on the errored decoder always throw — rebuilding
  /// is the only legitimate recovery. The pump survives (it reads
  /// `this.decoder` live), but its cursor must be invalidated so the fresh
  /// decoder restarts at a key packet, not mid-GOP. We don't reset
  /// `outputFrameCount`/`downgraded`: a source that needed software before
  /// still does, and the first-frame heuristic shouldn't re-arm.
  private nullForRebuild(): void {
    try {
      this.decoder?.close();
    } catch {
      // Decoder may already be closed.
    }
    this.decoder = null;
    this.readyP = null;
    this.ready = false;
    this.pump?.invalidateCursor();
  }

  /// Software-fallback path: flip the downgraded flag, then drop the
  /// dead decoder so the next `ensureReady` rebuilds with
  /// `prefer-software`. We can't reset+reconfigure the just-errored
  /// decoder — WebCodecs has already moved it to "closed" state by the
  /// time this fires (a prior version's `reset()` here is what produced
  /// the `InvalidStateError: Cannot call 'reset' on a closed codec`
  /// secondary log).
  private downgradeToSoftware(): void {
    if (this.downgraded) return;
    this.downgraded = true;
    this.nullForRebuild();
  }

  /// Inactivity recovery: same teardown — the codec slot Chrome
  /// reclaimed is already closed; only a fresh `VideoDecoder` is
  /// usable.
  private rebuildAfterInactivity(): void {
    this.nullForRebuild();
  }

  /// Nudge the decoder's lookahead toward `tUs`. Builds the pipeline lazily
  /// on first call, then delegates to the single-flight `PacketPump`.
  async requestFrameAt(tUs: number): Promise<void> {
    if (!this.ready || !this.decoder) await this.ensureReady();
    if (this._disposed || !this.pump) return;
    this.lastUseMs = performance.now();
    this.pump.requestFrameAt(tUs);
  }

  /// `nowMs` from the pool's sweep tick. Returns true if this handle
  /// has been idle longer than the dispose threshold.
  isIdle(nowMs: number): boolean {
    return this.lastUseMs > 0 && nowMs - this.lastUseMs > IDLE_DISPOSE_MS;
  }

  /// Live decoder queue depth — `VideoDecoder.decodeQueueSize`. Returns
  /// 0 when no decoder is active yet (or after dispose). Read by the
  /// dev `PerfHUD`; not on the playback hot path.
  decodeQueueSize(): number {
    return this.decoder?.decodeQueueSize ?? 0;
  }

  /// Cumulative decoded-frame count for the dev `PerfHUD`. The HUD diffs
  /// this across its poll interval to show a live decode fps.
  decodedFrameCount(): number {
    return this.outputFrameCount;
  }

  /// Whether this handle has fallen back to software decode. Dev `PerfHUD`.
  isDowngraded(): boolean {
    return this.downgraded;
  }

  /// Outputs awaiting `createImageBitmap`, each pinning a HW decode-pool slot —
  /// see `DecodeSession.conversionBacklog`. `peak` is the handle's lifetime max,
  /// deliberately not the 1 s log window's.
  conversionBacklog(): { inFlight: number; peak: number } {
    return { inFlight: this.conversionsInFlight, peak: this.peakConversionsEver };
  }

  /// Whether the ring's lookahead window is satisfied. Dev `PerfHUD`.
  isLookaheadFull(): boolean {
    return this.ring.isLookaheadFull();
  }

  /// Drop the decode pipeline + cached frames. Safe to re-init via
  /// `ensureReady()`.
  flush(): void {
    try {
      this.decoder?.reset();
    } catch {
      // Decoder may be closed.
    }
    this.pump?.invalidateCursor();
    this.ring.flush();
  }

  dispose(): void {
    this.pump?.dispose();
    this.pump = null;
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {
        // Decoder may already be in a closed state; ignore.
      }
      this.decoder = null;
    }
    this.ring.dispose();
    // The opened media lives on the shared `SourceMedia`; the pool releases
    // it (refcounted) when the last handle on this mediaId goes away. We
    // intentionally don't touch `this.media` here.
    this.config = null;
    this.readyP = null;
    this.ready = false;
    this.onFirstFrameCb = null;
    this.outputFrameCount = 0;
    this.downgraded = false;
    this._disposed = true;
  }
}

interface MediaEntry {
  media: SourceMedia;
  /// Number of live `SourceHandle`s currently referencing this media.
  /// Incremented on acquire, decremented when a handle is released
  /// (explicit release, idle sweep, or pool dispose). Media is freed
  /// at 0.
  refCount: number;
}

interface SourceDecoderPoolDeps {
  /// Internal constructor seam: production uses `FfmpegSource`; tests keep that
  /// deep module real while replacing only its native transport adapters.
  makeFfmpegSource?: (
    init: FfmpegSourceInit,
    reclaimRetainedCapacity: () => boolean | Promise<boolean>,
  ) => FfmpegSource;
}

/// Process-wide pool. One instance lives in the Compositor.
///
/// Two-tier keying: `handles` are per-layer (each clip gets its own
/// `VideoDecoder` + `FrameRing`), while `medias` are per-mediaId and
/// refcounted (so the demuxer + sample table is shared across every
/// handle referencing the same source proxy).
export class SourceDecoderPool {
  private handles = new Map<string, SourceHandle | FfmpegSource>();
  private medias = new Map<string, MediaEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private priorityKeys = new Set<string>();
  private prioritySignature = "";
  /// Current playback-resolution divisor (1 | 2 | 4), stamped onto every
  /// `FfmpegSource` this pool creates. 1 until the preview seeds it from the
  /// app setting. `SourceHandle` (Lite/WebCodecs) has no such knob — it decodes
  /// in the browser, with no IPC ship stage to shrink.
  private playbackScaleDiv = 1;

  constructor(private readonly deps: SourceDecoderPoolDeps = {}) {}

  /// Acquire (or create) a handle for `layerId`. Multiple layers may
  /// share the same `mediaId`; each gets a distinct handle (decoder +
  /// ring) but references a refcounted shared `SourceMedia`. The handle
  /// is initialised lazily by the first `await ensureReady()` call.
  ///
  /// `engine: 'ffmpeg'` routes to a `FfmpegSource`, decoding `sourcePath`
  /// directly (its own hardware/software lane selection happens internally,
  /// via `pickInitialLane`/`forceLane`). The engine resolver
  /// (`resolveDecodeEngine`) is the chooser in production. The ffmpeg branch
  /// skips `acquireMedia` entirely — there is no shared, proxy-backed
  /// `SourceMedia` for an ffmpeg session, so `mediaId` here is just a pool
  /// bookkeeping key (see `releaseHandle`, whose `medias.get(mediaId)` miss is
  /// a no-op for these handles). `poolSize` stays bench-only (decode-bench
  /// Stage 3).
  acquire(init: SourceHandleInit): SourceHandle | FfmpegSource {
    if (init.engine === "ffmpeg") {
      const existingFfmpeg = this.handles.get(init.layerId);
      if (existingFfmpeg) return existingFfmpeg;
      const sourceInit: FfmpegSourceInit = {
        layerId: init.layerId,
        mediaId: init.mediaId,
        sourcePath: init.sourcePath ?? "",
        componentAvailable: init.componentAvailable ?? false,
        // Pool-owned, not caller-supplied: the divisor is an app-level playback
        // preference, so it belongs to the pool rather than to each `ensureClip`
        // call site (and export's pool, which never sets one, can't inherit it).
        playbackScaleDiv: this.playbackScaleDiv,
        // Conditional spreads, not direct assignment — exactOptionalPropertyTypes
        // rejects an explicit `undefined` for `FfmpegSourceInit`'s optional
        // fields (same idiom `FfmpegSource.ts` itself uses).
        ...(init.sourceColor !== undefined ? { sourceColor: init.sourceColor } : {}),
        ...(init.codec !== undefined ? { codec: init.codec } : {}),
        ...(init.pixFmt !== undefined ? { pixFmt: init.pixFmt } : {}),
        ...(init.width !== undefined ? { width: init.width } : {}),
        ...(init.height !== undefined ? { height: init.height } : {}),
        ...(init.poolSize !== undefined ? { poolSize: init.poolSize } : {}),
        ...(init.forceLane !== undefined ? { forceLane: init.forceLane } : {}),
      };
      const reclaimRetainedCapacity = () =>
        this.reclaimRetainedHardwareCapacity(init.layerId);
      const ffmpegHandle = this.deps.makeFfmpegSource
        ? this.deps.makeFfmpegSource(sourceInit, reclaimRetainedCapacity)
        : new FfmpegSource(sourceInit, { reclaimRetainedCapacity });
      this.handles.set(init.layerId, ffmpegHandle);
      this.startSweeperIfNeeded();
      return ffmpegHandle;
    }
    const existing = this.handles.get(init.layerId);
    if (existing) return existing;
    const media = this.acquireMedia(
      init.mediaId,
      init.proxyAssetUrl,
      init.sourceColor,
      init.sourceStartPtsUs,
    );
    const h = new SourceHandle(init.layerId, media);
    this.handles.set(init.layerId, h);
    this.startSweeperIfNeeded();
    return h;
  }

  /// Preview declares the decode sessions that own the current frame or the
  /// nearest upcoming boundary. The pool keeps the lane/capacity mechanics
  /// private: a priority source rejected by main may evict only retained
  /// FFmpeg hardware sessions, never another active/upcoming source.
  setPriorityKeys(keys: readonly string[]): boolean | Promise<boolean> {
    const next = new Set(keys);
    const signature = JSON.stringify([...next].sort());
    const changed = signature !== this.prioritySignature;
    this.priorityKeys = next;
    this.prioritySignature = signature;
    if (!changed) return false;

    // A prewarm source may already have accepted a temporary software spill
    // when every session in the old priority set was genuinely needed. Once
    // the boundary moves, the former active source becomes retained: close it
    // first, then recycle the spilled handle so the normal next acquire asks
    // main for hardware again. One recycle per priority epoch avoids retry
    // churn when the priority set itself exceeds the physical budget.
    const spilled: Array<[string, FfmpegSource]> = [];
    for (const [key, handle] of this.handles) {
      if (
        next.has(key)
        && handle instanceof FfmpegSource
        && handle.isBudgetSpill()
      ) {
        spilled.push([key, handle]);
      }
    }
    if (spilled.length === 0) return false;
    return this.recyclePrioritySpills(spilled);
  }

  /// Adopt a new playback-resolution divisor (1 | 2 | 4): future sources are
  /// created with it, and every live `FfmpegSource` re-opens its transport in
  /// place so the change lands without a reload (see
  /// `FfmpegSource.setPlaybackScaleDiv`). `SourceHandle` is skipped — the Lite
  /// engine has no equivalent knob.
  setPlaybackScaleDiv(div: number): void {
    if (div === this.playbackScaleDiv) return;
    this.playbackScaleDiv = div;
    for (const h of this.handles.values()) {
      if (h instanceof FfmpegSource) h.setPlaybackScaleDiv(div);
    }
  }

  /// Drop the handle for `layerId` if present. The handle's referenced
  /// `SourceMedia` is freed only when its refcount falls to 0.
  release(layerId: string): void {
    this.releaseHandle(layerId);
  }

  dispose(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const h of this.handles.values()) h.dispose();
    this.handles.clear();
    for (const e of this.medias.values()) e.media.dispose();
    this.medias.clear();
  }

  /// Get-or-create a shared `SourceMedia` for `mediaId` and bump its
  /// refcount. The pool owns lifetime; callers (handles) hold a borrow.
  private acquireMedia(
    mediaId: string,
    proxyAssetUrl: string,
    sourceColor?: VideoColorSpaceInit | undefined,
    sourceStartPtsUs?: number | null,
  ): SourceMedia {
    let entry = this.medias.get(mediaId);
    if (!entry) {
      // `sourceColor` is honored only on create; reuse keeps the first
      // entry's color. Per real mediaId the color is deterministic (URL
      // resolution doesn't vary by layer), so handles sharing a media
      // resolve the same color — no stale-color hazard. The swap path
      // acquires under a synthetic mediaId, so a decodability flip over
      // time gets a fresh SourceMedia rather than reusing a stale one.
      entry = { media: new SourceMedia(mediaId, proxyAssetUrl, sourceColor, sourceStartPtsUs), refCount: 0 };
      this.medias.set(mediaId, entry);
    }
    entry.refCount += 1;
    return entry.media;
  }

  /// Dispose the handle for `layerId` (if present) and drop the
  /// matching media-refcount. When the refcount hits 0 the shared
  /// `SourceMedia` is disposed and removed from the pool, releasing
  /// the cached proxy ArrayBuffer + sample table.
  private releaseHandle(layerId: string): void {
    const h = this.handles.get(layerId);
    if (!h) return;
    const mediaId = h.mediaId;
    h.dispose();
    this.handles.delete(layerId);

    const entry = this.medias.get(mediaId);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      entry.media.dispose();
      this.medias.delete(mediaId);
    }
  }

  /// Release lower-priority native hardware sessions and wait until main has
  /// closed each one (therefore released its admission lease). Called only
  /// from a priority FfmpegSource after authoritative `previewGpu:open`
  /// returned `hw-budget-exceeded`.
  private async reclaimRetainedHardwareCapacity(requesterKey: string): Promise<boolean> {
    if (!this.priorityKeys.has(requesterKey)) return false;
    const retained: Array<[string, FfmpegSource]> = [];
    for (const [key, handle] of this.handles) {
      if (
        key !== requesterKey
        && !this.priorityKeys.has(key)
        && handle instanceof FfmpegSource
        && !handle.disposed
        && handle.currentLane() === "hardware"
      ) {
        retained.push([key, handle]);
      }
    }
    if (retained.length === 0) return false;
    await Promise.all(retained.map(async ([key, handle]) => {
      await this.releaseFfmpegHandleAndWait(key, handle);
    }));
    return true;
  }

  private async recyclePrioritySpills(
    spilled: Array<[string, FfmpegSource]>,
  ): Promise<boolean> {
    await this.reclaimRetainedHardwareCapacity(spilled[0]![0]);
    await Promise.all(spilled.map(async ([key, handle]) => {
      await this.releaseFfmpegHandleAndWait(key, handle);
    }));
    return true;
  }

  private async releaseFfmpegHandleAndWait(
    key: string,
    handle: FfmpegSource,
  ): Promise<void> {
    if (this.handles.get(key) !== handle) return;
    // Remove before awaiting so a concurrent acquire cannot receive the
    // disposed handle. FFmpeg sources have no `medias` refcount entry.
    this.handles.delete(key);
    await handle.disposeAndWait();
  }

  private startSweeperIfNeeded(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => {
      const now = performance.now();
      // Collect first so `releaseHandle` can safely mutate the map.
      // Collecting plain layerIds avoids the `delete-during-iteration`
      // hazard the previous in-loop `handles.delete(mediaId)` had.
      const idle: string[] = [];
      for (const [layerId, h] of this.handles) {
        if (h.isIdle(now)) idle.push(layerId);
      }
      for (const layerId of idle) this.releaseHandle(layerId);
      if (this.handles.size === 0 && this.sweepTimer !== null) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = null;
      }
    }, 1_000);
  }
}
