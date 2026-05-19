// Web Worker entry point for export. Receives an ExportRequest,
// constructs a Compositor against an OffscreenCanvas, runs the
// sequential decode → composite → encode loop, posts progress, posts
// the muxed MP4 bytes back, and exits.
//
// Plan: docs/pixi-renderer-plan.md (P8)
//
// Limitations (v1 — iterate):
//   - Frame-readiness wait is a simple poll on the FrameRing for
//     each clip's expected PTS. If a clip never produces (decoder
//     stall, unsupported codec), the loop times out per-frame and
//     paints whatever's currently bound (could be wrong / blank).
//   - Audio is OUT — the Worker has no DOM and audio export rides
//     the existing Rust ffmpeg compositor. P9 final mux combines
//     video.mp4 (this output) with audio.m4a.
//   - Templates / Subtitles render paths are absent here too
//     (P5 / P6 not done). VideoClip / ImageOverlay / Color / Text
//     render fine.

import { Application } from "pixi.js";

import type { MediaSummary, ProjectSummary } from "../../ipc";
import { Compositor } from "../Compositor";
import { EncoderSink } from "./encoder";
import type { ExportRequest, ExportEvent } from "./protocol";

function post(ev: ExportEvent, transfer: Transferable[] = []): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (self as any).postMessage(ev, transfer);
}

let cancelled = false;

self.onmessage = (e: MessageEvent<ExportRequest>) => {
  const req = e.data;
  if (req.type === "start") {
    void runExport(req).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error("[weftcut/export] worker threw:", err);
      post({ type: "error", message: msg });
    });
  } else if (req.type === "cancel") {
    cancelled = true;
  }
};

// Ready handshake so the main thread knows the Worker has parsed
// and the message handler is attached.
post({ type: "ready" });

async function runExport(req: Extract<ExportRequest, { type: "start" }>) {
  // 1. Initialize PixiJS Application against the OffscreenCanvas.
  const app = new Application();
  await app.init({
    canvas: req.canvas as unknown as HTMLCanvasElement,
    width: req.project.width,
    height: req.project.height,
    background: 0x000000,
    autoStart: false,
  });

  // 2. Compositor in export mode (no audio host, no DOM dependencies).
  const compositor = new Compositor({
    app,
    width: req.project.width,
    height: req.project.height,
    mode: "export",
    proxyAssetUrl: (mediaId: string) =>
      req.project.proxyAssetUrls[mediaId] ?? null,
    originalAssetUrl: (mediaId: string) =>
      req.project.originalAssetUrls[mediaId] ?? null,
    mediaById: (mediaId: string): MediaSummary | undefined => {
      const d = req.project.mediaDims[mediaId];
      if (!d) return undefined;
      return {
        id: mediaId,
        label: "",
        path: "",
        kind: "",
        duration_us: null,
        width: d.width,
        height: d.height,
        size_bytes: 0,
        available: true,
        proxy_path: null,
      };
    },
  });
  compositor.setProject(req.project.summary as ProjectSummary);
  compositor.setMasterPlayState(false);

  // 3. Encoder pipeline.
  const encoder = new EncoderSink({
    config: req.encoderConfig,
    width: req.project.width,
    height: req.project.height,
    fpsNum: req.project.fpsNum,
    fpsDen: req.project.fpsDen,
  });

  // 4. Frame grid.
  const frameDurUs = Math.round(
    (1_000_000 * req.project.fpsDen) / req.project.fpsNum,
  );
  const startUs = Math.max(0, req.startUs);
  const endUs = Math.min(req.project.durationUs, req.endUs);
  const totalFrames = Math.max(0, Math.ceil((endUs - startUs) / frameDurUs));
  const gop = req.encoderConfig.bitrate
    ? // Match the proxy GOP density — 1 second IDR cadence.
      Math.round(req.project.fpsNum / req.project.fpsDen)
    : 30;

  // 5. Per-frame loop.
  for (let i = 0; i < totalFrames; i++) {
    if (cancelled) {
      // eslint-disable-next-line no-console
      console.log("[weftcut/export] cancelled");
      encoder.dispose();
      compositor.dispose();
      app.destroy(true);
      return;
    }
    const tUs = startUs + i * frameDurUs;

    // Tell the compositor where we are. setAnchorTime kicks the
    // decoder pool's requestFrameAt for each active VideoClip.
    compositor.setAnchorTime(tUs);

    // Poll until the decoder has produced frames at this PTS, or
    // give up after ~5 s (decoder probably stuck; the worker will
    // paint what's available and move on).
    await waitForFramesReady(compositor, tUs, 5000);

    // Composite the frame into the canvas.
    compositor.compositeFrame(tUs);

    // Force PixiJS to actually render. autoStart was disabled at
    // init so we drive the render imperatively here.
    app.render();

    // Capture the canvas as a VideoFrame and hand it to the
    // encoder.
    const captured = new VideoFrame(
      req.canvas as unknown as CanvasImageSource,
      {
        timestamp: tUs - startUs,
        duration: frameDurUs,
      },
    );
    const isKey = i % gop === 0;
    encoder.encodeFrame(captured, isKey);

    // Progress + backpressure every few frames so postMessage
    // doesn't drown the main thread.
    if (i % 5 === 0) {
      post({ type: "progress", framesEncoded: i, totalFrames });
    }
    await encoder.awaitQueueBelow(8);
  }

  // 6. Finalize + send bytes.
  const bytes = await encoder.finalize();
  post({ type: "progress", framesEncoded: totalFrames, totalFrames });
  post({ type: "done", videoBytes: bytes }, [bytes]);

  // Cleanup.
  encoder.dispose();
  compositor.dispose();
  app.destroy(true);
}

/// Best-effort: wait until each active VideoClip's source ring
/// contains a frame whose interval covers the layer-local PTS for
/// `tUs`. Returns whether all rings were satisfied (false on
/// timeout). Caller proceeds either way — the rendered frame just
/// might be stale for the failed clip.
async function waitForFramesReady(
  compositor: Compositor,
  tUs: number,
  timeoutMs: number,
): Promise<boolean> {
  const summary = (
    compositor as unknown as { projectSummary: ProjectSummary | null }
  ).projectSummary;
  if (!summary) return true;

  // Build a list of (layer, expected source PTS) pairs we need
  // ready.
  interface Want {
    mediaId: string;
    expectedPtsUs: number;
  }
  const wants: Want[] = [];
  for (const track of summary.tracks) {
    if (!track.enabled) continue;
    for (const layer of track.layers) {
      if (!layer.enabled) continue;
      if (layer.params.kind !== "VideoClip") continue;
      if (tUs < layer.t_start_us || tUs >= layer.t_end_us) continue;
      const srcPts = layer.params.src_in_us + (tUs - layer.t_start_us);
      wants.push({ mediaId: layer.params.media_id, expectedPtsUs: srcPts });
    }
  }
  if (wants.length === 0) return true;

  const deadlineMs = performance.now() + timeoutMs;
  while (performance.now() < deadlineMs) {
    let ready = true;
    for (const w of wants) {
      const handle = (
        compositor.pool as unknown as {
          handles: Map<
            string,
            { ring: { containsPts: (t: number) => boolean } }
          >;
        }
      ).handles.get(w.mediaId);
      if (!handle) {
        ready = false;
        break;
      }
      if (!handle.ring.containsPts(w.expectedPtsUs)) {
        ready = false;
        break;
      }
    }
    if (ready) return true;
    // Re-kick the decoder pump.
    compositor.setAnchorTime(tUs);
    await new Promise<void>((r) => setTimeout(r, 8));
  }
  return false;
}
