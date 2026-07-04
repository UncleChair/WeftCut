// Renderer-side `DecoderHandle` backed by a native GPU decode session
// (Stage 2 of decode-bench; see docs/superpowers/specs/2026-07-03-decode-
// bench-design.md). Joins the preview pipeline at the exact seam the
// WebCodecs `SourceHandle` does — `FrameRing.push` — so the Compositor and
// the bench don't care which strategy backs a given layer.
//
// Transport recap (Tasks 6/6b, `shared/ipc.ts` `previewGpu` + `preload/index.ts`):
//   - `window.api.previewGpu.{open,requestFrameAt,close,requestPort}` are the
//     only IPC-shaped calls; they carry session commands, never frame bytes.
//   - Decoded frames (and eof/error pokes) arrive on a `MessagePort` the
//     PRELOAD hands to this main-world context via `window.postMessage` in
//     response to `requestPort()` — a port can't cross `contextBridge`
//     itself. The `message` listener MUST be attached before calling
//     `requestPort()`, or the one-time handoff can be missed.
//   - The preload acks each frame internally (after its own
//     `createImageBitmap`, so the native pool slot is safe to reuse) — this
//     handle never acks.
import type { DecoderHandle } from "./SourceDecoderPool";
import { FrameRing } from "./FrameRing";
import type { PreviewGpuColorSpace } from "../../../shared/ipc";

/// How long to wait for the preload's port handoff before ensureReady rejects.
/// Generous — this is a one-time same-process `postMessage` round-trip, not a
/// decode operation, so a real failure (preload never wired, requestPort a
/// no-op) should surface quickly rather than hang the caller indefinitely.
const PORT_TIMEOUT_MS = 5_000;

/// Idle-dispose threshold. Mirrors `SourceDecoderPool`'s `IDLE_DISPOSE_MS` —
/// re-declared locally (rather than imported) so this file doesn't take a
/// runtime dependency back on the pool module it's constructed by, which
/// only holds a type-only import of `DecoderHandle` from here today.
const IDLE_DISPOSE_MS = 5_000;

/// Cap on retained per-frame bench-timing samples (see NativeGpuSourceHandle).
const BENCH_TIMING_CAP = 20_000;

interface PortFrameMsg {
  kind: "frame";
  streamId: string;
  slot: number;
  ptsUs: number;
  durUs: number;
  bitmap: ImageBitmap;
  /// Bench-only per-frame preload timings (ms), attached by the preload receiver.
  /// Absent on a non-instrumented message.
  gvfMs?: number;
  cibMs?: number;
  residentMs?: number;
}
interface PortEofMsg {
  kind: "eof";
  streamId: string;
}
interface PortErrorMsg {
  kind: "error";
  streamId: string;
  message: string;
}
type PortMsg = PortFrameMsg | PortEofMsg | PortErrorMsg;

/// Monotonic suffix so a dispose+re-acquire cycle on the same `layerId`
/// (pool churn, decode-bench cold-start iterations) never collides with a
/// still-draining prior session's late port messages — each handle instance
/// gets a distinct `streamId` even if `layerId` repeats.
let nextStreamSeq = 0;

/// Fill a `PreviewGpuColorSpace` from the source's decode-time color tags,
/// defaulting to BT.709/limited — the same HD default the WebCodecs path's
/// `withDefaultColorSpace` lands on — when the source carries no tags.
export function deriveColorSpace(sourceColor?: VideoColorSpaceInit): PreviewGpuColorSpace {
  return {
    primaries: sourceColor?.primaries ?? "bt709",
    transfer: sourceColor?.transfer ?? "bt709",
    matrix: sourceColor?.matrix ?? "bt709",
    range: sourceColor?.fullRange ? "full" : "limited",
  };
}

export class NativeGpuSourceHandle implements DecoderHandle {
  readonly ring: FrameRing;
  readonly mediaId: string;
  readonly layerId: string;
  /// Per-handle stream identity, passed to every `previewGpu` call and
  /// stamped on every port message this handle should accept. See
  /// `nextStreamSeq` for why it's not just `layerId`.
  readonly streamId: string;
  /// Native pool size this session opens with. Default 3 mirrors the WebCodecs
  /// lookahead headroom; decode-bench overrides it for the Stage-3 pool sweep.
  readonly poolSize: number;

  private readonly sourcePath: string;
  private readonly sourceColor: VideoColorSpaceInit | undefined;

  private port: MessagePort | null = null;
  private messageListener: ((ev: MessageEvent) => void) | null = null;
  /// Resolves the in-flight `_doEnsureReady`'s wait for the port handoff.
  /// Cleared once fired so a stray second `message` event (shouldn't
  /// happen — `requestPort()` is only called once per handle) can't
  /// double-resolve.
  private portReadyResolve: (() => void) | null = null;
  private portReadyP: Promise<void> | null = null;

  private readyP: Promise<void> | null = null;
  private ready = false;
  private _disposed = false;
  /// Last `ensureReady`/`requestFrameAt` call time, for the pool's idle
  /// sweeper (`isIdle`). Mirrors `SourceHandle.lastUseMs`.
  private lastUseMs = 0;
  /// True once an `eof` port message arrived. `requestFrameAt` stops
  /// issuing IPC once set — nudging a session that already reported
  /// end-of-stream just burns round-trips.
  private eof = false;

  /// Bench-only: per-frame preload timings, aggregated for decode-bench Stage 3.
  /// Capped so a long session can't grow them unbounded (native-only; the cap is
  /// never approached at native frame rates over a 30s window). Drained by the bench.
  private benchGvfMs: number[] = [];
  private benchCibMs: number[] = [];
  private benchResidentMs: number[] = [];

  private onFirstFrameCb: (() => void) | null = null;
  private firedFirstFrame = false;

  /// Trailing coalescer state: the latest requested target not yet sent,
  /// and whether a `previewGpu.requestFrameAt` call is currently awaited.
  /// Mirrors `ScrubCoalescer`'s intent (see scrub.ts) at a much smaller
  /// scale — this only needs "at most one in-flight, latest wins", not
  /// scrub's debounce/ceiling timers.
  private pendingTargetUs: number | null = null;
  private requestInFlight = false;

  constructor(
    layerId: string,
    mediaId: string,
    sourcePath: string,
    sourceColor?: VideoColorSpaceInit,
    poolSize = 3,
  ) {
    this.layerId = layerId;
    this.mediaId = mediaId;
    this.sourcePath = sourcePath;
    this.sourceColor = sourceColor;
    this.poolSize = poolSize;
    this.streamId = `native-gpu:${layerId}:${nextStreamSeq++}`;
    this.ring = new FrameRing();
  }

  get disposed(): boolean {
    return this._disposed;
  }

  /// Subscribe to "first frame decoded". Fires exactly once; if the first
  /// frame already landed before the caller subscribed, fires synchronously
  /// — same contract as `SourceHandle.onFirstFrame`.
  onFirstFrame(cb: () => void): void {
    if (this.firedFirstFrame) {
      cb();
      return;
    }
    this.onFirstFrameCb = cb;
  }

  /// Build the session: wire the port handoff, then open the native
  /// session. Idempotent across concurrent callers (cached in-flight
  /// promise, like `SourceHandle.ensureReady`).
  async ensureReady(): Promise<void> {
    this.lastUseMs = performance.now();
    if (this.ready) return;
    if (this.readyP) return this.readyP;
    this.readyP = this._doEnsureReady();
    return this.readyP;
  }

  private async _doEnsureReady(): Promise<void> {
    // Attach BEFORE requestPort() — the preload's handoff post is one-time
    // and un-replayable; a listener attached after the call could miss it.
    this.messageListener = (ev: MessageEvent) => {
      const data = ev.data as { __weftcutPreviewGpu?: string } | null | undefined;
      if (!data || data.__weftcutPreviewGpu !== "port") return;
      const port = ev.ports?.[0];
      if (!port) return;
      this.port = port;
      this.port.onmessage = (m: MessageEvent) => this.handlePortMessage(m.data as PortMsg);
      this.portReadyResolve?.();
      this.portReadyResolve = null;
    };
    window.addEventListener("message", this.messageListener);
    window.api.previewGpu.requestPort();
    await this.waitForPort();
    if (this._disposed) return;
    // The configured poolSize (default 3) mirrors the WebCodecs path's
    // headroom (a couple of lookahead frames in flight plus one being read)
    // without asking the native pool for more slots than preview actually
    // pipelines. Decode-bench overrides this for the Stage-3 pool sweep.
    await window.api.previewGpu.open({
      streamId: this.streamId,
      path: this.sourcePath,
      poolSize: this.poolSize,
      colorSpace: deriveColorSpace(this.sourceColor),
    });
    if (this._disposed) return;
    this.ready = true;
  }

  private waitForPort(): Promise<void> {
    if (this.port) return Promise.resolve();
    if (!this.portReadyP) {
      this.portReadyP = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `NativeGpuSourceHandle ${this.streamId}: timed out waiting for MessagePort handoff`,
            ),
          );
        }, PORT_TIMEOUT_MS);
        this.portReadyResolve = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    return this.portReadyP;
  }

  /// Handle one message off the preload's port. Filters by `streamId` —
  /// defensive: the preload's port channel may in principle carry another
  /// stream's traffic, and a stray message must not corrupt this ring.
  private handlePortMessage(data: PortMsg): void {
    if (!data || data.streamId !== this.streamId) return;
    if (data.kind === "frame") {
      if (this._disposed) {
        // Late frame after teardown — drop it, returning the bitmap's
        // backing resources rather than leaking them.
        data.bitmap?.close?.();
        return;
      }
      this.ring.push(data.bitmap, data.ptsUs, data.durUs);
      if (typeof data.residentMs === "number" && this.benchResidentMs.length < BENCH_TIMING_CAP) {
        this.benchGvfMs.push(data.gvfMs ?? 0);
        this.benchCibMs.push(data.cibMs ?? 0);
        this.benchResidentMs.push(data.residentMs);
      }
      if (!this.firedFirstFrame) {
        this.firedFirstFrame = true;
        this.onFirstFrameCb?.();
        this.onFirstFrameCb = null;
      }
    } else if (data.kind === "eof") {
      this.eof = true;
    } else if (data.kind === "error") {
      // Not fatal — the native session may keep producing frames; surface
      // for diagnosis without throwing (same posture as SourceHandle's
      // per-frame conversion failures).
      // eslint-disable-next-line no-console
      console.warn(`[weftcut/pixi] native GPU decode ${this.streamId} error:`, data.message);
    }
  }

  /// Nudge the native session's decode target toward `tUs`. Coalesces:
  /// while a `previewGpu.requestFrameAt` call is in flight, only the most
  /// recent target is remembered and sent once the current call settles —
  /// callers firing every tick (Compositor, decode-bench) never queue more
  /// than one extra IPC round-trip.
  async requestFrameAt(tUs: number): Promise<void> {
    if (!this.ready) await this.ensureReady();
    this.lastUseMs = performance.now();
    if (this._disposed || this.eof) return;
    this.pendingTargetUs = tUs;
    if (this.requestInFlight) return;
    await this.pumpRequests();
  }

  private async pumpRequests(): Promise<void> {
    this.requestInFlight = true;
    try {
      while (this.pendingTargetUs !== null && !this._disposed) {
        const target = this.pendingTargetUs;
        this.pendingTargetUs = null;
        await window.api.previewGpu.requestFrameAt({ streamId: this.streamId, targetUs: target });
      }
    } finally {
      this.requestInFlight = false;
    }
  }

  /// Whether the ring's lookahead window is satisfied. Dev `PerfHUD`.
  isLookaheadFull(): boolean {
    return this.ring.isLookaheadFull();
  }

  /// Bench-only: return and clear the accumulated per-frame preload timings.
  /// decode-bench calls this at the end of a throughput window.
  drainBenchTiming(): { gvfMs: number[]; cibMs: number[]; residentMs: number[] } {
    const out = { gvfMs: this.benchGvfMs, cibMs: this.benchCibMs, residentMs: this.benchResidentMs };
    this.benchGvfMs = [];
    this.benchCibMs = [];
    this.benchResidentMs = [];
    return out;
  }

  /// `nowMs` from the pool's sweep tick. Returns true if this handle has
  /// been idle longer than the dispose threshold. Required by
  /// `SourceDecoderPool`'s sweeper now that `handles` holds the
  /// `SourceHandle | NativeGpuSourceHandle` union — mirrors
  /// `SourceHandle.isIdle`.
  isIdle(nowMs: number): boolean {
    return this.lastUseMs > 0 && nowMs - this.lastUseMs > IDLE_DISPOSE_MS;
  }

  /// Tear down: stop listening for port traffic, close the native session
  /// (preload releases its shared-texture imports, main closes the native
  /// decode thread), and drop cached frames. Safe even if `ensureReady`
  /// never completed (e.g. the port handoff timed out).
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this.messageListener) {
      window.removeEventListener("message", this.messageListener);
      this.messageListener = null;
    }
    if (this.port) {
      this.port.onmessage = null;
      this.port = null;
    }
    void window.api.previewGpu.close({ streamId: this.streamId });
    this.ring.dispose();
    this.onFirstFrameCb = null;
  }
}
