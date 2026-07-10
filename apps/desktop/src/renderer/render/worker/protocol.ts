// postMessage protocol between the main thread and the export Worker.
//
// See docs/render.md — "Export Worker".
//
// The Worker is constructed once per export, receives one `start` request,
// streams `progress` + `chunk` events, posts a final `done` with counters
// or `error`, then terminates. The main-thread shell `terminate()`s the
// worker after `done` to release its heap.

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
  /// Worker request is posted. The Worker can't call the renderer's
  /// `convertFileSrc()` (no renderer bridge inside the Worker), so
  /// the main thread pre-resolves every URL the renderer might
  /// need.
  proxyAssetUrls: Record<string, string>;
  originalAssetUrls: Record<string, string>;
  /// `media_id → MediaSummary` slim copy. Worker reads dimensions
  /// for fallback positioning math; the full MediaSummary is too
  /// large to copy. Only `width` / `height` are needed.
  mediaDims: Record<string, { width: number | null; height: number | null }>;
  /// `media_id → video stream start PTS` in microseconds. Source windows are
  /// normalized to content time; export decoders add this offset when seeking
  /// packets and subtract it when storing decoded frames.
  mediaStartPtsUs: Record<string, number | null>;
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
      /// Seconds between forced keyframes. The Worker derives the GOP (frames)
      /// from this at the output fps. Absent ⇒ 1 second.
      keyframeIntervalSec?: number;
      /// OffscreenCanvas transferred from the main thread. Worker
      /// hands it to the PixiJS Application as the render target.
      canvas: OffscreenCanvas;
      /// `layerId → ImageBitmap[]` — pre-rasterized Motif-layer frames,
      /// indexed by COMPOSITION-frame. The Worker has no DOM so it can't run
      /// the SVG capture harness; the main thread bakes these (`exportBake.ts`)
      /// and TRANSFERS them (the flattened bitmaps are added to the
      /// `postMessage` transfer list). The Worker's `Compositor`/`MotifSprite`
      /// binds `motifFrames[layerId][frameIndex]` synchronously. Absent /
      /// empty ⇒ no Motif layers in range (e.g. a video-only export), and the
      /// injected-frames path is a clean no-op. The array may have head holes
      /// (`undefined` before the export-range's first comp-frame) for a
      /// mid-layer export start — the Worker never requests those indices.
      motifFrames: Record<string, ImageBitmap[]>;
      /// 10 ⇒ f16/WebGL2 composite precision. Whether frames go to the native
      /// sink is `nativeSink` below — the two are independent (8-bit native
      /// composites RGBA8 but still packs + streams).
      bitDepth?: 8 | 10;
      /// Present ⇒ pack each frame to `pixFmt` and stream raw frames over the
      /// chunk/ack channel to the ffmpeg video sink (no WebCodecs encoder).
      /// Absent ⇒ the WebCodecs EncoderSink/fMP4 path.
      nativeSink?: { pixFmt: "yuv420p" | "yuv420p10le" | "yuv422p" | "yuv422p10le" };
      /// mediaIds whose ORIGINAL decodes 10-bit in the renderer; these acquire
      /// originalAssetUrls + tenBitLane + preferSoftware.
      tenBitMedia?: Record<string, boolean>;
      /// Bundled font bytes (family → ArrayBuffer), FontFace-loaded into the
      /// Worker's `self.fonts` before renderer init so burned-in Text/captions
      /// don't tofu. Transferred, not copied.
      fonts: Record<string, ArrayBuffer>;
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
  /// One sequential slice of the output file (fMP4, append-only) in the 8-bit
  /// WebCodecs path, or one raw yuv420p10le frame in the 10-bit native-encode
  /// path. The main thread appends fMP4 slices to the temp file and forwards
  /// 10-bit frames to export_video_sink_write. Replies with chunk-ack in both
  /// cases.
  | { type: "chunk"; data: ArrayBuffer }
  /// Encode + mux complete; the temp file is fully written on the main side.
  /// `perf` carries aggregate decode/timing counters for the E2E harness.
  | { type: "done"; perf?: ExportPerf }
  | { type: "error"; message: string };
