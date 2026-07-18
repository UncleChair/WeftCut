// The deep module for the collapsed FFmpeg decode engine (see docs/preview.md
// §Decode engine, ADR 0030): owns a `FrameRing` and a swappable `DecodeTransport`
// (GPU or SW), and does IN-PLACE HW→SW fallback on a transport failure — the
// ring survives the swap so playback doesn't visibly reset. `implements
// PreviewDecodeSession` so it drops into the existing pool/Compositor seam
// (`SourceDecoderPool.ts`), which acquires it whenever the resolved engine is ffmpeg.
import type { PreviewDecodeSession } from "./session";
import type { FfmpegLane } from "./decodeEngine";
import { FrameRing } from "./FrameRing";
import type { DecodeTransport } from "./transports/DecodeTransport";
import { GpuTransport } from "./transports/GpuTransport";
import { SwTransport } from "./transports/SwTransport";
import { pickInitialLane, markHwUnusable } from "./ffmpegCapability";
import type { FfmpegLaneResolution } from "./ffmpegCapability";

const IDLE_DISPOSE_MS = 5_000;
let nextStreamSeq = 0;

export interface FfmpegSourceInit {
  layerId: string;
  mediaId: string;
  sourcePath: string;
  sourceColor?: VideoColorSpaceInit;
  codec?: string | null;
  pixFmt?: string | null;
  /// Media dimensions — threaded into `pickInitialLane`'s classKey so the
  /// renderer-derived cache key matches main's probe (both bucket resolution
  /// on max(w, h); omitting these collapses every source to the "sd" bucket).
  width?: number | null;
  height?: number | null;
  componentAvailable: boolean;
  poolSize?: number;
  /// Bench-only: pin the lane (decode-bench Stage 3). Skips capability probing.
  forceLane?: FfmpegLane;
}

interface FfmpegSourceDeps {
  makeGpu?: () => DecodeTransport;
  makeSw?: () => DecodeTransport;
  pickLane?: typeof pickInitialLane;
}

export class FfmpegSource implements PreviewDecodeSession {
  readonly ring = new FrameRing();
  readonly mediaId: string;
  readonly layerId: string;
  private readonly init: FfmpegSourceInit;
  private readonly deps: FfmpegSourceDeps;
  private transport: DecodeTransport | null = null;
  private lane: FfmpegLane = "software";
  /// The resolved HW lane the current hardware attempt keys its transport on
  /// (Linux copy-back nvdec/vaapi → SwTransport; Windows d3d11va → GpuTransport).
  /// null unless `pickInitialLane` resolved a named HW lane; a forced-lane bench
  /// run leaves it null and falls to the GPU transport.
  private hwPlan: { lane: string; device: string | null } | null = null;
  private startedHardware = false;
  private readyP: Promise<void> | null = null;
  private ready = false;
  private _disposed = false;
  private lastUseMs = 0;
  private lastTargetUs: number | null = null;
  /// Set once the current transport's `onEof` fires; gates further
  /// `requestFrameAt` IPC (the old handle gated on eof internally — the
  /// extracted transports no longer do, so this is now the sole gate). Reset
  /// on every fresh `openLane` since a new transport can produce frames again.
  private eof = false;
  private onFirstFrameCb: (() => void) | null = null;
  private firedFirstFrame = false;
  private fatalCb: ((reason: string) => void) | null = null;
  private fatalFired = false;

  constructor(init: FfmpegSourceInit, deps: FfmpegSourceDeps = {}) {
    this.init = init;
    this.deps = deps;
    this.mediaId = init.mediaId;
    this.layerId = init.layerId;
  }

  get disposed(): boolean { return this._disposed; }
  currentLane(): FfmpegLane { return this.lane; }
  isDowngraded(): boolean { return this.startedHardware && this.lane === "software"; }
  isLookaheadFull(): boolean { return this.ring.isLookaheadFull(); }
  isIdle(nowMs: number): boolean { return this.lastUseMs > 0 && nowMs - this.lastUseMs > IDLE_DISPOSE_MS; }

  onFirstFrame(cb: () => void): void {
    if (this.firedFirstFrame) { cb(); return; }
    this.onFirstFrameCb = cb;
  }
  onFatalError(cb: (reason: string) => void): void { this.fatalCb = cb; }

  async ensureReady(): Promise<void> {
    this.lastUseMs = performance.now();
    if (this.ready) return;
    if (this.readyP) return this.readyP;
    this.readyP = this._doEnsureReady();
    return this.readyP;
  }

  private async _doEnsureReady(): Promise<void> {
    const pick = this.deps.pickLane ?? pickInitialLane;
    const res: FfmpegLaneResolution = this.init.forceLane
      ? { lane: this.init.forceLane, hwLane: null, device: null }
      : await pick(
        {
          mediaId: this.mediaId,
          codec: this.init.codec ?? null,
          pixFmt: this.init.pixFmt ?? null,
          // Conditional spread, not `width: this.init.width` —
          // exactOptionalPropertyTypes rejects an explicit `undefined` for
          // the optional `width?`/`height?` fields.
          ...(this.init.width !== undefined ? { width: this.init.width } : {}),
          ...(this.init.height !== undefined ? { height: this.init.height } : {}),
          componentAvailable: this.init.componentAvailable,
        },
        undefined,
        this.init.sourcePath,
      );
    if (this._disposed) return;
    this.lane = res.lane;
    this.hwPlan = res.lane === "hardware" && res.hwLane
      ? { lane: res.hwLane, device: res.device }
      : null;
    this.startedHardware = this.lane === "hardware";
    try {
      await this.openLane(this.lane);
    } catch (err) {
      if (this._disposed) return;
      // A HARDWARE open failure (hw-budget-exceeded, device lost at open) is
      // recoverable the same way a runtime HW error is — fall to SW in place,
      // keeping the ring. Not for a forced lane (bench) or a software open
      // (that IS total failure).
      if (this.startedHardware && this.lane === "hardware" && !this.init.forceLane) {
        markHwUnusable(this.mediaId, err instanceof Error ? err.message : String(err));
        this.transport?.dispose();
        this.transport = null;
        try {
          await this.openLane("software");
        } catch (swErr) {
          if (this._disposed) return;
          this.fireFatal(swErr instanceof Error ? swErr.message : String(swErr));
          throw swErr;
        }
      } else {
        this.fireFatal(err instanceof Error ? err.message : String(err));
        throw err;
      }
    }
    if (this._disposed) return;
    this.ready = true;
  }

  /// Open a transport for `lane`, wiring frames into the ring and errors into
  /// the recovery path. Used by initial ready AND the in-place fallback.
  private async openLane(lane: FfmpegLane): Promise<void> {
    this.eof = false; // a fresh transport can produce frames again
    const t = lane === "hardware"
      ? this.makeHardwareTransport()
      : (this.deps.makeSw?.() ?? new SwTransport());
    t.onFrame((frame, ptsUs, durUs) => {
      if (this._disposed) { frame.close(); return; }
      this.ring.push(frame, ptsUs, durUs);
      if (!this.firedFirstFrame) {
        this.firedFirstFrame = true;
        this.onFirstFrameCb?.();
        this.onFirstFrameCb = null;
      }
    });
    t.onError((reason) => this.onTransportError(lane, reason));
    t.onEof(() => { this.eof = true; });
    this.transport = t;
    this.lane = lane;
    // A fresh streamId per open so late frames from a swapped-out transport
    // (still draining on the old streamId) can never land in the ring.
    const streamId = `ffmpeg:${lane}:${this.layerId}:${nextStreamSeq++}`;
    // Conditional spread, not `sourceColor: this.init.sourceColor` —
    // exactOptionalPropertyTypes rejects an explicit `undefined` for the
    // optional `sourceColor?`/`poolSize?` fields on `DecodeTransportOpen`.
    await t.open({
      streamId,
      path: this.init.sourcePath,
      ...(this.init.sourceColor !== undefined ? { sourceColor: this.init.sourceColor } : {}),
      ...(this.init.poolSize !== undefined ? { poolSize: this.init.poolSize } : {}),
    });
    if (this.lastTargetUs !== null) t.requestFrameAt(this.lastTargetUs);
  }

  /// Pick the hardware transport by the resolved HW lane: the Linux copy-back
  /// lanes (nvdec/vaapi) ride the SW transport with a hw accel — decode happens
  /// on the GPU but frames ship as CPU NV12 over the SAME previewSw transport;
  /// the Windows shared-texture lane (d3d11va) rides the GPU transport. A forced
  /// lane (bench) has no hwPlan and falls to the GPU transport (its historical
  /// behavior).
  private makeHardwareTransport(): DecodeTransport {
    const hw = this.hwPlan;
    if (hw && (hw.lane === "nvdec" || hw.lane === "vaapi")) {
      return this.deps.makeSw?.() ?? new SwTransport({ lane: hw.lane, device: hw.device });
    }
    return this.deps.makeGpu?.() ?? new GpuTransport();
  }

  /// Recovery. A hardware-transport failure is recoverable ONCE: swap to SW in
  /// place, keeping the ring (frames just resume). A software failure — or a
  /// second failure after we already fell to SW — is a total FFmpeg failure and
  /// surfaces the single engine-level fatal.
  private onTransportError(lane: FfmpegLane, reason: string): void {
    if (this._disposed) return;
    if (lane === "hardware" && this.startedHardware && this.transport) {
      markHwUnusable(this.mediaId, reason);
      const dead = this.transport;
      this.transport = null;
      dead.dispose();
      void this.openLane("software").catch((e) => this.fireFatal(`${reason}; sw recovery failed: ${String(e)}`));
      return;
    }
    this.fireFatal(reason);
  }

  private fireFatal(reason: string): void {
    if (this.fatalFired || this._disposed) return;
    this.fatalFired = true;
    this.fatalCb?.(reason);
  }

  async requestFrameAt(tUs: number): Promise<void> {
    if (!this.ready) await this.ensureReady();
    this.lastUseMs = performance.now();
    if (this._disposed) return;
    this.lastTargetUs = tUs;
    this.ring.setAnchor(tUs);      // always — drives lookbehind eviction, even post-eof
    if (this.eof) return; // eof seen on the current transport — its own IPC is done,
    // but the anchor above must still advance so the ring keeps evicting stale frames.
    this.transport?.requestFrameAt(tUs);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.transport?.dispose();
    this.transport = null;
    this.ring.dispose();
    this.onFirstFrameCb = null;
  }
}
