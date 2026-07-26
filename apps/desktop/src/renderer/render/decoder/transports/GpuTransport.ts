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
import type {
  HwBarrierMode,
  PreviewGpuColorSpace,
  PreviewGpuSlotAck,
} from "../../../../shared/ipc";
import type { DecodeTransport, DecodeTransportOpen } from "./DecodeTransport";
import {
  HandoffTimings,
  type FenceHandoffStats,
  type HandoffTimingSummary,
} from "./handoffTimings";
import { sharedSlotFenceQueue } from "./slotFenceQueue";

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
  /// The read-completion barrier, stamped directly around the drain rather than
  /// derived from the other three. `barrierMs` is the TOTAL for whichever
  /// barrier mode the preload ran; the other two split it into its GPU-copy and
  /// CPU-read phases (see `BarrierCost` in preload/index.ts — the readback's two
  /// halves are not separable from the total alone).
  barrierMs?: number;
  barrierDrawMs?: number;
  barrierReadMs?: number;
  /// The barrier that actually RAN for this frame, which is not always the one
  /// configured: the preload falls back from `gpuflush` to `readback` when
  /// WebGL2 is missing. A bench leg labelled by intent instead of by outcome
  /// silently reports the wrong variant's cost.
  barrierApplied?: HwBarrierMode;
  /// Health of the deferred-ack fence path, present only while it is running.
  /// The wait it defers is NOT in `barrierMs` — that stays the blocking cost, so
  /// a mechanism that MOVED the cost can't read as one that removed it. The one
  /// exception is `forcedWaitMsTotal`: a deadline spin IS blocking, and reading
  /// barrier cost without it understates the path to near zero.
  fence?: FenceHandoffStats;
  /// Set under `rendererFence`: the preload ran NO barrier on this bitmap and
  /// will NOT ack its slot. Delivering the frame transferred that obligation
  /// here, and it is unconditional — a frame this transport never paints (ring
  /// eviction, a suspended compositor) holds a slot just the same, and
  /// `pool_size` stranded slots wedge the session for good. The barrier stamps
  /// above are absent on such a message for the same reason they are stamped at
  /// all: only this side knows which rung of its ladder ran.
  ackDelegated?: boolean;
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

  /// Rolling window over the preload's per-frame handoff stamps. The barrier
  /// cost it derives is the one number this path never surfaced.
  private readonly timings = new HandoffTimings();

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
  /// ImageBitmap per frame is not a survivable leak). A delegated ack dies with
  /// such a frame, which is tolerable only because reaching here at all would
  /// mean the preload routed another stream's frame onto this port — the
  /// impossibility this guard is defensive about, not a live failure mode.
  private handlePortMessage(data: PortMsg): void {
    if (!data || data.streamId !== this.streamId) {
      if (data && data.kind === "frame") data.bitmap?.close?.();
      return;
    }
    if (data.kind === "frame") {
      if (this._disposed) {
        // Late frame after teardown — drop it, returning the bitmap's
        // backing resources rather than leaking them. Deliberately NOT acked:
        // dispose() has already dropped this stream's pending slots and asked
        // main to close, and an ack into a mid-closing session is what that
        // ordering exists to prevent.
        data.bitmap?.close?.();
        return;
      }
      // The barrier stamps come from whichever side actually ran one. Under
      // `rendererFence` that is HERE, so the preload's zeroes must not be the
      // ones recorded — a leg would then read as barrier-free when a barrier
      // ran, which is the false PASS `barrierApplied` exists to stop.
      let barrierMs = data.barrierMs;
      let barrierDrawMs = data.barrierDrawMs;
      let barrierReadMs = data.barrierReadMs;
      let barrierApplied = data.barrierApplied;
      let fence = data.fence;
      if (data.ackDelegated === true) {
        const queue = sharedSlotFenceQueue();
        // Before `frameCb`, and unconditionally: the slot's release cannot
        // depend on the ring keeping the frame, or on anything painting it.
        const applied = queue.submit(this.streamId, data.slot, data.bitmap, () =>
          this.postSlotAck(data.slot),
        );
        barrierApplied = applied.applied;
        barrierDrawMs = applied.drawMs;
        barrierReadMs = applied.readMs;
        barrierMs = applied.drawMs + applied.readMs;
        fence = queue.stats(this.streamId);
        // A frame arriving is the wake-up the already-queued slots were waiting
        // for; doing it here costs no scheduling, and the pump only covers gaps.
        queue.drain();
      }
      this.timings.record(
        data.gvfMs,
        data.cibMs,
        data.residentMs,
        barrierMs,
        barrierDrawMs,
        barrierReadMs,
        barrierApplied,
        fence,
      );
      this.frameCb?.(data.bitmap, data.ptsUs, data.durUs);
    } else if (data.kind === "eof") {
      this.eofCb?.();
    } else if (data.kind === "error") {
      this.errorCb?.(data.message);
    }
  }

  /// Release one slot back up the port (`rendererFence` only). The port is read
  /// LIVE, not captured: `dispose()` nulls it, and this is the second line of
  /// defence behind dropping the pending slots — neither an ack nor a poke may
  /// reach a session main is mid-closing.
  private postSlotAck(slot: number): void {
    const ack: PreviewGpuSlotAck = { kind: "consumeAck", streamId: this.streamId, slot };
    this.port?.postMessage(ack);
  }

  /// Preload handoff timings for this session, or null before the first
  /// instrumented frame. Diagnostics only — nothing decides on it.
  handoffTimings(): HandoffTimingSummary | null {
    return this.timings.summary();
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
    // Drop this stream's un-acked slots WITHOUT acking, BEFORE the port goes and
    // before main is asked to close — the renderer-side half of the ordering the
    // preload's `closePreviewGpuStream` keeps from its end. The native close
    // joins the decode thread, so the slots cease to exist with it.
    sharedSlotFenceQueue().dropFor(this.streamId);
    if (this.port) {
      this.port.onmessage = null;
      this.port = null;
    }
    void window.api.previewGpu.close({ streamId: this.streamId });
  }
}
