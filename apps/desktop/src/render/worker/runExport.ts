// Main-thread harness for the export Worker. Drives one export from
// "user clicked export" to "MP4 bytes in hand" — Worker spawning,
// project snapshot serialization, OffscreenCanvas transfer, progress
// streaming, byte collection.
//
// Plan: docs/pixi-renderer-plan.md (P9)
//
// Callers (ExportPanel, Render & Play, future MCP tool) get one
// Promise<ArrayBuffer> for the video-only MP4. Audio mux runs on
// the Rust side after this resolves.

import { convertFileSrc } from "@tauri-apps/api/core";

import type { MediaSummary, ProjectSummary } from "../../ipc";
import { exportPlaybackPathFor } from "../../state/projectStore";
import { referencedVideoMediaIds } from "../activeVideoLayers";
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
  /// Optional progress callback. Fires with (framesEncoded,
  /// totalFrames) on every progress event.
  onProgress?: (encoded: number, total: number) => void;
  /// Sink for each sequential output-file slice (fMP4, append-only). Called in
  /// order; must resolve once the slice is durably written (the Worker awaits
  /// the ack before releasing the next write → backpressure). Streaming to disk
  /// avoids buffering the whole MP4 in one ArrayBuffer (V8's ~2GB cap OOM'd
  /// long exports at finalize).
  writeChunk: (data: ArrayBuffer) => Promise<void>;
  /// Optional cancel signal — the Worker checks at each frame
  /// boundary.
  signal?: AbortSignal;
}

export interface RunExportResult {
  /// (encoded, total). After a clean run, encoded === total.
  framesEncoded: number;
  totalFrames: number;
}

/// Default 1080p H.264 encoder config used when the caller doesn't
/// supply one. Matches the proxy spec we already have: High profile,
/// Level 4.2, yuv420p — universally hardware-decodable downstream.
/// Framerate follows the composition (the hardcoded 30 was a latent bug
/// for non-30fps projects).
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

  // 1. Pre-resolve asset URLs for every media item. The Worker has no Tauri
  // runtime so it can't call `convertFileSrc` itself. Only REFERENCED video
  // sources must have a ready export path — the export-readiness gate in App
  // (decodability probe + route-correction + auto-wait) guarantees that before
  // calling here; the throw below is a defensive assertion, not the
  // user-facing decodability path.
  const referenced = referencedVideoMediaIds(summary, startUs, endUs);
  const proxyAssetUrls: Record<string, string> = {};
  const originalAssetUrls: Record<string, string> = {};
  const mediaDims: Record<string, { width: number | null; height: number | null }> = {};
  for (const m of init.mediaById.values()) {
    const proxyPath = exportPlaybackPathFor(m);
    if (m.kind === "Video" && referenced.has(m.id) && !proxyPath) {
      throw new Error(
        `Internal: "${m.label}" has no export-ready source (the readiness gate should have prevented this).`,
      );
    }
    if (proxyPath) proxyAssetUrls[m.id] = convertFileSrc(proxyPath);
    originalAssetUrls[m.id] = convertFileSrc(m.path);
    mediaDims[m.id] = { width: m.width, height: m.height };
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

  // 5. Wait for ready, then post start.
  const startReq: Extract<ExportRequest, { type: "start" }> = {
    type: "start",
    project: snapshot,
    startUs,
    endUs,
    encoderConfig,
    outputFpsNum: outFpsNum,
    outputFpsDen: outFpsDen,
    canvas: offscreen,
  };

  let framesEncoded = 0;
  let totalFrames = 0;

  return new Promise<RunExportResult>((resolve, reject) => {
    const cleanup = () => {
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

    worker.onmessage = (e: MessageEvent<ExportEvent>) => {
      const ev = e.data;
      if (ev.type === "ready") {
        worker.postMessage(startReq, [offscreen]);
      } else if (ev.type === "progress") {
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
        cleanup();
        resolve({ framesEncoded, totalFrames });
      } else if (ev.type === "error") {
        cleanup();
        reject(new Error(ev.message));
      }
    };
  });
}
