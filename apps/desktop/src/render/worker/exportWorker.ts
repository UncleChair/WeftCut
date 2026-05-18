// Web Worker entry point for export. Receives an ExportRequest,
// constructs a Compositor against an OffscreenCanvas, runs the
// sequential decode → composite → encode loop, posts progress, posts
// the muxed MP4 bytes back, and exits.
//
// Plan: docs/pixi-renderer-plan.md (P8)
//
// P0 stub. P8 implements the loop. This file establishes the message
// protocol shape so the main-thread harness can be written against it.

import type { ExportRequest, ExportEvent } from "./protocol";

function post(ev: ExportEvent, transfer: Transferable[] = []): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (self as any).postMessage(ev, transfer);
}

self.onmessage = (e: MessageEvent<ExportRequest>) => {
  const req = e.data;
  if (req.type === "start") {
    // P8: real impl.
    post({ type: "error", message: "exportWorker: not yet implemented (P8)" });
  } else if (req.type === "cancel") {
    // P8: signal in-flight encode loop to stop.
  }
};

// Ready handshake so the main thread knows the Worker has parsed and
// the message handler is attached.
post({ type: "ready" });
