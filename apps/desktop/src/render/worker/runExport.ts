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
import { ensureFullProxy } from "../../ipc";
import { exportPlaybackPathFor } from "../../state/projectStore";
import { probeSourceDecodable } from "../decoder/probeSourceDecodable";
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
  /// Optional progress callback. Fires with (framesEncoded,
  /// totalFrames) on every progress event.
  onProgress?: (encoded: number, total: number) => void;
  /// Optional cancel signal — the Worker checks at each frame
  /// boundary.
  signal?: AbortSignal;
}

export interface RunExportResult {
  videoBytes: ArrayBuffer;
  /// (encoded, total). After a clean run, encoded === total.
  framesEncoded: number;
  totalFrames: number;
}

/// Video sources whose export path is the ORIGINAL via the DirectExport route
/// (export_uses_original, no full proxy yet). DirectBoth (proxy_bypassed) is
/// H.264 and universally decodable, so it is skipped.
export function sourcesNeedingPreflight(
  mediaById: ReadonlyMap<string, MediaSummary>,
): MediaSummary[] {
  return [...mediaById.values()].filter(
    (m) => m.kind === "Video" && m.export_uses_original && !m.proxy_path,
  );
}

export interface PreflightDeps {
  urlFor: (m: MediaSummary) => string;
  probe: (assetUrl: string) => Promise<boolean>;
}

/// Returns the media ids that failed the decode pre-flight.
export async function preflightExportSources(
  mediaById: ReadonlyMap<string, MediaSummary>,
  deps: PreflightDeps,
): Promise<string[]> {
  const failed: string[] = [];
  // Sequential: N is almost always 0-1; Promise.all would spin up multiple
  // concurrent WebCodecs decoders for no practical gain.
  for (const m of sourcesNeedingPreflight(mediaById)) {
    const ok = await deps.probe(deps.urlFor(m));
    if (!ok) failed.push(m.id);
  }
  return failed;
}

/// Default 1080p H.264 encoder config used when the caller doesn't
/// supply one. Matches the proxy spec we already have: High profile,
/// Level 4.2, yuv420p — universally hardware-decodable downstream.
function defaultEncoderConfig(width: number, height: number): VideoEncoderConfig {
  return {
    codec: "avc1.640028",
    width,
    height,
    bitrate: 8_000_000,
    framerate: 30,
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

  // 1. Pre-resolve asset URLs for every media item in the project.
  // The Worker has no Tauri runtime so it can't call
  // `convertFileSrc` itself.
  const proxyAssetUrls: Record<string, string> = {};
  const originalAssetUrls: Record<string, string> = {};
  const mediaDims: Record<string, { width: number | null; height: number | null }> = {};
  for (const m of init.mediaById.values()) {
    const proxyPath = exportPlaybackPathFor(m);
    if (m.kind === "Video" && !proxyPath) {
      throw new Error(
        `Video "${m.label}" is still preparing its full proxy and cannot be exported yet.`,
      );
    }
    if (proxyPath) proxyAssetUrls[m.id] = convertFileSrc(proxyPath);
    originalAssetUrls[m.id] = convertFileSrc(m.path);
    mediaDims[m.id] = { width: m.width, height: m.height };
  }

  // Decode pre-flight: confirm this machine can actually decode each
  // DirectExport original before committing to the export. On failure,
  // enqueue a full proxy and abort with a retry message (the Worker is
  // never launched, so no partial file is produced).
  const undecodable = await preflightExportSources(init.mediaById, {
    urlFor: (m) => originalAssetUrls[m.id],
    probe: (url) => probeSourceDecodable(url),
  });
  if (undecodable.length > 0) {
    await Promise.all(
      undecodable.map((id) => ensureFullProxy(id)),
    );
    const labels = undecodable
      .map((id) => init.mediaById.get(id)?.label ?? id)
      .join(", ");
    throw new Error(
      `Can't decode ${labels} directly on this machine — preparing optimized media. Retry the export shortly.`,
    );
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

  // 3. Encoder config.
  const encoderConfig =
    init.encoderConfig ?? defaultEncoderConfig(comp.width, comp.height);

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
      } else if (ev.type === "done") {
        cleanup();
        resolve({
          videoBytes: ev.videoBytes,
          framesEncoded,
          totalFrames,
        });
      } else if (ev.type === "error") {
        cleanup();
        reject(new Error(ev.message));
      }
    };
  });
}
