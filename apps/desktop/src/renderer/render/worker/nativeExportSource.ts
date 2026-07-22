// The export Worker's native-decode source handle. Implements the same
// `ExportDecodeSession` contract the WebCodecs `ExportSourceHandle` does, so the
// export driving loop (dispatch → consume → evict) drives it identically — but
// instead of decoding a proxy with WebCodecs it consumes NV12 (8-bit) or
// I420P10 (10-bit) frames a main-process `NativeDecode` session produces from
// the ORIGINAL (a WebCodecs-blind codec, e.g. ProRes), shuttled in over the
// frame relay.
//
// Backpressure is a CREDIT WINDOW: the producer parks after `creditWindow`
// frames are in flight; the handle returns exactly one credit per frame that
// has LEFT the ring (consumed / evicted / freed), so the total in flight stays
// bounded and never starves the producer. See `reconcileCredits`.

import type { ExportColorDiag } from "../decoder/ExportDecoderPool";
import { ExportFrameStore } from "../decoder/ExportDecoderPool";
import { nv12FrameFromBytes, type NativeNv12Frame } from "../decoder/nv12Frame";
import type { ExportDecodeSession, SourceHandleInit } from "../decoder/session";
import { tenBitFrameFromBytes, type TenBitFrame } from "../decoder/tenBitFrame";
import type { ExportTransportFormat } from "../exportDecodeRouting";
import { getNativeDecodeRelay, type NativeDecodeRelayClient } from "./nativeDecodeRelay";
import type { NativeDecodeFrameMsg } from "./protocol";

/// Module counter for a realm-safe unique `sessionId`. Math.random / Date.now
/// are banned/absent in some realms; a monotonic counter is deterministic and
/// sufficient (one handle = one session for its lifetime).
let seq = 0;

/// Build the `VideoColorSpaceInit` stamped on every frame from the source's
/// already-mapped `sourceColor` (WebCodecs enums, derived at export start via
/// `ffprobeColorToWebCodecs`), falling back to bt709/limited — the same posture
/// as the preview native path (`SwTransport.colorSpaceFor`).
///
/// LANDMINE: must NOT read the per-frame `colorMatrix`/`colorTransfer`/… tags.
/// Those are raw FFmpeg `.name()` strings (e.g. `bt2020nc`, `smpte2084`,
/// `arib-std-b67`), not valid WebCodecs enum members (`bt2020-ncl`, `pq`,
/// `hlg`) — they would fork the app's single color model, and the ingest
/// shaders' `coefForMatrix` matches WebCodecs enum members only.
function colorSpaceFromSource(sourceColor: VideoColorSpaceInit | undefined): VideoColorSpaceInit {
  return {
    primaries: sourceColor?.primaries ?? "bt709",
    transfer: sourceColor?.transfer ?? "bt709",
    matrix: sourceColor?.matrix ?? "bt709",
    fullRange: sourceColor?.fullRange ?? false,
  };
}

export class NativeExportSourceHandle implements ExportDecodeSession {
  readonly mediaId: string;
  readonly ring: ExportFrameStore;
  private readonly relay: NativeDecodeRelayClient;
  private readonly sessionId: string;
  private readonly sourcePath: string;
  private readonly outFormat: ExportTransportFormat;
  private readonly creditWindow: number;
  /// ColorSpace stamped on every pushed frame — fixed per handle
  /// (one handle = one source), see `colorSpaceFromSource`.
  private readonly frameColorSpace: VideoColorSpaceInit;
  /// `aUs` of the previous `decodeRange`; `aUs < lastRangeAUs` is a backward
  /// clip-reuse jump — the only case that must reset the ring's EOS clamp.
  private lastRangeAUs = Number.NEGATIVE_INFINITY;

  private readyP: Promise<void> | null = null;

  /// Credit accounting (see `reconcileCredits`). `framesPushed`: frames ever
  /// pushed into the ring; `creditsReturned`: credits already handed back.
  private framesPushed = 0;
  private creditsReturned = 0;
  private _disposed = false;

  /// Aggregated into the export `done` perf payload. `dispatchedTotal` mirrors
  /// the WebCodecs handle's "work fed" counter (here: frames received);
  /// `firstFrameDiag` captures the first frame's color tags for the E2E harness.
  dispatchedTotal = 0;
  firstFrameDiag: ExportColorDiag | null = null;

  constructor(init: SourceHandleInit, relay: NativeDecodeRelayClient = getNativeDecodeRelay()) {
    this.mediaId = init.mediaId;
    const ne = init.nativeExport!;
    this.sourcePath = ne.sourcePath;
    this.outFormat = ne.outFormat;
    this.creditWindow = ne.creditWindow;
    this.frameColorSpace = colorSpaceFromSource(init.sourceColor);
    // Unique, realm-safe, stable for this handle's lifetime.
    this.sessionId = `nd-${seq++}-${init.mediaId}-${init.handleKey ?? init.mediaId}`;
    this.ring = new ExportFrameStore();
    this.relay = relay;
    this.relay.register(this.sessionId, {
      onFrame: (f) => this.onFrame(f),
      onRangeEnd: (aUs, bUs) => this.onRangeEnd(aUs, bUs),
      onEnded: () => this.onEnded(),
      onError: (m) => this.onError(m),
    });
  }

  get disposed(): boolean {
    return this._disposed;
  }

  ensureReady(): Promise<void> {
    if (this.readyP) return this.readyP;
    // Open the native session (spawns its decode thread). Its reply — dims,
    // color tags, startPtsUs — is intentionally discarded: frames carry their
    // own dims and an already-source-normalized `ptsUs` (the napi subtracted
    // startPtsUs), and color is captured per-frame into `firstFrameDiag`. We
    // await only to guarantee the session exists before the first decodeRange.
    this.readyP = this.relay
      .open(this.sessionId, this.sourcePath, this.outFormat, this.creditWindow)
      .then(() => undefined);
    return this.readyP;
  }

  /// Dispatch a decode range, then RESOLVE IMMEDIATELY. Awaiting frames or
  /// rangeEnd here would deadlock the credit window: the producer parks after
  /// `creditWindow` frames, and credits are only returned by the 6b consume
  /// loop, which runs AFTER 6a's decodeRange returns. Mirrors the WebCodecs
  /// `ExportSourceHandle.decodeRange` dispatch-then-return shape.
  async decodeRange(aUs: number, bUs: number): Promise<void> {
    await this.ensureReady();
    if (this._disposed) return;
    // Backward clip-reuse jump starts a new decode generation. Frames and
    // finality proofs from the prior generation cannot satisfy its targets;
    // release them (and their credits) before the Rust session re-seeks.
    if (aUs < this.lastRangeAUs) {
      this.ring.flush();
      this.reconcileCredits();
      this.ring.clearEosDrain();
    }
    this.lastRangeAUs = aUs;
    this.relay.decodeRange(this.sessionId, Math.round(aUs), Math.round(bUs));
  }

  evictBefore(cutoffUs: number): void {
    this.ring.evictBefore(cutoffUs);
    this.reconcileCredits();
  }

  /// Return one credit per frame that has LEFT the ring by ANY path (evict, the
  /// ring's push/waitForPts `freeBehindWaiters`, or EOS flush) and not yet been
  /// credited: `framesPushed - ring.size()` = frames that have departed. This
  /// keeps the total in flight (Rust-buffered + relay + resident-in-ring) ≤
  /// creditWindow so memory is bounded, and never accrues a deficit that would
  /// starve the producer. Called after every push and every evictBefore.
  private reconcileCredits(): void {
    if (this._disposed) return;
    const owed = this.framesPushed - this.ring.size() - this.creditsReturned;
    if (owed > 0) {
      this.relay.returnCredit(this.sessionId, owed);
      this.creditsReturned += owed;
    }
  }

  private onFrame(frame: NativeDecodeFrameMsg): void {
    if (this._disposed) return;
    // A frame whose format contradicts the session's outFormat means the Rust
    // session and this handle disagree about the transport — fail the ring
    // (the export aborts) rather than misinterpret the plane bytes.
    if (frame.format !== this.outFormat) {
      this.ring.fail(
        `native frame format ${frame.format} contradicts session outFormat ${this.outFormat}`,
      );
      return;
    }
    if (frame.format === "I420P10") {
      this.onTenBitFrame(frame);
      return;
    }
    // The NV12 lane: wrap the transferred bytes as a `NativeNv12Frame` —
    // ZERO-COPY, NO VideoFrame — and push it; the Compositor converts it via
    // `Nv12Ingest`. LANDMINE: never route these through `new VideoFrame` +
    // drawImage — Chromium converts buffer-defined NV12 as BT.601 (see
    // nv12Frame.ts).
    const colorSpace = this.frameColorSpace;
    let nv12: NativeNv12Frame;
    try {
      nv12 = nv12FrameFromBytes({
        data: new Uint8Array(frame.data),
        width: frame.width,
        height: frame.height,
        timestamp: frame.ptsUs,
        duration: frame.durUs,
        colorSpace,
      });
    } catch (e) {
      this.ring.fail(e instanceof Error ? e.message : String(e));
      return;
    }
    // Capture the color diagnostic off the FIRST frame BEFORE push (the ring
    // may close a frame during push's `freeBehindWaiters`).
    if (!this.firstFrameDiag) {
      this.firstFrameDiag = {
        mediaId: this.mediaId,
        configColor: colorSpace,
        frameColor: colorSpace,
        frameFormat: "NV12",
      };
    }
    // Frames arrive source-normalized; push with the frame's own ptsUs.
    this.ring.push(nv12, frame.ptsUs);
    this.framesPushed++;
    this.dispatchedTotal++;
    this.reconcileCredits();
  }

  /// The I420P10 lane: wrap the transferred bytes as a `TenBitFrame` — ZERO-COPY,
  /// no VideoFrame round-trip — and push it; the Compositor consumes it via the
  /// same `TenBitIngest` path as `copyToTenBit` output. The factory throws on a
  /// byteLength/layout mismatch (Rust/TS drift); route that to `ring.fail` so it
  /// aborts the export through the standard waiter-rejection path.
  private onTenBitFrame(frame: NativeDecodeFrameMsg): void {
    const colorSpace = this.frameColorSpace;
    let tenBit: TenBitFrame;
    try {
      tenBit = tenBitFrameFromBytes({
        data: new Uint8Array(frame.data),
        width: frame.width,
        height: frame.height,
        timestamp: frame.ptsUs,
        duration: frame.durUs,
        colorSpace,
      });
    } catch (e) {
      this.ring.fail(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!this.firstFrameDiag) {
      this.firstFrameDiag = {
        mediaId: this.mediaId,
        configColor: colorSpace,
        frameColor: colorSpace,
        frameFormat: "I420P10",
      };
    }
    this.ring.push(tenBit, frame.ptsUs);
    this.framesPushed++;
    this.dispatchedTotal++;
    this.reconcileCredits();
  }

  /// Ordered range completion is a presentation-finality proof: every frame
  /// in `[aUs, bUs]` arrived before this signal, so quantized targets in the
  /// range no longer need an out-of-range lookahead frame to settle.
  private onRangeEnd(aUs: number, bUs: number): void {
    this.ring.completeRange(aUs, bUs);
  }

  /// End of stream: let the ring clamp any grid-overrun waiters to the last held
  /// frame. Safe by construction: control signals ride the same ordered
  /// per-session channel as frames end-to-end (see `ExportSwMsg` in shared/ipc),
  /// so every frame emitted before the `ended` has already been delivered when
  /// this runs — the clamp can never swallow an in-flight tail frame.
  private onEnded(): void {
    this.ring.beginEosDrain();
    this.ring.finishEosDrain();
  }

  /// A mid-decode native failure rejects pending ring waiters → surfaces via the
  /// existing ring-failure export-abort path (`waitForPts` rejects).
  private onError(msg: string): void {
    this.ring.fail(msg);
  }

  /// Export drives decoding via `decodeRange`; the Compositor's per-tick nudge
  /// is a no-op here (matches ExportSourceHandle).
  requestFrameAt(_tUs: number): Promise<void> {
    return Promise.resolve();
  }

  /// Export composites synchronously; no first-frame repaint.
  onFirstFrame(_cb: () => void): void {
    // intentional no-op
  }

  dispose(): void {
    if (this._disposed) return; // idempotent
    // Set disposed FIRST so a late frame's onFrame / reconcileCredits no-ops.
    this._disposed = true;
    this.relay.close(this.sessionId);
    this.relay.unregister(this.sessionId);
    this.ring.dispose();
  }
}
