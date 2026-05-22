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
  // `preference: "webgpu"` matches the preview surface; PixiJS auto-
  // falls back to WebGL when the worker context doesn't expose
  // `navigator.gpu`. Matching preference keeps export pixels
  // identical to preview pixels (different backends can disagree on
  // edge cases like sub-pixel rasterization).
  const app = new Application();
  await app.init({
    canvas: req.canvas as unknown as HTMLCanvasElement,
    width: req.project.width,
    height: req.project.height,
    background: 0x000000,
    autoStart: false,
    preference: "webgpu",
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

  // Aggregated per-span timings across the whole export. Per-chunk
  // deltas are logged inline; the final summary below lets us spot the
  // dominant cost without scrolling through every chunk line.
  const totals = {
    decodeMs: 0,
    waitMs: 0,
    compositeMs: 0,
    captureMs: 0,
    encodeMs: 0,
    queueWaitMs: 0,
    evictMs: 0,
  };

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

    // 6a. Dispatch decode for every active VideoClip in this chunk.
    // After the P8 wedge fix this is non-blocking: decodeRange feeds
    // the decoder and returns immediately. No flush. The decoder
    // emits frames asynchronously via its output callback; the
    // encode loop below pulls them via `ring.waitForPts`.
    const stagedClips = activeVideoClips(summary, chunkStartUs, chunkEndUs);
    const decodeT0 = performance.now();
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
    const decodeMs = performance.now() - decodeT0;
    totals.decodeMs += decodeMs;

    // 6b. Composite + encode every frame in the chunk. Each iteration:
    //   1. Await every active clip's source frame at this output time.
    //      The decoder runs concurrently — this is where we sync.
    //   2. Compose + capture + encode the output frame.
    //   3. Evict source frames whose presentation interval ends at or
    //      before the next output frame's source PTS. This frees
    //      VideoFrame pool slots so the decoder can produce more —
    //      the missing piece that caused the original "wedge at
    //      output #8" deadlock.
    let compositeMs = 0;
    let captureMs = 0;
    let encodeMs = 0;
    let queueWaitMs = 0;
    let waitMs = 0;
    for (let i = chunkStart; i < chunkEnd; i++) {
      if (cancelled) {
        cleanup(encoder, compositor, exportPool, app);
        return;
      }
      const tUs = startUs + i * frameDurUs;
      const activeNow = stagedClips.filter(
        (c) => c.tStartUs <= tUs && tUs < c.tEndUs,
      );

      const waitT0 = performance.now();
      if (activeNow.length > 0) {
        await Promise.all(
          activeNow.map((c) => {
            const handle = exportPool.handles.get(c.mediaId);
            if (!handle) return Promise.resolve();
            return handle.ring.waitForPts(clipSrcPtsAt(c, tUs));
          }),
        );
      }
      waitMs += performance.now() - waitT0;

      const compT0 = performance.now();
      compositor.setAnchorTime(tUs);
      compositor.compositeFrame(tUs);
      app.render();
      compositeMs += performance.now() - compT0;

      const capT0 = performance.now();
      const captured = new VideoFrame(
        req.canvas as unknown as CanvasImageSource,
        {
          timestamp: tUs - startUs,
          duration: frameDurUs,
        },
      );
      captureMs += performance.now() - capT0;

      const isKey = i % gop === 0;
      const encT0 = performance.now();
      encoder.encodeFrame(captured, isKey);
      encodeMs += performance.now() - encT0;

      // Per-frame evict — drop source frames whose intervals end at
      // or before the NEXT output frame's source PTS. For the last
      // output frame in the chunk, drop everything through srcBUs.
      // This is what keeps the WebCodecs decoder pool from
      // saturating.
      const nextTUs =
        i + 1 < chunkEnd ? startUs + (i + 1) * frameDurUs : null;
      for (const c of activeNow) {
        const handle = exportPool.handles.get(c.mediaId);
        if (!handle) continue;
        const cutoff =
          nextTUs !== null && c.tStartUs <= nextTUs && nextTUs < c.tEndUs
            ? clipSrcPtsAt(c, nextTUs)
            : c.srcBUs + 1;
        handle.evictBefore(cutoff);
      }

      if (i % 5 === 0) {
        post({ type: "progress", framesEncoded: i, totalFrames });
      }
      const qT0 = performance.now();
      await encoder.awaitQueueBelow(8);
      queueWaitMs += performance.now() - qT0;
    }
    totals.compositeMs += compositeMs;
    totals.captureMs += captureMs;
    totals.encodeMs += encodeMs;
    totals.queueWaitMs += queueWaitMs;
    totals.waitMs += waitMs;

    // 6c. Defensive end-of-chunk evict: anything still sitting in
    // any handle's ring beyond the encoder's last consumed PTS.
    // After the per-frame evict above this should be a no-op for
    // single-clip projects, but multi-clip projects can leave
    // stale frames in handles that weren't active at the last
    // output frame.
    const evictT0 = performance.now();
    for (const c of stagedClips) {
      const handle = exportPool.handles.get(c.mediaId);
      handle?.evictBefore(c.srcBUs + 1);
    }
    const evictMs = performance.now() - evictT0;
    totals.evictMs += evictMs;

    const elapsedMs = performance.now() - startedAtMs;
    const fps = elapsedMs > 0 ? Math.round((chunkEnd * 1000) / elapsedMs) : 0;
    const nFrames = chunkEnd - chunkStart;
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/export] chunk [${chunkStart}..${chunkEnd}) done — ` +
        `${chunkEnd}/${totalFrames} frames (~${fps} fps wall-clock) | ` +
        `dispatch=${decodeMs.toFixed(0)}ms ` +
        `wait=${waitMs.toFixed(0)}ms ` +
        `(${(waitMs / nFrames).toFixed(1)}ms/f) ` +
        `composite=${compositeMs.toFixed(0)}ms ` +
        `(${(compositeMs / nFrames).toFixed(1)}ms/f) ` +
        `capture=${captureMs.toFixed(0)}ms ` +
        `(${(captureMs / nFrames).toFixed(1)}ms/f) ` +
        `encode=${encodeMs.toFixed(0)}ms ` +
        `queueWait=${queueWaitMs.toFixed(0)}ms ` +
        `evict=${evictMs.toFixed(0)}ms`,
    );
  }

  const totalMs = performance.now() - startedAtMs;
  const overallFps = totalMs > 0 ? (totalFrames * 1000) / totalMs : 0;
  const pct = (ms: number) => ((ms / totalMs) * 100).toFixed(1);
  // eslint-disable-next-line no-console
  console.log(
    `[weftcut/export] PERF SUMMARY: ${totalFrames} frames in ${totalMs.toFixed(0)}ms ` +
      `(${overallFps.toFixed(1)} fps wall-clock)\n` +
      `  dispatch    ${totals.decodeMs.toFixed(0).padStart(7)}ms  (${pct(totals.decodeMs)}%)  ` +
      `← decoder feed (no flush)\n` +
      `  wait        ${totals.waitMs.toFixed(0).padStart(7)}ms  (${pct(totals.waitMs)}%)  ` +
      `${(totals.waitMs / totalFrames).toFixed(2)} ms/frame  ← awaiting decoder output\n` +
      `  composite   ${totals.compositeMs.toFixed(0).padStart(7)}ms  (${pct(totals.compositeMs)}%)  ` +
      `${(totals.compositeMs / totalFrames).toFixed(2)} ms/frame\n` +
      `  capture     ${totals.captureMs.toFixed(0).padStart(7)}ms  (${pct(totals.captureMs)}%)  ` +
      `${(totals.captureMs / totalFrames).toFixed(2)} ms/frame  ← GPU readback\n` +
      `  encode      ${totals.encodeMs.toFixed(0).padStart(7)}ms  (${pct(totals.encodeMs)}%)  ` +
      `${(totals.encodeMs / totalFrames).toFixed(2)} ms/frame\n` +
      `  queueWait   ${totals.queueWaitMs.toFixed(0).padStart(7)}ms  (${pct(totals.queueWaitMs)}%)  ` +
      `← awaiting encoder backpressure\n` +
      `  evict       ${totals.evictMs.toFixed(0).padStart(7)}ms  (${pct(totals.evictMs)}%)`,
  );

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
  /// Source-local PTS interval to dispatch for this chunk: [srcAUs, srcBUs].
  srcAUs: number;
  srcBUs: number;
  /// Timeline interval the clip occupies on the composition. The
  /// per-frame encode loop checks `tStartUs <= tUs && tUs < tEndUs`
  /// to know whether to await a source frame for this clip.
  tStartUs: number;
  tEndUs: number;
  /// Source-in offset — source-local PTS for a timeline time t is
  /// `srcInUs + (t - tStartUs)`. Same shape activeVideoClips uses
  /// to compute srcAUs/srcBUs; we keep the raw inputs so the
  /// encode loop can compute the per-frame srcPts itself.
  srcInUs: number;
}

/// Compute the source-local PTS that an output time `tUs` maps to
/// inside the clip's source media. Caller must ensure the clip is
/// active at tUs (tStartUs <= tUs < tEndUs) — outside that range
/// the value is meaningless.
function clipSrcPtsAt(c: StagedClip, tUs: number): number {
  return c.srcInUs + (tUs - c.tStartUs);
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
        tStartUs: layer.t_start_us,
        tEndUs: layer.t_end_us,
        srcInUs: layer.params.src_in_us,
      });
    }
  }
  return out;
}
