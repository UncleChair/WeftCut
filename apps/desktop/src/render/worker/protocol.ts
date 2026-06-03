// postMessage protocol between the main thread and the export Worker.
//
// Plan: docs/pixi-renderer-plan.md (P8)
//
// The Worker is constructed once per export, receives one `start`
// request, streams `progress` events, posts a final `done` (with
// MP4 bytes) or `error`, then terminates. The main-thread shell
// `terminate()`s the worker after `done` to release its heap.

/// Snapshot of project state needed to render the export. The Worker
/// receives this as a structured-clone of the live `ProjectSummary`,
/// so live edits to the project after `start` do NOT affect the
/// in-flight export.
export interface ExportProjectSnapshot {
  /// Composition dimensions. Echoed back in the encoder config.
  width: number;
  height: number;
  /// Project fps (numerator / denominator). Determines the frame
  /// grid the export iterates and the encoder's framerate.
  fpsNum: number;
  fpsDen: number;
  /// Total composition duration in microseconds; the Worker may
  /// clamp `endUs` against this.
  durationUs: number;
  /// Same shape `Compositor.setProject(summary)` consumes —
  /// `tracks: [{ enabled, layers: [{ id, t_start_us, t_end_us,
  /// enabled, params: { kind, ... } }] }]`. Worker treats this as
  /// opaque and forwards to its own Compositor instance.
  summary: unknown;
  /// `media_id → asset URL` resolved on the main thread before the
  /// Worker request is posted. The Worker can't call Tauri's
  /// `convertFileSrc()` (no Tauri runtime inside the Worker), so
  /// the main thread pre-resolves every URL the renderer might
  /// need.
  proxyAssetUrls: Record<string, string>;
  originalAssetUrls: Record<string, string>;
  /// `media_id → MediaSummary` slim copy. Worker reads dimensions
  /// for fallback positioning math; the full MediaSummary is too
  /// large to copy. Only `width` / `height` are needed.
  mediaDims: Record<string, { width: number | null; height: number | null }>;
  /// `media_id → source color tags`, present (defined) ONLY for media the
  /// export decodes from the ORIGINAL file (DirectExport); undefined for proxy
  /// decodes and untagged sources. A plain serializable object (postMessage-
  /// safe). The Worker passes it into each `SourceHandle` so the original
  /// decodes with its real matrix/range — see `withDefaultColorSpace`.
  mediaColor: Record<string, VideoColorSpaceInit | undefined>;
}

export type ExportRequest =
  | {
      type: "start";
      project: ExportProjectSnapshot;
      /// Time range to encode in microseconds (inclusive of
      /// `startUs`, exclusive of `endUs`).
      startUs: number;
      endUs: number;
      /// VideoEncoder config (codec / bitrate / hardware
      /// preference / etc). Main thread builds this from
      /// `defaultEncoderConfig(width, height)` in `runExport.ts`.
      encoderConfig: VideoEncoderConfig;
      /// Output frame rate as a rational (overrides composition fps for the
      /// export frame grid + capture cadence). Absent ⇒ use the project's
      /// composition fps.
      outputFpsNum?: number;
      outputFpsDen?: number;
      /// OffscreenCanvas transferred from the main thread. Worker
      /// hands it to the PixiJS Application as the render target.
      canvas: OffscreenCanvas;
    }
  | { type: "cancel" }
  /// Backpressure ack: the main thread finished writing the most recent
  /// `chunk` to disk; the worker's WritableStream may release the next write.
  | { type: "chunk-ack" };

/// Aggregate export-perf counters, posted with `done`. Used by the E2E
/// harness to measure decode efficiency (e.g. the long-GOP re-seek redundancy:
/// `totalDispatched` ≫ `totalFrames` means the decoder re-decoded packets).
export interface ExportPerf {
  totalFrames: number;
  /// Sum of packets fed to the source decoder(s) across all chunks. With a
  /// 1:1 export this should be ~`totalFrames`; a large excess is re-decode waste.
  totalDispatched: number;
  /// Wall-clock spent in `decodeRange` dispatch, awaiting decoder output, and
  /// the whole export, in ms.
  decodeMs: number;
  waitMs: number;
  totalMs: number;
  /// E2E color diagnostic off the first decoded frame (config vs stamped
  /// colorSpace + format). `ExportColorDiag` from ExportDecoderPool; typed
  /// `unknown` here to avoid coupling the message contract to the decoder.
  colorDiag?: unknown;
}

export type ExportEvent =
  | { type: "ready" }
  | { type: "progress"; framesEncoded: number; totalFrames: number }
  /// One sequential slice of the output file (fMP4, append-only). The main
  /// thread appends it to the temp file and replies with `chunk-ack`. Streamed
  /// instead of buffering the whole MP4 in one ArrayBuffer (V8 caps that at
  /// ~2GB → long exports OOM'd at finalize).
  | { type: "chunk"; data: ArrayBuffer }
  /// Encode + mux complete; the temp file is fully written on the main side.
  /// `perf` carries aggregate decode/timing counters for the E2E harness.
  | { type: "done"; perf?: ExportPerf }
  | { type: "error"; message: string };
