// Main-thread harness for the export Worker. Drives one export from
// "user clicked export" to "video chunks durably written" — Worker spawning,
// project snapshot serialization, OffscreenCanvas transfer, progress
// streaming, and chunk backpressure.
//
// See docs/render.md — "Export Worker".
//
// Callers provide a writeChunk sink for the video-only fMP4 and get final
// frame counters. Audio export and mux/transcode run on the Rust side after
// this resolves.

import { convertFileSrc } from "@/bridge/ipc";
import { loadBundledFontBytes, resolveFontsForFamilies } from "../fonts/registry";

import type { MediaSummary, ProjectSummary } from "../../ipc";
import { resolveDecode } from "../decodeRoute";
import { referencedVideoMediaIds } from "../activeVideoLayers";
import { ffprobeColorToWebCodecs } from "../decoder/ffprobeColorSpace";
import { tenBitExportCapable } from "../exportSettings";
import type {
  ExportEvent,
  ExportProjectSnapshot,
  ExportRequest,
} from "./protocol";

export interface RunExportInit {
  /// Live project summary from the Zustand store.
  summary: ProjectSummary;
  /// Media lookup, also from the store. Required for asset URL
  /// pre-resolution.
  mediaById: ReadonlyMap<string, MediaSummary>;
  /// Time range to render (microseconds). Defaults to whole project.
  startUs?: number;
  endUs?: number;
  /// Encoder config. Defaults to 1080p H.264 High@4.2 / 8 Mbps /
  /// prefer-hardware. ExportPanel can override per preset.
  encoderConfig?: VideoEncoderConfig;
  /// Output frame rate (rational). Overrides composition fps for the frame
  /// grid + capture cadence. Absent ⇒ composition fps.
  outputFps?: { num: number; den: number };
  /// Seconds between forced keyframes. Absent ⇒ 1 second.
  keyframeIntervalSec?: number;
  /// Optional progress callback. Fires with (framesEncoded,
  /// totalFrames) on every progress event.
  onProgress?: (encoded: number, total: number) => void;
  /// Sink for each sequential output-file slice (fMP4, append-only). Called in
  /// order; must resolve once the slice is durably written (the Worker awaits
  /// the ack before releasing the next write → backpressure). Streaming to disk
  /// avoids buffering the whole MP4 in one ArrayBuffer (V8's ~2GB cap OOM'd
  /// long exports at finalize).
  writeChunk: (data: ArrayBuffer) => Promise<void>;
  /// Pre-rasterized Motif-layer frames (`layerId -> ImageBitmap[]`, comp-frame
  /// indexed), baked on the MAIN thread by `exportBakeMotifs` (the Worker has
  /// no DOM to run the SVG capture harness). TRANSFERRED into the Worker's
  /// `start` message. Absent / empty ⇒ no Motif layers in the export range.
  motifFrames?: Record<string, ImageBitmap[]>;
  /// Optional cancel signal — the Worker checks at each frame
  /// boundary.
  signal?: AbortSignal;
  /// Output bit depth (8 = existing pipeline; 10 = f16/WebGL2 + native-encode).
  /// Absent ⇒ 8.
  bitDepth?: 8 | 10;
  /// Present ⇒ the worker packs frames to this format and streams them to the
  /// native ffmpeg sink instead of WebCodecs-encoding.
  nativeSinkPixFmt?: "yuv420p" | "yuv420p10le" | "yuv422p" | "yuv422p10le";
}

export interface RunExportResult {
  /// (encoded, total). After a clean run, encoded === total.
  framesEncoded: number;
  totalFrames: number;
}

/// Default 1080p H.264 encoder config used when the caller doesn't
/// supply one. Matches the proxy spec we already have: High profile,
/// Level 4.2, yuv420p — universally hardware-decodable downstream.
/// Framerate must follow the composition fps (passed in), not a constant — a fixed value would mis-time non-30fps exports.
function defaultEncoderConfig(
  width: number,
  height: number,
  framerate: number,
): VideoEncoderConfig {
  return {
    codec: "avc1.640028",
    width,
    height,
    bitrate: 8_000_000,
    framerate,
    hardwareAcceleration: "prefer-hardware",
  };
}

export async function runExport(init: RunExportInit): Promise<RunExportResult> {
  const summary = init.summary;
  const comp = summary.composition;
  const fpsNum = comp.fps_num;
  const fpsDen = comp.fps_den;
  const startUs = init.startUs ?? 0;
  const endUs = init.endUs ?? summary.duration_us;

  // 1. Pre-resolve asset URLs for every media item. The Worker has no renderer
  // bridge so it can't call `convertFileSrc` itself. Only REFERENCED video
  // sources must have a ready export path — the export-readiness gate in App
  // (decodability probe + route-correction + auto-wait) guarantees that before
  // calling here; the throw below is a defensive assertion, not the
  // user-facing decodability path.
  const referenced = referencedVideoMediaIds(summary, startUs, endUs);
  const proxyAssetUrls: Record<string, string> = {};
  const originalAssetUrls: Record<string, string> = {};
  const mediaDims: Record<string, { width: number | null; height: number | null }> = {};
  const mediaStartPtsUs: Record<string, number | null> = {};
  // Per-media source color, applied to WHATEVER the export decodes — the
  // original trivially carries its own ffprobe tags, and a proxy PRESERVES the
  // source's colorimetry (the recipe never converts matrix/range, and since
  // PROXY_FORMAT_VERSION 7 asserts the source tags + a colr atom outright).
  // mediabunny's own container tag still outranks this per-field in
  // `withDefaultColorSpace`, so a self-describing proxy reads its colr and an
  // older colr-less one falls back to these source tags instead of the
  // bt709/limited resolution default that misread full-range/601 proxies.
  const mediaColor: Record<string, VideoColorSpaceInit | undefined> = {};
  for (const m of init.mediaById.values()) {
    const exportPath = resolveDecode(m).exportPath;
    if (m.kind === "Video" && referenced.has(m.id) && !exportPath) {
      throw new Error(
        `Internal: "${m.label}" has no export-ready source (the readiness gate should have prevented this).`,
      );
    }
    if (exportPath) proxyAssetUrls[m.id] = convertFileSrc(exportPath);
    originalAssetUrls[m.id] = convertFileSrc(m.path);
    mediaDims[m.id] = { width: m.width, height: m.height };
    mediaStartPtsUs[m.id] = m.video_start_pts_us ?? m.start_pts_us ?? null;
    mediaColor[m.id] = ffprobeColorToWebCodecs(m);
  }

  // ── Native export-decode routing (hardcoded population rule) ──────────────
  // Gate: VITE_WEFTCUT_EXPORT_NATIVE=1. Route every referenced WebCodecs-BLIND
  // video ORIGINAL — persisted `decode_route.route === "native-sw"` (ProRes/
  // DNxHD/…), the cheaply-available blind-spot verdict at this layer — through
  // the native `NativeExportSourceHandle` (decode the original via the napi
  // session over the frame relay) instead of the in-worker WebCodecs proxy
  // path. `m.path` is the absolute original file the napi opens. The
  // decode-engine resolver will own this population rule. Flag unset ⇒ empty
  // map + `nativeDecode` undefined ⇒ behavior unchanged.
  const originalFilePaths: Record<string, string> = {};
  const nativeDecodeMediaIds: string[] = [];
  if (import.meta.env.VITE_WEFTCUT_EXPORT_NATIVE === "1") {
    for (const m of init.mediaById.values()) {
      if (m.kind !== "Video" || !referenced.has(m.id)) continue;
      if (m.decode_route.route !== "native-sw" || !m.path) continue;
      originalFilePaths[m.id] = m.path;
      nativeDecodeMediaIds.push(m.id);
    }
  }

  const snapshot: ExportProjectSnapshot = {
    width: comp.width,
    height: comp.height,
    fpsNum,
    fpsDen,
    durationUs: summary.duration_us,
    summary,
    proxyAssetUrls,
    originalAssetUrls,
    mediaDims,
    mediaStartPtsUs,
    mediaColor,
    originalFilePaths,
  };

  // 2. OffscreenCanvas to transfer to the Worker.
  const offscreen = new OffscreenCanvas(comp.width, comp.height);

  // 3. Encoder config. Output fps follows the caller's override, else
  // composition fps. The default config's framerate must match.
  const outFpsNum = init.outputFps?.num ?? fpsNum;
  const outFpsDen = init.outputFps?.den ?? fpsDen;
  const encoderConfig =
    init.encoderConfig ??
    defaultEncoderConfig(comp.width, comp.height, outFpsNum / outFpsDen);

  // 4. Spawn the Worker. Vite resolves the URL at bundle time via
  // `new URL(..., import.meta.url) + type: "module"`.
  const worker = new Worker(
    new URL("./exportWorker.ts", import.meta.url),
    { type: "module" },
  );
  // Latch the ready handshake NOW, before any await. The Worker posts
  // {type:"ready"} as soon as its module top level runs; once its code cache is
  // warm (every export after the session's first) that beats the font fetches
  // awaited below, and a message dispatched while no listener is attached is
  // silently dropped — start would never be posted and the export would hang at
  // "starting" forever. The same window would swallow a worker load/parse error.
  const workerReady = new Promise<void>((resolve, reject) => {
    function onMsg(e: MessageEvent<ExportEvent>) {
      if (e.data.type !== "ready") return;
      detach();
      resolve();
    }
    function onErr(e: ErrorEvent) {
      detach();
      reject(new Error(e.message || "export worker errored"));
    }
    function detach() {
      worker.removeEventListener("message", onMsg);
      worker.removeEventListener("error", onErr);
    }
    worker.addEventListener("message", onMsg);
    worker.addEventListener("error", onErr);
  });
  // No-op catch: a worker load failure during the awaits below would otherwise
  // fire unhandledrejection before the export promise wires its real handler.
  workerReady.catch(() => {});

  // 5. Build the tenBitMedia map: sources whose originals Chromium/Electron can decode
  // to I420P10 (H.264 Hi10P + AV1 10-bit — `tenBitExportCapable`). Only
  // populated on the 10-bit path; the Worker uses this to route those
  // sources through the 10-bit lane.
  const tenBitMedia: Record<string, boolean> = {};
  if (init.bitDepth === 10) {
    for (const m of init.mediaById.values()) {
      if (m.kind === "Video" && tenBitExportCapable(m)) {
        tenBitMedia[m.id] = true;
      }
    }
  }

  // 6. Build the start request (fonts resolve on the main thread); posted once
  // the pre-await `workerReady` latch resolves.
  const motifFrames = init.motifFrames ?? {};
  const userFamilies = collectTextFontFamilies(summary);
  const userBytes = await resolveFontsForFamilies(userFamilies);
  const fontBytes = { ...(await loadBundledFontBytes()), ...userBytes };
  const startReq: Extract<ExportRequest, { type: "start" }> = {
    type: "start",
    project: snapshot,
    startUs,
    endUs,
    encoderConfig,
    outputFpsNum: outFpsNum,
    outputFpsDen: outFpsDen,
    keyframeIntervalSec: init.keyframeIntervalSec ?? 1,
    canvas: offscreen,
    motifFrames,
    bitDepth: init.bitDepth ?? 8,
    ...(init.nativeSinkPixFmt ? { nativeSink: { pixFmt: init.nativeSinkPixFmt } } : {}),
    ...(Object.keys(tenBitMedia).length > 0 ? { tenBitMedia } : {}),
    // Hardcoded native export-decode routing (see above); absent when the env
    // flag is unset so the WebCodecs proxy path is unchanged.
    ...(nativeDecodeMediaIds.length > 0
      ? { nativeDecode: { mediaIds: nativeDecodeMediaIds, creditWindow: 6 } }
      : {}),
    fonts: fontBytes,
  };

  // ImageBitmaps are transferable; transferring them avoids a structured-clone
  // copy AND keeps the main-thread originals from being double-owned (transfer
  // neuters them, which is fine — the bake's bitmaps exist only to ship here).
  // Flattened across every layer's array; head holes (undefined, for a
  // mid-layer export start) are skipped.
  const bitmapTransfers: Transferable[] = [];
  for (const frames of Object.values(motifFrames)) {
    for (const bmp of frames) {
      if (bmp) bitmapTransfers.push(bmp);
    }
  }

  let framesEncoded = 0;
  let totalFrames = 0;

  return new Promise<RunExportResult>((resolve, reject) => {
    // ── Native export-decode relay ───────────────────────────────────────────
    // The renderer main thread is a PURE relay between the export Worker's
    // `NativeExportSourceHandle` and the main-process `NativeDecode` session:
    // tagged `ExportSwMsg`s (frames AND rangeEnd/ended/error) arrive on the ONE
    // ordered `exportSw:msg` channel and are posted to the Worker synchronously
    // in arrival order — never split control onto a second subscription;
    // ordering is the contract (see `ExportSwMsg` in shared/ipc). The reverse
    // commands (nd:open / nd:decodeRange / nd:returnCredit / nd:close) arrive
    // in `worker.onmessage` below. Unsubscribed in `cleanup()` so the listener
    // doesn't leak across exports.
    const offMsg = window.api.exportSw.onMsg((m) => {
      switch (m.kind) {
        case "frame": {
          const f = m.frame;
          // The one main→renderer copy already happened (structured-clone to a
          // Uint8Array); hand its ArrayBuffer to the Worker zero-copy via
          // transfer. A view spanning its whole buffer transfers directly; a
          // partial view is sliced to a fresh, exactly-sized buffer first.
          const u8 = f.data;
          const ab = (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
            ? u8.buffer
            : u8.slice().buffer) as ArrayBuffer;
          // Optional color tags via conditional spread — `exactOptionalPropertyTypes`
          // forbids writing `undefined` into an exact-optional `string` field.
          worker.postMessage(
            {
              type: "nd:frame",
              frame: {
                sessionId: f.sessionId,
                ptsUs: f.ptsUs,
                durUs: f.durUs,
                width: f.width,
                height: f.height,
                ...(f.colorMatrix !== undefined ? { colorMatrix: f.colorMatrix } : {}),
                ...(f.colorRange !== undefined ? { colorRange: f.colorRange } : {}),
                ...(f.colorPrimaries !== undefined ? { colorPrimaries: f.colorPrimaries } : {}),
                ...(f.colorTransfer !== undefined ? { colorTransfer: f.colorTransfer } : {}),
                data: ab,
              },
            } satisfies ExportRequest,
            [ab],
          );
          return;
        }
        case "rangeEnd":
          worker.postMessage({
            type: "nd:rangeEnd",
            sessionId: m.sessionId,
          } satisfies ExportRequest);
          return;
        case "ended":
          worker.postMessage({
            type: "nd:ended",
            sessionId: m.sessionId,
          } satisfies ExportRequest);
          return;
        case "error":
          worker.postMessage({
            type: "nd:error",
            sessionId: m.sessionId,
            message: m.message,
          } satisfies ExportRequest);
          return;
      }
    });

    const cleanup = () => {
      offMsg();
      // A terminated Worker may never flush its per-session `nd:close` (on cancel
      // it is torn down before draining; on success it posts `done` before its
      // pool disposes), so reap any still-open native sessions on the main side
      // here — on every terminal path — or the native decode threads leak.
      if (nativeDecodeMediaIds.length > 0) window.api.exportSw.closeAll();
      worker.terminate();
    };

    init.signal?.addEventListener("abort", () => {
      worker.postMessage({ type: "cancel" } satisfies ExportRequest);
      cleanup();
      reject(new Error("export cancelled"));
    });

    worker.onerror = (e: ErrorEvent) => {
      cleanup();
      reject(new Error(e.message || "export worker errored"));
    };

    // Post start once the ready latch resolves (it usually already has by now).
    // Rejection = the worker failed to load/parse before ever reporting ready.
    workerReady.then(
      () => {
        worker.postMessage(startReq, [offscreen, ...bitmapTransfers, ...Object.values(fontBytes)]);
      },
      (err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );

    worker.onmessage = (e: MessageEvent<ExportEvent>) => {
      const ev = e.data;
      if (ev.type === "progress") {
        framesEncoded = ev.framesEncoded;
        totalFrames = ev.totalFrames;
        init.onProgress?.(framesEncoded, totalFrames);
      } else if (ev.type === "chunk") {
        // Append the slice to disk, then ack so the Worker releases the next
        // write. Errors abort the export. Serialized by the Worker (one
        // pending write at a time), so no ordering bookkeeping needed here.
        init
          .writeChunk(ev.data)
          .then(() => {
            worker.postMessage({ type: "chunk-ack" } satisfies ExportRequest);
          })
          .catch((err: unknown) => {
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      } else if (ev.type === "done") {
        // E2E-only: surface the worker's perf counters for the harness to read
        // (stripped from prod by the static env check).
        if (import.meta.env.VITE_WEFTCUT_E2E === "1" && ev.perf) {
          (window as unknown as { __weftcutExportPerf?: unknown }).__weftcutExportPerf =
            ev.perf;
        }
        cleanup();
        resolve({ framesEncoded, totalFrames });
      } else if (ev.type === "error") {
        cleanup();
        reject(new Error(ev.message));
      } else if (ev.type === "nd:open") {
        // Native export-decode: open the main-process session and reply with
        // the correlated result. Any open failure surfaces to the Worker's
        // handle (`ensureReady` rejects → the export aborts).
        window.api.exportSw
          .open({
            sessionId: ev.sessionId,
            path: ev.path,
            outFormat: ev.outFormat,
            creditWindow: ev.creditWindow,
          })
          .then((info) => {
            worker.postMessage({
              type: "nd:openResult",
              reqId: ev.reqId,
              ok: true,
              info,
            } satisfies ExportRequest);
          })
          .catch((err: unknown) => {
            worker.postMessage({
              type: "nd:openResult",
              reqId: ev.reqId,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            } satisfies ExportRequest);
          });
      } else if (ev.type === "nd:decodeRange") {
        window.api.exportSw.decodeRange({ sessionId: ev.sessionId, aUs: ev.aUs, bUs: ev.bUs });
      } else if (ev.type === "nd:returnCredit") {
        window.api.exportSw.returnCredit({ sessionId: ev.sessionId, credits: ev.credits });
      } else if (ev.type === "nd:close") {
        window.api.exportSw.close({ sessionId: ev.sessionId });
      }
    };
  });
}

/// Collect distinct font_family strings from all Text layers in the project.
/// Feeds `resolveFontsForFamilies` so the export Worker receives any
/// user-chosen OS fonts pre-resolved as bytes (main-thread IPC only).
function collectTextFontFamilies(summary: ProjectSummary): string[] {
  const families: string[] = [];
  for (const track of summary.tracks) {
    for (const layer of track.layers) {
      if (layer.params.kind === "Text" && layer.params.font_family) {
        families.push(layer.params.font_family);
      }
    }
  }
  return [...new Set(families)];
}
