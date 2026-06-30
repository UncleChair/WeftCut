// Web Worker entry point for export. Receives an ExportRequest,
// constructs a Compositor against an OffscreenCanvas, runs the
// chunked decode → composite → encode loop, posts progress, posts
// fMP4 chunks with backpressure, posts final counters, and exits.
//
// Plan: docs/render.md
//
// Why chunked + dedicated decoder driver:
//   The preview-tuned SourceDecoderPool gates decoding on a small
//   lookahead window with `setTimeout(8 ms)` poll-and-yield — far too
//   slow for export, which has no preview-latency budget to protect.
//
//   This Worker now drives an `ExportDecoderPool` directly: per
//   ~2 s chunk we feed every needed sample for every active clip
//   in one shot, `await decoder.flush()`, then run the encode loop
//   over the chunk with no per-frame waiting. After the chunk
//   encodes we evict its consumed frames so memory stays bounded.
//
// Limitations:
//   - Audio is OUT. The Worker has no DOM and audio export rides
//     the existing Rust ffmpeg compositor. Final mux/transcode combines
//     this temp video with an optional temp audio file (.m4a/.mka).
//   - Subtitles (legacy JASSUB kind) are gone; captions now render as Text
//     layers and export through the normal Text path.
//   - Motifs DO render: the SVG capture harness can't run in the
//     Worker (no `document`), so the main thread pre-rasterizes each
//     Motif layer's frames (`exportBake.ts`) and transfers them in
//     via `ExportRequest.start.motifFrames`; `compositor.setMotifFrames`
//     installs them and `MotifSprite` binds by comp-frame index.
//     VideoClip / ImageOverlay / Color / Text render fine.

import { Application, Container, DOMAdapter, RenderTexture, TexturePool, WebWorkerAdapter } from "pixi.js";
import type { WebGLRenderer } from "pixi.js";

import type { MediaSummary, ProjectSummary } from "../../ipc";
import { selectActiveVideoLayers } from "../activeVideoLayers";
import { gopFrames } from "../exportSettings";
import { Compositor } from "../Compositor";
import { ExportDecoderPool, exportHandleKey } from "../decoder/ExportDecoderPool";
import { EncoderSink } from "./encoder";
import { exportFrameCount, frameTimeUs as gridFrameTimeUs } from "./frameGrid";
import type { ExportEvent, ExportRequest } from "./protocol";
import { PackYuv420p10 } from "../tenbit/PackYuv420p10";
import { loadFontsIntoFaceSet } from "../fonts/loadFontsIntoFaceSet";

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
/// Resolver for the in-flight `chunk` write. WritableStream serializes writes,
/// so at most one is pending at a time.
let pendingChunkAck: (() => void) | null = null;

/// Post one sequential output slice to the main thread and resolve once it
/// acks (after appending to disk). mediabunny's WritableStream awaits this, so
/// the encoder throttles to write speed and the whole MP4 is never resident.
function postChunk(data: Uint8Array): Promise<void> {
  return new Promise<void>((resolve) => {
    pendingChunkAck = resolve;
    // `data` is a fresh, exactly-sized buffer the EncoderSink batcher hands
    // over and never reuses, so transfer it directly (zero-copy).
    const buf = data.buffer as ArrayBuffer;
    post({ type: "chunk", data: buf }, [buf]);
  });
}

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
  } else if (req.type === "chunk-ack") {
    const resolve = pendingChunkAck;
    pendingChunkAck = null;
    resolve?.();
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

  const tenBit = req.bitDepth === 10;

  // Register bundled fonts into the Worker's font set BEFORE the renderer
  // initializes. OffscreenCanvas has no system-font fallback chain, so
  // unregistered families (e.g. CJK) would rasterize as blank boxes.
  // Cast: TypeScript types `self` as Window in tsconfig lib, but inside a
  // DedicatedWorker `self.fonts` (FontFaceSet) is available at runtime.
  await loadFontsIntoFaceSet(
    (self as unknown as { fonts: FontFaceSet }).fonts,
    req.fonts,
  );

  // 1. PixiJS Application against the transferred OffscreenCanvas.
  // For the 10-bit path we force WebGL2 (PackYuv420p10 needs a GL renderer
  // with EXT_color_buffer_float for rgba16float targets). For the 8-bit
  // path we prefer WebGPU to match the preview surface; PixiJS auto-falls
  // back to WebGL when the worker context doesn't expose `navigator.gpu`.
  const app = new Application();
  await app.init({
    canvas: req.canvas as unknown as HTMLCanvasElement,
    width: req.project.width,
    height: req.project.height,
    background: 0x000000,
    autoStart: false,
    preference: tenBit ? "webgl" : "webgpu",
  });

  if (tenBit) {
    if (!("gl" in app.renderer)) {
      throw new Error("10-bit export needs the WebGL2 renderer; got " + app.renderer.name);
    }
    // Capability check: render 1 px into an f16 target and read it back —
    // fails loudly here rather than producing a silent black export on a
    // context without renderable float16 (EXT_color_buffer_float).
    {
      const renderer = app.renderer as WebGLRenderer;
      const probe = RenderTexture.create({ width: 1, height: 1, format: "rgba16float" });
      // Drain any stale GL errors left by PixiJS init before the probe so
      // a pre-existing error doesn't false-positive as a probe failure.
      while (renderer.gl.getError() !== renderer.gl.NO_ERROR) { /* drain stale errors */ }
      renderer.render({ container: new Container(), target: probe });
      renderer.renderTarget.bind(probe, false);
      const px = new Float32Array(4);
      renderer.gl.readPixels(0, 0, 1, 1, renderer.gl.RGBA, renderer.gl.FLOAT, px);
      const err = renderer.gl.getError();
      probe.destroy(true);
      if (err !== 0) {
        throw new Error(`10-bit export: float16 render targets unsupported (glError ${err})`);
      }
    }
  }

  if (tenBit) {
    // Pixi's FilterSystem allocates filter intermediates from this global
    // TexturePool; its default 8-bit format would band the 10-bit signal at the
    // first filter. Set it to rgba16float ONCE, here at init, before any
    // filtering. NEVER TexturePool.clear(true) on a live FilterSystem — it
    // destroys pooled textures the persistent filter bind group references
    // (null-resources crash); the pool is empty at init so no clear is needed.
    TexturePool.textureOptions = { ...TexturePool.textureOptions, format: "rgba16float" };
  }

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
    // Export drives `exportPool.acquire` directly (threading `mediaColor`
    // there itself), so the Compositor's own `ensureClip` acquire path is
    // unused in export mode; this resolver exists to satisfy the required
    // init field and stays consistent with that wiring if it ever fires.
    sourceColor: (mediaId: string) => req.project.mediaColor[mediaId],
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
        start_pts_us: req.project.mediaStartPtsUs[mediaId] ?? null,
        video_start_pts_us: req.project.mediaStartPtsUs[mediaId] ?? null,
        size_bytes: 0,
        available: true,
        decode_route: { route: "bypass" },
        codec: null,
        pix_fmt: null,
      };
    },
  });
  compositor.setProject(req.project.summary as ProjectSummary);
  // Inject the main-thread-baked Motif frames (layerId → comp-frame-indexed
  // ImageBitmap[]). With these, a Motif layer composites in export by binding
  // the baked bitmap synchronously — the Worker has no DOM, so the live SVG
  // capture harness can't run here. Empty for a video-only export (no-op).
  compositor.setMotifFrames(req.motifFrames);
  compositor.setMasterPlayState(false);
  // Pre-load all ImageOverlay image data before the frame loop so that
  // animated GIFs are fully decoded and every output frame sees a valid
  // bitmap (ensureImage fires loadFromAsset fire-and-forget; without this
  // wait the decoder races the frame loop and all frames composite black).
  await compositor.preloadImages();

  // Output fps: caller override (resolution/fps dialog) or composition fps.
  const outFpsNum = req.outputFpsNum ?? req.project.fpsNum;
  const outFpsDen = req.outputFpsDen ?? req.project.fpsDen;

  // Target output dimensions are the ENCODER's dimensions, which may be a
  // downscale of the composition render size. The render target (canvas /
  // compositor / app) stays at composition size; we blit down at capture.
  const outWidth = req.encoderConfig.width;
  const outHeight = req.encoderConfig.height;
  const needsScale =
    outWidth !== req.project.width || outHeight !== req.project.height;

  // 4. Encoder pipeline. Dims/fps come from the encoder config + output fps.
  // For the 10-bit path, encoding rides the Rust ffmpeg sink (PackYuv420p10
  // + IPC write), so the WebCodecs EncoderSink is not created.
  const encoder = tenBit
    ? null
    : new EncoderSink({
        config: req.encoderConfig,
        width: outWidth,
        height: outHeight,
        fpsNum: outFpsNum,
        fpsDen: outFpsDen,
        onChunk: postChunk,
      });

  // 4b. 10-bit-path resources: composite render target (rgba16float) and
  // YUV packer. pack() ctor throws on odd-ish dims — that propagates out of
  // runExport as an `error` event (desired; don't catch it here).
  let compositeRT: RenderTexture | null = null;
  let pack: PackYuv420p10 | null = null;
  if (tenBit) {
    compositeRT = RenderTexture.create({
      width: req.project.width,
      height: req.project.height,
      format: "rgba16float",
    });
    pack = new PackYuv420p10(app.renderer as WebGLRenderer, outWidth, outHeight);
  }

  // 5. Frame grid — driven by OUTPUT fps. The grid is time-based, so a lower
  // output fps naturally samples fewer composition frames (drops); a higher
  // one duplicates. No frame-resampling machinery needed.
  //
  // Frame TIMES + COUNT come from the exact rational fps (see frameGrid.ts): a
  // floored per-frame duration (`i * round(1e6/fps)`, `ceil(span/33333)`)
  // compounds the rounding floor, drifts behind the source PTS grid, and makes
  // `frameAt` duplicate a frame (301 frames for a 300-frame clip, output[N] =
  // source[N-1]). `frameTimeUs`/`exportFrameCount` derive from one shared
  // predicate so the grid and the count never disagree.
  const startUs = Math.max(0, req.startUs);
  const endUs = Math.min(req.project.durationUs, req.endUs);
  const frameTimeUs = (i: number): number =>
    gridFrameTimeUs(startUs, i, outFpsNum, outFpsDen);
  // Per-frame duration for the captured VideoFrame / encoder cadence only — an
  // approximation is fine here; it never feeds the source-time grid above.
  const frameDurUs = Math.round((1_000_000 * outFpsDen) / outFpsNum);
  const totalFrames = exportFrameCount(startUs, endUs, outFpsNum, outFpsDen);
  // Forced-keyframe cadence at the OUTPUT fps, from the caller's keyframe
  // interval (seconds); defaults to 1 second. Shared formula with the ffmpeg
  // path so both encode routes agree.
  const outFps = outFpsNum / Math.max(1, outFpsDen);
  const gop = gopFrames(req.keyframeIntervalSec ?? 1, outFps);

  // Reusable downscale target — allocated once, drawn into per frame.
  // Not used in the 10-bit path: PackYuv420p10 samples the composite at
  // output dims directly via its GLSL shaders.
  const scaleCanvas = !tenBit && needsScale
    ? new OffscreenCanvas(outWidth, outHeight)
    : null;
  const scaleCtx = scaleCanvas
    ? scaleCanvas.getContext("2d", { alpha: false })
    : null;

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
      cleanup({ encoder, compositor, pool: exportPool, app, pack, compositeRT });
      return;
    }
    const chunkEnd = Math.min(chunkStart + CHUNK_FRAMES, totalFrames);
    const chunkStartUs = frameTimeUs(chunkStart);
    // End is exclusive in frame-index terms; convert to inclusive PTS by
    // subtracting one µs so the last frame's interval is covered rather than
    // the next one.
    const chunkEndUs = frameTimeUs(chunkEnd) - 1;

    // 6a. Dispatch decode for every active VideoClip in this chunk.
    // This is non-blocking: decodeRange feeds the decoder and returns
    // immediately. No flush. The decoder
    // emits frames asynchronously via its output callback; the
    // encode loop below pulls them via `ring.waitForPts`.
    //
    // Clips are grouped per decode pipeline (`exportHandleKey`: mediaId +
    // timeline→source phase) and each group dispatches ONE merged range.
    // Per-clip dispatch on a shared handle let two overlapping clips of one
    // source interleave `decodeRange` calls — the cursor raced and the
    // export wedged (frame counter frozen mid-run); same-phase clips also
    // each paid a full decode for identical ranges.
    const stagedClips = activeVideoClips(summary, chunkStartUs, chunkEndUs);
    const stagedGroups = groupStagedClips(stagedClips);
    const decodeT0 = performance.now();
    await Promise.all(
      [...stagedGroups.values()].map(async (g) => {
        // For 10-bit media, acquire the ORIGINAL asset URL and mark the lane
        // so the decoder pool uses the software path. preferSoftware is a
        // correctness requirement for AV1-10 (the HW decoder succeeds but
        // emits opaque format=null frames with no copyTo); for Hi10P it just
        // skips a doomed HW attempt (no HW path exists).
        const tenBitSource = tenBit && req.tenBitMedia?.[g.mediaId] === true;
        const url = tenBitSource
          ? req.project.originalAssetUrls[g.mediaId]
          : req.project.proxyAssetUrls[g.mediaId];
        if (!url) return;
        const handle = exportPool.acquire({
          layerId: g.clips[0]!.layerId,
          mediaId: g.mediaId,
          handleKey: g.key,
          proxyAssetUrl: url,
          // The source's real color tags, for original AND proxy decodes (a
          // proxy preserves the source colorimetry; its own colr tag outranks
          // this per-field in withDefaultColorSpace).
          sourceColor: req.project.mediaColor[g.mediaId],
          sourceStartPtsUs: req.project.mediaStartPtsUs[g.mediaId] ?? null,
          ...(tenBitSource ? { tenBitLane: true, preferSoftware: true } : {}),
        });
        await handle.decodeRange(g.srcAUs, g.srcBUs);
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
    //      VideoFrame pool slots so the decoder can produce more.
    //      Without this evict the pool saturates and the decoder
    //      deadlocks (it can never release frames the encode loop
    //      is still waiting on).
    let compositeMs = 0;
    let captureMs = 0;
    let encodeMs = 0;
    let queueWaitMs = 0;
    let waitMs = 0;
    for (let i = chunkStart; i < chunkEnd; i++) {
      if (cancelled) {
        cleanup({ encoder, compositor, pool: exportPool, app, pack, compositeRT });
        return;
      }
      const tUs = frameTimeUs(i);
      const activeNow = stagedClips.filter(
        (c) => c.tStartUs <= tUs && tUs < c.tEndUs,
      );

      const waitT0 = performance.now();
      if (activeNow.length > 0) {
        await Promise.all(
          activeNow.map((c) => {
            const handle = exportPool.handles.get(c.key);
            if (!handle) return Promise.resolve();
            return handle.ring.waitForPts(clipSrcPtsAt(c, tUs));
          }),
        );
      }
      waitMs += performance.now() - waitT0;

      const compT0 = performance.now();
      compositor.setAnchorTime(tUs);
      compositor.compositeFrame(tUs);

      if (tenBit) {
        // 10-bit path: render into the rgba16float RenderTexture, pack to
        // yuv420p10le, then stream to the Rust sink over the chunk/ack IPC channel.
        app.renderer.render({ container: app.stage, target: compositeRT! });
        compositeMs += performance.now() - compT0;

        const capT0 = performance.now();
        const bytes = pack!.pack(compositeRT!);
        captureMs += performance.now() - capT0;

        const encT0 = performance.now();
        // 10-bit frames go to the main thread over the chunk/ack channel, which
        // forwards them to export_video_sink_write. Copy because postChunk
        // transfers the buffer and pack() reuses its output.
        await postChunk(bytes.slice());
        encodeMs += performance.now() - encT0;
      } else {
        // 8-bit path: render to the OffscreenCanvas, capture as a VideoFrame,
        // push to the WebCodecs EncoderSink — UNCHANGED.
        app.render();
        compositeMs += performance.now() - compT0;

        const capT0 = performance.now();
        let source: CanvasImageSource = req.canvas as unknown as CanvasImageSource;
        if (scaleCtx && scaleCanvas) {
          scaleCtx.drawImage(
            req.canvas as unknown as CanvasImageSource,
            0,
            0,
            outWidth,
            outHeight,
          );
          source = scaleCanvas as unknown as CanvasImageSource;
        }
        const captured = new VideoFrame(source, {
          timestamp: tUs - startUs,
          duration: frameDurUs,
        });
        captureMs += performance.now() - capT0;

        const isKey = i % gop === 0;
        const encT0 = performance.now();
        encoder!.encodeFrame(captured, isKey);
        encodeMs += performance.now() - encT0;
      }

      // Per-frame evict — drop source frames whose intervals end at
      // or before the NEXT output frame's source PTS. For the last
      // output frame in the chunk, drop everything through srcBUs.
      // This is what keeps the WebCodecs decoder pool from
      // saturating. The cutoff is aggregated per GROUP (min across the
      // group's active clips): a per-clip evict on a shared ring would
      // let one clip drop frames a sibling still needs next frame.
      const nextTUs = i + 1 < chunkEnd ? frameTimeUs(i + 1) : null;
      const cutoffByKey = new Map<string, number>();
      for (const c of activeNow) {
        const cutoff =
          nextTUs !== null && c.tStartUs <= nextTUs && nextTUs < c.tEndUs
            ? clipSrcPtsAt(c, nextTUs)
            : c.srcBUs + 1;
        const prev = cutoffByKey.get(c.key);
        cutoffByKey.set(c.key, prev === undefined ? cutoff : Math.min(prev, cutoff));
      }
      for (const [key, cutoff] of cutoffByKey) {
        exportPool.handles.get(key)?.evictBefore(cutoff);
      }

      if (i % 5 === 0) {
        post({ type: "progress", framesEncoded: i, totalFrames });
      }
      const qT0 = performance.now();
      if (!tenBit) {
        await encoder!.awaitQueueBelow(8);
      }
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
    for (const g of stagedGroups.values()) {
      exportPool.handles.get(g.key)?.evictBefore(g.srcBUs + 1);
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
  // 10-bit: all frames already streamed via the chunk/ack channel; the main
  // thread calls exportVideoSinkFinish after receiving `done`.
  // 8-bit: flush the WebCodecs encoder and finalize the mediabunny mux
  // (flushes trailing fMP4 fragments through the same onChunk path).
  if (!tenBit) {
    await encoder!.finalize();
  }
  post({ type: "progress", framesEncoded: totalFrames, totalFrames });

  // Perf counters for the E2E harness (decode efficiency / re-seek redundancy).
  let totalDispatched = 0;
  let colorDiag: unknown = null;
  for (const h of exportPool.handles.values()) {
    totalDispatched += h.dispatchedTotal;
    if (!colorDiag && h.firstFrameDiag) colorDiag = h.firstFrameDiag;
  }
  post({
    type: "done",
    perf: {
      totalFrames,
      totalDispatched,
      decodeMs: Math.round(totals.decodeMs),
      waitMs: Math.round(totals.waitMs),
      totalMs: Math.round(totalMs),
      colorDiag,
    },
  });

  // 8. Cleanup.
  cleanup({ encoder, compositor, pool: exportPool, app, pack, compositeRT });
}

interface CleanupArgs {
  encoder: EncoderSink | null;
  compositor: Compositor;
  pool: ExportDecoderPool;
  app: Application;
  pack: PackYuv420p10 | null;
  compositeRT: RenderTexture | null;
}

function cleanup({
  encoder,
  compositor,
  pool,
  app,
  pack,
  compositeRT,
}: CleanupArgs): void {
  pack?.dispose();
  compositeRT?.destroy(true);
  encoder?.dispose();
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
  /// Decode-pipeline identity (`exportHandleKey`): mediaId + timeline→source
  /// phase. Clips sharing a key share one handle and one merged range per
  /// chunk; the encode loop's waits + evicts look handles up by this.
  key: string;
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

/// One decode pipeline's per-chunk work: the clips that share an
/// `exportHandleKey` and the union of their source ranges. Same-phase clips
/// have coinciding (or nested) ranges, so the union is contiguous and a
/// single `decodeRange` serves every clip in the group.
interface StagedGroup {
  key: string;
  mediaId: string;
  srcAUs: number;
  srcBUs: number;
  clips: StagedClip[];
}

function groupStagedClips(clips: StagedClip[]): Map<string, StagedGroup> {
  const groups = new Map<string, StagedGroup>();
  for (const c of clips) {
    const g = groups.get(c.key);
    if (!g) {
      groups.set(c.key, {
        key: c.key,
        mediaId: c.mediaId,
        srcAUs: c.srcAUs,
        srcBUs: c.srcBUs,
        clips: [c],
      });
    } else {
      g.srcAUs = Math.min(g.srcAUs, c.srcAUs);
      g.srcBUs = Math.max(g.srcBUs, c.srcBUs);
      g.clips.push(c);
    }
  }
  return groups;
}

/// Compute the source-local PTS that an output time `tUs` maps to
/// inside the clip's source media. Caller must ensure the clip is
/// active at tUs (tStartUs <= tUs < tEndUs) — outside that range
/// the value is meaningless.
function clipSrcPtsAt(c: StagedClip, tUs: number): number {
  return c.srcInUs + (tUs - c.tStartUs);
}

/// Collect every VideoClip live in [chunkStartUs, chunkEndUs] and translate
/// the overlap into source-local PTS bounds. Selection is delegated to
/// `selectActiveVideoLayers` (shared with the export-readiness gate); only the
/// PTS math lives here.
function activeVideoClips(
  summary: ProjectSummary,
  chunkStartUs: number,
  chunkEndUs: number,
): StagedClip[] {
  return selectActiveVideoLayers(summary, chunkStartUs, chunkEndUs).map((l) => {
    const overlapStartUs = Math.max(l.tStartUs, chunkStartUs);
    const overlapEndUs = Math.min(l.tEndUs - 1, chunkEndUs);
    return {
      layerId: l.layerId,
      mediaId: l.mediaId,
      key: exportHandleKey(l.mediaId, l.srcInUs, l.tStartUs),
      srcAUs: l.srcInUs + (overlapStartUs - l.tStartUs),
      srcBUs: l.srcInUs + (overlapEndUs - l.tStartUs),
      tStartUs: l.tStartUs,
      tEndUs: l.tEndUs,
      srcInUs: l.srcInUs,
    };
  });
}
