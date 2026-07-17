// Native-SOFTWARE `DecodeTransport` — the per-frame NV12-over-IPC path
// (transport recap: docs/superpowers/specs/
// 2026-07-05-ffmpeg-sw-decode-blindspot-design.md).
// `window.api.previewSw.{open,requestFrameAt,close}` carry session commands
// only. Decoded frames arrive as plain NV12 byte buffers
// directly over the contextBridge (no shared texture, no MessagePort — a
// `previewSw:frame` IPC event per frame), delivered via `onFrame`.
//
// Frames are wrapped ZERO-COPY as `NativeNv12Frame`s — never reconstructed as
// `VideoFrame`s: Chromium's software conversion of a buffer-defined NV12 frame
// applies BT.601 regardless of the stamped colorSpace (see nv12Frame.ts /
// ADR 0032), so the Compositor converts these in its own `Nv12Ingest` pass.
//
// preview_sw sends no eof/error to the renderer mid-stream (log-only in
// main) — `onError` fires ONLY on `open()` failure, and `onEof` is a
// no-op subscription kept solely to satisfy the `DecodeTransport` interface.
//
// This is the transport half only — no FrameRing, no first-frame/fatal-error
// hooks, no idle bookkeeping. Those stay with `FfmpegSource` (the caller),
// which owns exactly one `DecodeTransport` at a time and sets the ring's
// eviction anchor itself (see `requestFrameAt` below).
import type { PreviewSwFrameMsg } from "../../../../shared/ipc";
import { nv12FrameFromBytes } from "../nv12Frame";
import type { DecodeTransport, DecodeTransportOpen, TransportFrame } from "./DecodeTransport";

export class SwTransport implements DecodeTransport {
  /// Stream identity supplied by the caller's `open()` call, stamped on every
  /// `previewSw` call and every frame message this transport should accept.
  private streamId = "";

  /// Source ffprobe color tags, for `colorSpaceFor`.
  private sourceColor: VideoColorSpaceInit | undefined;

  private unsub: (() => void) | null = null;

  private _disposed = false;

  private frameCb: ((frame: TransportFrame, ptsUs: number, durUs: number) => void) | null = null;
  private errorCb: ((reason: string) => void) | null = null;

  /// Last target sent to `previewSw.requestFrameAt`, for cheap same-target
  /// dedup. Unlike `GpuTransport`'s coalescing pump, the transport here is a
  /// fire-and-forget `send`, so there is no async round-trip to coalesce
  /// behind.
  private lastSentTargetUs: number | null = null;

  /// Subscribe to the frame event, then open the native session. Throws on
  /// failure (`previewSw.open` rejecting); the caller (`FfmpegSource`)
  /// decides whether that's recoverable.
  async open(o: DecodeTransportOpen): Promise<void> {
    this.streamId = o.streamId;
    this.sourceColor = o.sourceColor;
    // Subscribe BEFORE open() — frames can start flowing as soon as the
    // native decode thread is up, so a listener attached after open() could
    // miss an early frame.
    this.unsub = window.api.previewSw.onFrame((f) => this.handleFrame(f));
    try {
      await window.api.previewSw.open({ streamId: this.streamId, path: o.path });
    } catch (err) {
      // Open failure: surface it as the terminal error BEFORE rethrowing —
      // this is the ONLY SW error signal (see file header).
      const reason = err instanceof Error ? err.message : String(err);
      // A late open-rejection after dispose must not fire a stale fatal into a
      // consumer that has already moved on (mirrors the old handle's fireFatal
      // _disposed guard). Still rethrow so the caller's await settles.
      if (!this._disposed) this.errorCb?.(reason);
      throw err;
    }
  }

  /// Wrap one NV12 frame message as a `NativeNv12Frame` — zero-copy: the
  /// structured-cloned IPC bytes are adopted as the frame's planes. A
  /// layout-drifted buffer (nv12FrameFromBytes throws) must not crash the
  /// `onFrame` callback (mirrors the GPU transport's non-fatal posture for a
  /// bad port message).
  private handleFrame(f: PreviewSwFrameMsg): void {
    if (f.streamId !== this.streamId) return;
    if (this._disposed) return;
    let frame: TransportFrame;
    try {
      frame = nv12FrameFromBytes({
        data: f.data,
        width: f.width,
        height: f.height,
        timestamp: f.ptsUs,
        duration: f.durUs,
        colorSpace: this.colorSpaceFor(),
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[weftcut/pixi] preview-sw ${this.streamId} frame wrap failed:`, e);
      return;
    }
    // ptsUs is already source-normalized microseconds (Rust's
    // `pts_to_source_us`, mirroring the renderer's `frameToSourceUs`) — no
    // further offset needed before handing it to the caller.
    this.frameCb?.(frame, f.ptsUs, f.durUs);
  }

  /// Build a `VideoColorSpaceInit` from the source's already-mapped
  /// `sourceColor` (WebCodecs `VideoColorSpaceInit`, derived at open time via
  /// `ffprobeColorToWebCodecs`), falling back to bt709/limited — the same HD
  /// default the WebCodecs path lands on.
  ///
  /// Deliberately does NOT read the per-frame `f.color*` tags: those are raw
  /// FFmpeg `.name()` strings (e.g. `bt2020nc`, `smpte2084`, `arib-std-b67`),
  /// not valid WebCodecs enum members (`bt2020-ncl`, `pq`, `hlg`) — casting
  /// them straight into a `VideoColorSpaceInit` would fork the app's single
  /// color model and, for a wide-gamut/HDR source, throw inside `new
  /// VideoFrame` (silently dropping the frame). Every other decode path
  /// derives colorSpace from the mapped `sourceColor` only.
  private colorSpaceFor(): VideoColorSpaceInit {
    const sc = this.sourceColor;
    return {
      primaries: sc?.primaries ?? "bt709",
      transfer: sc?.transfer ?? "bt709",
      matrix: sc?.matrix ?? "bt709",
      fullRange: sc?.fullRange ?? false,
    };
  }

  onFrame(cb: (frame: TransportFrame, ptsUs: number, durUs: number) => void): void {
    this.frameCb = cb;
  }

  onError(cb: (reason: string) => void): void {
    this.errorCb = cb;
  }

  /// No-op subscription: preview_sw never emits eof to the renderer (see file
  /// header). Kept only to satisfy the `DecodeTransport` interface.
  onEof(_cb: () => void): void {
    // intentionally empty
  }

  /// Nudge the native session's decode target toward `tUs`. Fire-and-forget
  /// `send` — no async round-trip to coalesce behind, so this only needs a
  /// cheap same-target dedup rather than `GpuTransport`'s in-flight
  /// coalescing pump. Does NOT touch a ring anchor — the ring lives on
  /// `FfmpegSource`, which sets its own anchor before/around calling this.
  requestFrameAt(tUs: number): void {
    if (this._disposed) return;
    if (tUs === this.lastSentTargetUs) return;
    this.lastSentTargetUs = tUs;
    window.api.previewSw.requestFrameAt({ streamId: this.streamId, targetUs: tUs });
  }

  /// Tear down: unsubscribe from frame events, close the native session
  /// (main closes the decode thread). Safe even if `open()` never completed.
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.unsub?.();
    this.unsub = null;
    window.api.previewSw.close({ streamId: this.streamId });
  }
}
