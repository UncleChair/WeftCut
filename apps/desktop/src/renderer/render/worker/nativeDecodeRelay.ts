// Worker-scoped relay client for the native export-decode session. The export
// Worker's `NativeExportSourceHandle` talks to the main-process `NativeDecode`
// session THROUGH this singleton: it posts `nd:*` commands (ExportEvent) up the
// Worker's own postMessage channel to the renderer main thread (runExport.ts),
// which forwards them to `window.api.exportSw.*`; inbound frames + control
// signals (ExportRequest `nd:*`) come back down the same channel and are
// demuxed here to the per-session sink by `sessionId`.
//
// LANDMINE: exportWorker.ts owns `self.onmessage` (start / cancel / chunk-ack).
// This relay must NOT reassign it — it subscribes with `self.addEventListener`
// so both coexist, and acts ONLY on `nd:*` messages (silently ignoring the
// Worker's own protocol, which shares the channel).
//
// LANDMINE: LAZY singleton. NOTHING at module top level may touch `self`,
// `postMessage`, or `VideoFrame`: the node vitest suites import the export pool,
// which transitively imports this module. Every realm-bound access lives inside
// `getNativeDecodeRelay()` / the class it constructs.

import type {
  ExportEvent,
  ExportRequest,
  NativeDecodeFrameMsg,
  NativeDecodeOpenInfo,
} from "./protocol";

/// Per-session inbound callbacks the handle registers. The relay demuxes each
/// inbound `nd:*` message to the matching session's sink by `sessionId`.
export interface NativeDecodeSink {
  onFrame(frame: NativeDecodeFrameMsg): void;
  onRangeEnd(): void;
  onEnded(): void;
  onError(msg: string): void;
}

class NativeDecodeRelay {
  /// Monotonic correlation id for the `nd:open` ⇄ `nd:openResult` handshake.
  private nextReqId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (info: NativeDecodeOpenInfo) => void; reject: (e: Error) => void }
  >();
  private readonly sinks = new Map<string, NativeDecodeSink>();

  constructor() {
    // addEventListener, NOT `self.onmessage` — see the module LANDMINE.
    self.addEventListener("message", (e: MessageEvent) => {
      this.dispatch(e.data as ExportRequest);
    });
  }

  private dispatch(msg: ExportRequest): void {
    switch (msg.type) {
      case "nd:openResult": {
        const p = this.pending.get(msg.reqId);
        if (!p) return;
        this.pending.delete(msg.reqId);
        if (msg.ok) p.resolve(msg.info);
        else p.reject(new Error(msg.error));
        return;
      }
      case "nd:frame":
        this.sinks.get(msg.frame.sessionId)?.onFrame(msg.frame);
        return;
      case "nd:rangeEnd":
        this.sinks.get(msg.sessionId)?.onRangeEnd();
        return;
      case "nd:ended":
        this.sinks.get(msg.sessionId)?.onEnded();
        return;
      case "nd:error":
        this.sinks.get(msg.sessionId)?.onError(msg.message);
        return;
      default:
        // start / cancel / chunk-ack — owned by the Worker's own onmessage.
        return;
    }
  }

  /// Open a native session and resolve with its decoded dimensions + source
  /// color tags. Correlated with `nd:openResult` by a monotonic `reqId`.
  open(
    sessionId: string,
    path: string,
    outFormat: "NV12",
    creditWindow: number,
  ): Promise<NativeDecodeOpenInfo> {
    const reqId = this.nextReqId++;
    const p = new Promise<NativeDecodeOpenInfo>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
    });
    this.post({ type: "nd:open", reqId, sessionId, path, outFormat, creditWindow });
    return p;
  }

  decodeRange(sessionId: string, aUs: number, bUs: number): void {
    this.post({ type: "nd:decodeRange", sessionId, aUs, bUs });
  }

  returnCredit(sessionId: string, credits: number): void {
    this.post({ type: "nd:returnCredit", sessionId, credits });
  }

  close(sessionId: string): void {
    this.post({ type: "nd:close", sessionId });
  }

  register(sessionId: string, sink: NativeDecodeSink): void {
    this.sinks.set(sessionId, sink);
  }

  unregister(sessionId: string): void {
    this.sinks.delete(sessionId);
  }

  private post(ev: ExportEvent): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (self as any).postMessage(ev);
  }
}

let singleton: NativeDecodeRelay | null = null;

/// Lazily construct (and memoize) the Worker's single relay client. The first
/// call wires the `self` message listener; importing this module in node is
/// safe because nothing runs until this is invoked.
export function getNativeDecodeRelay(): NativeDecodeRelay {
  if (!singleton) singleton = new NativeDecodeRelay();
  return singleton;
}

/// Public shape of the relay client (return type of `getNativeDecodeRelay`).
/// The class itself stays unexported so nothing can `new` a second instance.
export type NativeDecodeRelayClient = NativeDecodeRelay;
