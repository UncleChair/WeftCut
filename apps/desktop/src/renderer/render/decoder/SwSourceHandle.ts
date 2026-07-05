// Renderer-side `DecoderHandle` backed by a native SOFTWARE decode session
// (Task 7 of the ffmpeg-sw-decode-blindspot plan; see
// docs/superpowers/specs/2026-07-05-ffmpeg-sw-decode-blindspot-design.md).
// Joins the preview pipeline at the same seam as `SourceHandle` and
// `NativeGpuSourceHandle` — `FrameRing.push` — so the Compositor doesn't
// care which strategy backs a given layer.
//
// Transport recap (Tasks 4/5, `shared/ipc.ts` `previewSw` + `preload/index.ts`):
//   - `window.api.previewSw.{open,requestFrameAt,close}` carry session
//     commands only.
//   - Decoded frames arrive as plain NV12 byte buffers directly over the
//     contextBridge (no shared texture, no MessagePort — a `previewSw:frame`
//     IPC event per frame), delivered via `onFrame`. This handle does the
//     NV12 -> VideoFrame -> ImageBitmap conversion itself (the preload does
//     that for the GPU path instead).
//   - preview_sw sends no eof/error to the renderer (Task 4 made those
//     log-only in main) — this handle only ever receives frames.
import type { DecoderHandle } from "./SourceDecoderPool";
import { FrameRing } from "./FrameRing";
import type { PreviewSwFrameMsg } from "../../../shared/ipc";

/// Idle-dispose threshold. Mirrors `SourceDecoderPool`'s `IDLE_DISPOSE_MS` —
/// re-declared locally (like `NativeGpuSourceHandle`) so this file doesn't
/// take a runtime dependency back on the pool module it's constructed by.
const IDLE_DISPOSE_MS = 5_000;

/// Monotonic suffix so a dispose+re-acquire cycle on the same `layerId`
/// never collides with a still-in-flight prior session's late frame
/// messages — each handle instance gets a distinct `streamId` even if
/// `layerId` repeats.
let nextStreamSeq = 0;

export class SwSourceHandle implements DecoderHandle {
  readonly ring: FrameRing;
  readonly mediaId: string;
  readonly layerId: string;
  /// Per-handle stream identity, passed to every `previewSw` call and
  /// stamped on every frame message this handle should accept.
  readonly streamId: string;

  private readonly sourcePath: string;
  private readonly sourceColor: VideoColorSpaceInit | undefined;

  private unsub: (() => void) | null = null;

  private readyP: Promise<void> | null = null;
  private ready = false;
  private _disposed = false;
  /// Last `ensureReady`/`requestFrameAt` call time, for the pool's idle
  /// sweeper (`isIdle`). Mirrors `SourceHandle.lastUseMs`.
  private lastUseMs = 0;

  private onFirstFrameCb: (() => void) | null = null;
  private firedFirstFrame = false;

  /// Last target sent to `previewSw.requestFrameAt`, for cheap same-target
  /// dedup. Unlike `NativeGpuSourceHandle`'s coalescing pump, the transport
  /// here is a fire-and-forget `send` (Task 5's preload), so there is no
  /// async round-trip to coalesce behind.
  private lastSentTargetUs: number | null = null;

  constructor(
    layerId: string,
    mediaId: string,
    sourcePath: string,
    sourceColor?: VideoColorSpaceInit,
  ) {
    this.layerId = layerId;
    this.mediaId = mediaId;
    this.sourcePath = sourcePath;
    this.sourceColor = sourceColor;
    this.streamId = `native-sw:${layerId}:${nextStreamSeq++}`;
    this.ring = new FrameRing();
  }

  get disposed(): boolean {
    return this._disposed;
  }

  /// Subscribe to "first frame decoded". Fires exactly once; if the first
  /// frame already landed before the caller subscribed, fires synchronously
  /// — same contract as `SourceHandle.onFirstFrame` / `NativeGpuSourceHandle.onFirstFrame`.
  onFirstFrame(cb: () => void): void {
    if (this.firedFirstFrame) {
      cb();
      return;
    }
    this.onFirstFrameCb = cb;
  }

  /// Build the session: subscribe to the frame event, then open the native
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
    // Subscribe BEFORE open() — frames can start flowing as soon as the
    // native decode thread is up, so a listener attached after open()
    // could miss an early frame.
    this.unsub = window.api.previewSw.onFrame((f) => {
      void this.handleFrame(f); // handleFrame is async; fire-and-forget
    });
    await window.api.previewSw.open({ streamId: this.streamId, path: this.sourcePath });
    if (this._disposed) return;
    this.ready = true;
  }

  /// Convert one NV12 frame message into a ring bitmap. Async because the
  /// NV12 -> VideoFrame -> ImageBitmap conversion the preload does for the
  /// GPU path happens here instead. A bad NV12 buffer / unsupported
  /// colorSpace must not crash the `onFrame` callback (mirrors
  /// `SourceHandle`'s non-fatal per-frame conversion posture).
  private async handleFrame(f: PreviewSwFrameMsg): Promise<void> {
    if (f.streamId !== this.streamId) return;
    if (this._disposed) return;
    let bmp: ImageBitmap;
    try {
      const vf = new VideoFrame(f.data, {
        format: "NV12",
        codedWidth: f.width,
        codedHeight: f.height,
        timestamp: f.ptsUs,
        colorSpace: this.colorSpaceFor(),
      });
      try {
        bmp = await createImageBitmap(vf);
      } finally {
        vf.close();
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[weftcut/pixi] preview-sw ${this.streamId} frame convert failed:`, e);
      return;
    }
    if (this._disposed) {
      // Disposed during the await — drop the bitmap rather than leak it.
      bmp.close?.();
      return;
    }
    // ptsUs is already source-normalized microseconds (Rust's
    // `pts_to_source_us`, mirroring the renderer's `frameToSourceUs`) — no
    // further offset needed before pushing into the ring.
    this.ring.push(bmp, f.ptsUs, f.durUs);
    if (!this.firedFirstFrame) {
      this.firedFirstFrame = true;
      this.onFirstFrameCb?.();
      this.onFirstFrameCb = null;
    }
  }

  /// Build a `VideoColorSpaceInit` from the source's already-mapped
  /// `sourceColor` (WebCodecs `VideoColorSpaceInit`, derived at open time via
  /// `ffprobeColorToWebCodecs`), falling back to bt709/limited — the same HD
  /// default the WebCodecs path lands on. Mirrors
  /// `NativeGpuSourceHandle.deriveColorSpace`'s logic (same precedence, same
  /// default), just returning the `fullRange: boolean` shape `new
  /// VideoFrame` needs instead of `PreviewGpuColorSpace`'s `range: "full" |
  /// "limited"` string.
  ///
  /// Deliberately does NOT read the per-frame `f.color*` tags: those are
  /// raw FFmpeg `.name()` strings (e.g. `bt2020nc`, `smpte2084`,
  /// `arib-std-b67`), not valid WebCodecs enum members (`bt2020-ncl`, `pq`,
  /// `hlg`) — casting them straight into a `VideoColorSpaceInit` would fork
  /// the app's single color model and, for a wide-gamut/HDR source, throw
  /// inside `new VideoFrame` (silently dropping the frame). Every other
  /// decode path derives colorSpace from the mapped `sourceColor` only.
  private colorSpaceFor(): VideoColorSpaceInit {
    const sc = this.sourceColor;
    return {
      primaries: sc?.primaries ?? "bt709",
      transfer: sc?.transfer ?? "bt709",
      matrix: sc?.matrix ?? "bt709",
      fullRange: sc?.fullRange ?? false,
    };
  }

  /// Nudge the native session's decode target toward `tUs`. Fire-and-forget
  /// `send` (Task 5's preload) — no async round-trip to coalesce behind, so
  /// this only needs a cheap same-target dedup rather than
  /// `NativeGpuSourceHandle`'s in-flight coalescing pump.
  async requestFrameAt(tUs: number): Promise<void> {
    if (!this.ready) await this.ensureReady();
    this.lastUseMs = performance.now();
    if (this._disposed) return;
    if (tUs === this.lastSentTargetUs) return;
    this.lastSentTargetUs = tUs;
    window.api.previewSw.requestFrameAt({ streamId: this.streamId, targetUs: tUs });
  }

  /// `nowMs` from the pool's sweep tick. Returns true if this handle has
  /// been idle longer than the dispose threshold. Mirrors
  /// `NativeGpuSourceHandle.isIdle` / `SourceHandle.isIdle`.
  isIdle(nowMs: number): boolean {
    return this.lastUseMs > 0 && nowMs - this.lastUseMs > IDLE_DISPOSE_MS;
  }

  /// Whether the ring's lookahead window is satisfied. Dev `PerfHUD`.
  isLookaheadFull(): boolean {
    return this.ring.isLookaheadFull();
  }

  /// Tear down: unsubscribe from frame events, close the native session
  /// (main closes the decode thread), and drop cached frames. Safe even if
  /// `ensureReady` never completed.
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.unsub?.();
    this.unsub = null;
    void window.api.previewSw.close({ streamId: this.streamId });
    this.ring.dispose();
    this.onFirstFrameCb = null;
  }
}
