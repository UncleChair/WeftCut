// Web Worker entry point for export. Receives an ExportRequest,
// constructs a Compositor against an OffscreenCanvas, runs the
// chunked decode → composite → encode loop, posts progress, posts
// the muxed MP4 bytes back, and exits.
//
// Plan: docs/pixi-renderer-plan.md (P8 perf rewrite)
//
// Why chunked + dedicated decoder driver:
//   The preview-tuned SourceDecoderPool gates decoding on a small
//   lookahead window with `setTimeout(8 ms)` poll-and-yield. In
//   export that produced ~0.2 fps because every frame waited the
//   full timeout while the decoder pump was throttled to keep
//   preview latency low.
//
//   This Worker now drives an `ExportDecoderPool` directly: per
//   ~2 s chunk we feed every needed sample for every active clip
//   in one shot, `await decoder.flush()`, then run the encode loop
//   over the chunk with no per-frame waiting. After the chunk
//   encodes we evict its consumed frames so memory stays bounded.
//
// Limitations (v1):
//   - Audio is OUT. The Worker has no DOM and audio export rides
//     the existing Rust ffmpeg compositor. P9 final mux combines
//     video.mp4 (this output) with audio.m4a.
//   - Templates / Subtitles render paths are absent here (P5 / P6).
//     VideoClip / ImageOverlay / Color / Text render fine.

import { Application, DOMAdapter, WebWorkerAdapter } from "pixi.js";

import type { LayerSummary, MediaSummary, ProjectSummary } from "../../ipc";
import { Compositor } from "../Compositor";
import { ExportDecoderPool } from "../decoder/ExportDecoderPool";
import { EncoderSink } from "./encoder";
import type { ExportEvent, ExportRequest } from "./protocol";

// PixiJS defaults to `BrowserAdapter`, which calls `document.*`
// and `new Image()`. In a Worker neither exists, so any renderer
// init throws "document is not defined". Swap to `WebWorkerAdapter`
// BEFORE `new Application()`.
DOMAdapter.set(WebWorkerAdapter);

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

// Ready handshake so the main thread knows we've parsed and the
// message handler is attached.
post({ type: "ready" });

/// Chunk size — how many output frames we decode + encode before
/// evicting and moving on. ~2 s at 30 fps. Larger chunks reduce
/// per-chunk overhead (decoder.flush latency) at the cost of more
/// resident VideoFrames per active clip.
const CHUNK_FRAMES = 60;

async function runExport(req: Extract<ExportRequest, { type: "start" }>) {
  const startedAtMs = performance.now();

  // 1. PixiJS Application against the transferred OffscreenCanvas.
  const app = new Application();
  await app.init({
    canvas: req.canvas as unknown as HTMLCanvasElement,
    width: req.project.width,
    height: req.project.height,
    background: 0x000000,
    autoStart: false,
  });

  // 2. Dedicated export decoder pool — bypasses the preview-tuned
  // lookahead pump entirely.
  const exportPool = new ExportDecoderPool();

  // 3. Compositor in export mode with the export pool injected.
  const compositor = new Compositor({
    app,
    width: req.project.width,
    height: req.project.height,
    mode: "export",
    pool: exportPool,
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

  // 4. Encoder pipeline.
  const encoder = new EncoderSink({
    config: req.encoderConfig,
    width: req.project.width,
    height: req.project.height,
    fpsNum: req.project.fpsNum,
    fpsDen: req.project.fpsDen,
  });

  // 5. Frame grid.
  const frameDurUs = Math.round(
    (1_000_000 * req.project.fpsDen) / req.project.fpsNum,
  );
  const startUs = Math.max(0, req.startUs);
  const endUs = Math.min(req.project.durationUs, req.endUs);
  const totalFrames = Math.max(0, Math.ceil((endUs - startUs) / frameDurUs));
  // 1-second IDR cadence to match the master proxy's GOP density.
  const gop = Math.max(
    1,
    Math.round(req.project.fpsNum / Math.max(1, req.project.fpsDen)),
  );

  const summary = req.project.summary as ProjectSummary;

  // 6. Chunked decode + encode.
  for (let chunkStart = 0; chunkStart < totalFrames; chunkStart += CHUNK_FRAMES) {
    if (cancelled) {
      // eslint-disable-next-line no-console
      console.log("[weftcut/export] cancelled");
      cleanup(encoder, compositor, exportPool, app);
      return;
    }
    const chunkEnd = Math.min(chunkStart + CHUNK_FRAMES, totalFrames);
    const chunkStartUs = startUs + chunkStart * frameDurUs;
    // End is exclusive in frame-index terms; convert to inclusive PTS by
    // subtracting one µs so `sampleIndexForPtsUs` lands inside the last
    // frame's interval rather than the next one.
    const chunkEndUs = startUs + chunkEnd * frameDurUs - 1;

    // 6a. Stage decode for every active VideoClip in this chunk. Run
    // per-clip decodeRange calls in parallel so multiple clips on
    // overlapping tracks decode concurrently.
    const stagedClips = activeVideoClips(summary, chunkStartUs, chunkEndUs);
    await Promise.all(
      stagedClips.map(async (c) => {
        const proxyUrl = req.project.proxyAssetUrls[c.mediaId];
        if (!proxyUrl) return;
        const handle = exportPool.acquire({
          mediaId: c.mediaId,
          proxyAssetUrl: proxyUrl,
        });
        await handle.decodeRange(c.srcAUs, c.srcBUs);
      }),
    );

    // 6b. Composite + encode every frame in the chunk. With frames
    // pre-staged this is purely CPU/GPU bound — no per-frame waits.
    for (let i = chunkStart; i < chunkEnd; i++) {
      if (cancelled) {
        cleanup(encoder, compositor, exportPool, app);
        return;
      }
      const tUs = startUs + i * frameDurUs;

      compositor.setAnchorTime(tUs);
      compositor.compositeFrame(tUs);
      app.render();

      const captured = new VideoFrame(
        req.canvas as unknown as CanvasImageSource,
        {
          timestamp: tUs - startUs,
          duration: frameDurUs,
        },
      );
      const isKey = i % gop === 0;
      encoder.encodeFrame(captured, isKey);

      if (i % 5 === 0) {
        post({ type: "progress", framesEncoded: i, totalFrames });
      }
      await encoder.awaitQueueBelow(8);
    }

    // 6c. Evict frames consumed by this chunk so the next chunk's
    // decode doesn't pile up. We cut everything strictly before
    // chunkEndUs + 1µs — i.e. drop frames whose interval ended before
    // or at the chunk's last consumed frame.
    for (const c of stagedClips) {
      const handle = exportPool.handles.get(c.mediaId);
      handle?.evictBefore(c.srcBUs + 1);
    }

    const elapsedMs = performance.now() - startedAtMs;
    const fps = elapsedMs > 0 ? Math.round((chunkEnd * 1000) / elapsedMs) : 0;
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/export] chunk [${chunkStart}..${chunkEnd}) done — ` +
        `${chunkEnd}/${totalFrames} frames (~${fps} fps wall-clock)`,
    );
  }

  // 7. Finalize.
  const bytes = await encoder.finalize();
  post({ type: "progress", framesEncoded: totalFrames, totalFrames });
  post({ type: "done", videoBytes: bytes }, [bytes]);

  // 8. Cleanup.
  cleanup(encoder, compositor, exportPool, app);
}

function cleanup(
  encoder: EncoderSink,
  compositor: Compositor,
  pool: ExportDecoderPool,
  app: Application,
): void {
  encoder.dispose();
  compositor.dispose();
  pool.dispose();
  try {
    app.destroy(true);
  } catch {
    // app may already be in a torn-down state; ignore.
  }
}

interface StagedClip {
  layerId: string;
  mediaId: string;
  /// Source-local PTS interval to decode for this chunk: [srcAUs, srcBUs].
  srcAUs: number;
  srcBUs: number;
}

/// Walk the project's tracks/layers and collect every VideoClip whose
/// timeline interval overlaps [chunkStartUs, chunkEndUs]. Translate the
/// overlap into source-local PTS bounds.
function activeVideoClips(
  summary: ProjectSummary,
  chunkStartUs: number,
  chunkEndUs: number,
): StagedClip[] {
  const out: StagedClip[] = [];
  for (const track of summary.tracks) {
    if (!track.enabled) continue;
    for (const layer of track.layers as LayerSummary[]) {
      if (!layer.enabled) continue;
      if (layer.params.kind !== "VideoClip") continue;
      // Reject layers entirely outside the chunk.
      if (layer.t_end_us <= chunkStartUs) continue;
      if (layer.t_start_us > chunkEndUs) continue;

      const overlapStartUs = Math.max(layer.t_start_us, chunkStartUs);
      const overlapEndUs = Math.min(layer.t_end_us - 1, chunkEndUs);
      const srcAUs =
        layer.params.src_in_us + (overlapStartUs - layer.t_start_us);
      const srcBUs =
        layer.params.src_in_us + (overlapEndUs - layer.t_start_us);
      out.push({
        layerId: layer.id,
        mediaId: layer.params.media_id,
        srcAUs,
        srcBUs,
      });
    }
  }
  return out;
}
