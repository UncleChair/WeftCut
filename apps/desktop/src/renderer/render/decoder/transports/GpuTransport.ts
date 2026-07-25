// Native-GPU `DecodeTransport` — the MessagePort + shared-texture path.
// Extracted from the original native-GPU decode handle (Stage 2 of
// decode-bench; see docs/decode-bench.md
// for the full transport recap): `window.api.previewGpu.{open,requestFrameAt,close,
// requestPort}` are the only IPC-shaped calls; they carry session commands,
// never frame bytes. Decoded frames (and eof/error pokes) arrive on a
// `MessagePort` the PRELOAD hands to this main-world context via
// `window.postMessage` in response to `requestPort()` — a port can't cross
// `contextBridge` itself. The `message` listener MUST be attached before
// calling `requestPort()`, or the one-time handoff can be missed.
//
// This is the transport half only — no FrameRing, no first-frame/fatal-error
// hooks, no idle bookkeeping. Those stay with `FfmpegSource` (the caller),
// which owns exactly one `DecodeTransport` at a time.
import type { PreviewGpuColorSpace } from "../../../../shared/ipc";
import type { DecodeTransport, DecodeTransportOpen } from "./DecodeTransport";

/// How long to wait for the preload's port handoff before `open()` rejects.
/// Generous — this is a one-time same-process `postMessage` round-trip, not a
/// decode operation, so a real failure (preload never wired, requestPort a
/// no-op) should surface quickly rather than hang the caller indefinitely.
const PORT_TIMEOUT_MS = 5_000;

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

export class GpuTransport implements DecodeTransport {
  /// Stream identity supplied by the caller's `open()` call, stamped on every
  /// `previewGpu` call and every port message this transport should accept.
  /// FfmpegSource mints a fresh id per open, so no local uniqueness suffix is
  /// needed here (unlike the old handle's ctor-derived `native-gpu:` prefix).
  private streamId = "";

  private port: MessagePort | null = null;
  private messageListener: ((ev: MessageEvent) => void) | null = null;
  /// Resolves `open()`'s wait for the port handoff. Cleared once fired so a
  /// stray second `message` event (shouldn't happen — `requestPort()` is only
  /// called once per transport) can't double-resolve.
  private portReadyResolve: (() => void) | null = null;
  private portReadyP: Promise<void> | null = null;

  private _disposed = false;

  private frameCb: ((bitmap: ImageBitmap, ptsUs: number, durUs: number) => void) | null = null;
  private errorCb: ((reason: string) => void) | null = null;
  private eofCb: (() => void) | null = null;

  /// Trailing coalescer state: the latest requested target not yet sent, and
  /// whether a `previewGpu.requestFrameAt` call is currently awaited. Mirrors
  /// `ScrubCoalescer`'s intent (see scrub.ts) at a much smaller scale — this
  /// only needs "at most one in-flight, latest wins", not scrub's
  /// debounce/ceiling timers.
  private pendingTargetUs: number | null = null;
  private requestInFlight = false;

  /// Wire the port handoff, then open the native session. Throws on failure
  /// (port-handoff timeout, or `previewGpu.open` rejecting — most commonly
  /// `hw-budget-exceeded`); the caller (`FfmpegSource`) decides whether that's
  /// recoverable.
  async open(o: DecodeTransportOpen): Promise<void> {
    this.streamId = o.streamId;
    // Attach BEFORE requestPort() — the preload's handoff post is one-time
    // and un-replayable; a listener attached after the call could miss it.
    //
    // LANDMINE: `window.postMessage` is a BROADCAST, so every live transport's
    // listener sees every handoff. Without the `data.streamId` match below, a
    // second session opening would make THIS transport adopt that session's port
    // (and re-point its `onmessage`), so our frames would arrive on a port whose
    // handler filters them out by streamId — a silent, permanent freeze of every
    // session but the newest. Match our own id; ignore the rest.
    this.messageListener = (ev: MessageEvent) => {
      const data = ev.data as
        | { __weftcutPreviewGpu?: string; streamId?: string }
        | null
        | undefined;
      if (!data || data.__weftcutPreviewGpu !== "port") return;
      if (data.streamId !== this.streamId) return;
      const port = ev.ports?.[0];
      if (!port) return;
      this.port = port;
      this.port.onmessage = (m: MessageEvent) => this.handlePortMessage(m.data as PortMsg);
      this.portReadyResolve?.();
      this.portReadyResolve = null;
    };
    window.addEventListener("message", this.messageListener);
    window.api.previewGpu.requestPort(this.streamId);
    await this.waitForPort();
    if (this._disposed) return;
    // The configured poolSize (default 3) mirrors the WebCodecs path's
    // headroom (a couple of lookahead frames in flight plus one being read)
    // without asking the native pool for more slots than preview actually
    // pipelines.
    await window.api.previewGpu.open({
      streamId: this.streamId,
      path: o.path,
      poolSize: o.poolSize ?? 3,
      colorSpace: deriveColorSpace(o.sourceColor),
    });
  }

  private waitForPort(): Promise<void> {
    if (this.port) return Promise.resolve();
    if (!this.portReadyP) {
      this.portReadyP = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(`GpuTransport ${this.streamId}: timed out waiting for MessagePort handoff`),
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
  /// defensive: the port is now per-stream, so a foreign message shouldn't
  /// arrive at all; if one does, drop it WITHOUT leaking its bitmap (a 4K
  /// ImageBitmap per frame is not a survivable leak).
  private handlePortMessage(data: PortMsg): void {
    if (!data || data.streamId !== this.streamId) {
      if (data && data.kind === "frame") data.bitmap?.close?.();
      return;
    }
    if (data.kind === "frame") {
      if (this._disposed) {
        // Late frame after teardown — drop it, returning the bitmap's
        // backing resources rather than leaking them.
        data.bitmap?.close?.();
        return;
      }
      this.frameCb?.(data.bitmap, data.ptsUs, data.durUs);
    } else if (data.kind === "eof") {
      this.eofCb?.();
    } else if (data.kind === "error") {
      this.errorCb?.(data.message);
    }
  }

  onFrame(cb: (bitmap: ImageBitmap, ptsUs: number, durUs: number) => void): void {
    this.frameCb = cb;
  }

  onError(cb: (reason: string) => void): void {
    this.errorCb = cb;
  }

  onEof(cb: () => void): void {
    this.eofCb = cb;
  }

  /// Nudge the native session's decode target toward `tUs`. Coalesces: while
  /// a `previewGpu.requestFrameAt` call is in flight, only the most recent
  /// target is remembered and sent once the current call settles — callers
  /// firing every tick (Compositor, decode-bench) never queue more than one
  /// extra IPC round-trip.
  requestFrameAt(tUs: number): void {
    if (this._disposed) return;
    this.pendingTargetUs = tUs;
    if (this.requestInFlight) return;
    void this.pumpRequests();
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

  /// Tear down: stop listening for port traffic, close the native session
  /// (preload releases its shared-texture imports, main closes the native
  /// decode thread). Safe even if `open()` never completed (e.g. the port
  /// handoff timed out).
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
  }
}
