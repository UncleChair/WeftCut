// postMessage protocol between the main thread and the export Worker.
//
// See docs/render.md — "Export Worker".
//
// The Worker is constructed once per export, receives one `start` request,
// streams `progress` + `chunk` events, posts a final `done` with counters
// or `error`, then terminates. The main-thread shell `terminate()`s the
// worker after `done` to release its heap.

import type { ExportTransportFormat } from "../exportDecodeRouting";

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
  /// `media_id → source color tags`, one entry per media whose ffprobe tags
  /// mapped (undefined only for untagged / unmapped sources). Applies to the
  /// ORIGINAL and proxy decodes alike — a proxy preserves the source
  /// colorimetry. A plain serializable object (postMessage-safe). The Worker
  /// passes it into each `SourceHandle` so the decode carries its real
  /// matrix/range — see `withDefaultColorSpace`.
  mediaColor: Record<string, VideoColorSpaceInit | undefined>;
  /// `media_id → absolute ORIGINAL file path`, resolved on the main thread for
  /// media the export routes through the native decode session. The napi
  /// `exportSwOpen` opens a filesystem path (not a `weftcut-media://` asset
  /// URL), and the Worker can't resolve one itself — so the main thread
  /// pre-resolves it here, exactly as it pre-resolves the asset URLs above.
  /// Present only for native-routed media (see `ExportRequest.nativeDecode`).
  originalFilePaths: Record<string, string>;
}

/// One native-decoded frame handed from the renderer-main relay to the export
/// Worker's `NativeExportSourceHandle`. Same fields as the IPC `ExportSwFrameMsg`
/// but `data` is an `ArrayBuffer` TRANSFERRED (zero-copy) rather than a
/// structured-cloned `Uint8Array` — the worker wraps it in a `NativeNv12Frame`
/// (NV12) or a `TenBitFrame` (I420P10) per `format` and pushes it into the
/// ring; both convert in the Compositor's GL ingest shaders, never through
/// `new VideoFrame` (why: see nv12Frame.ts).
/// The handle cross-checks `format` against its session's `outFormat`.
export interface NativeDecodeFrameMsg {
  sessionId: string;
  ptsUs: number;
  durUs: number;
  width: number;
  height: number;
  format: ExportTransportFormat;
  colorMatrix?: string;
  colorRange?: string;
  colorPrimaries?: string;
  colorTransfer?: string;
  data: ArrayBuffer;
}

/// Reply to a `nd:open` command (renderer-main → worker). Mirrors the napi
/// `ExportSwOpenInfoJs`. Inlined here to keep `protocol.ts` dependency-free.
export interface NativeDecodeOpenInfo {
  width: number;
  height: number;
  colorMatrix?: string;
  colorRange?: string;
  colorPrimaries?: string;
  colorTransfer?: string;
  startPtsUs: number;
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
      /// preference / etc). Main thread builds this from the export settings
      /// in `useExportFlow.ts`; `defaultEncoderConfig` in `runExport.ts` is
      /// the fallback when the caller supplies none.
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
      /// the CDP motif capture; the main thread bakes these (`exportBake.ts`)
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
      /// Platform verdict for the 8-bit WebCodecs decode lane, resolved ONCE
      /// on the renderer main thread (the Worker has no OS signal of its own).
      /// True ⇒ the lane may configure prefer-hardware; absent/false ⇒ it pins
      /// prefer-software — the Linux/NVIDIA black-frame workaround. Policy +
      /// rationale: `hwExportDecodeAllowed` (exportDecodeRouting.ts). The
      /// 10-bit lane's preferSoftware pin is a separate correctness
      /// requirement and ignores this flag.
      allowHwExportDecode?: boolean;
      /// mediaIds whose ORIGINAL decodes 10-bit in the renderer; these acquire
      /// originalAssetUrls + tenBitLane + preferSoftware.
      tenBitMedia?: Record<string, boolean>;
      /// The routing table's native slice (population rule + rationale in
      /// exportDecodeRouting.ts). `mediaIds` route through the native
      /// `NativeExportSourceHandle` (decode the ORIGINAL via the napi session
      /// over the frame relay) instead of the in-worker WebCodecs path;
      /// `outFormat` is those frames' CPU transport format. The Worker stays
      /// policy-free: it just tests membership at acquire time. `creditWindow`
      /// sizes the native flow-control window (frames in flight); absent ⇒
      /// engine default.
      nativeDecode?: {
        mediaIds: string[];
        outFormat: ExportTransportFormat;
        creditWindow?: number;
      };
      /// Bundled font bytes (family → ArrayBuffer), FontFace-loaded into the
      /// Worker's `self.fonts` before renderer init so burned-in Text/captions
      /// don't tofu. Transferred, not copied.
      fonts: Record<string, ArrayBuffer>;
    }
  | { type: "cancel" }
  /// Backpressure ack: the main thread finished writing the most recent
  /// `chunk` to disk; the worker's WritableStream may release the next write.
  | { type: "chunk-ack" }
  //
  // ── Native-decode relay: renderer-main → Worker ──────────────────────────
  // The reverse of the encode chunk channel. The renderer main thread relays
  // frames + control signals from the main-process `NativeDecode` session into
  // the Worker's `NativeExportSourceHandle`, keyed by `sessionId`.
  //
  /// Reply to a prior `nd:open` (correlated by `reqId`). `ok:false` carries the
  /// napi open failure (unsupported format / undecodable source).
  | { type: "nd:openResult"; reqId: number; ok: true; info: NativeDecodeOpenInfo }
  | { type: "nd:openResult"; reqId: number; ok: false; error: string }
  /// One decoded frame (NV12 or I420P10 per `frame.format`); `frame.data` is
  /// transferred (see the transfer list on the renderer-main `postMessage`).
  | { type: "nd:frame"; frame: NativeDecodeFrameMsg }
  /// The in-flight `decodeRange` delivered every frame in `[aUs, bUs]`.
  | { type: "nd:rangeEnd"; sessionId: string; aUs: number; bUs: number }
  /// End of stream: the session flushed its final GOP; no more frames ever.
  | { type: "nd:ended"; sessionId: string }
  /// A native session error (mid-decode failure); the handle fails its ring.
  | { type: "nd:error"; sessionId: string; message: string };

/// Aggregate export-perf counters, posted with `done`. Used by the E2E
/// harness to measure decode efficiency (e.g. the long-GOP re-seek redundancy:
/// `totalDispatched` ≫ `totalFrames` means the decoder re-decoded packets).
export interface ExportPerf {
  totalFrames: number;
  /// Sum of packets fed to the source decoder(s) across all chunks. With a
  /// 1:1 export this should be ~`totalFrames`; a large excess is re-decode waste.
  totalDispatched: number;
  /// Count of export-pool handles that were `NativeExportSourceHandle` (media
  /// routed through the in-process native decode session). Always present, 0
  /// when none routed — the native wedge gates assert ≥ 1 so a silent fallback
  /// to the WebCodecs proxy path cannot pass them vacuously.
  nativeHandles: number;
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
  /// Keyed on `nativeSink`, not bit depth: absent ⇒ one sequential slice of the
  /// output file (fMP4, append-only) from the WebCodecs path; present ⇒ one raw
  /// packed frame in the sink's `pixFmt` (any bit depth). The main thread
  /// appends fMP4 slices to the temp file and forwards raw frames to
  /// export_video_sink_write. Replies with chunk-ack in both cases.
  | { type: "chunk"; data: ArrayBuffer }
  /// Encode + mux complete; the temp file is fully written on the main side.
  /// `perf` carries aggregate decode/timing counters for the E2E harness.
  | { type: "done"; perf?: ExportPerf }
  | { type: "error"; message: string }
  //
  // ── Native-decode relay: Worker → renderer-main ──────────────────────────
  // Commands from the Worker's `NativeExportSourceHandle` down to the
  // main-process `NativeDecode` session (the renderer main thread forwards each
  // to `window.api.exportSw.*`). `nd:open` expects a matching `nd:openResult`
  // (`ExportRequest`) correlated by `reqId`; the rest are fire-and-forget.
  //
  | { type: "nd:open"; reqId: number; sessionId: string; path: string; outFormat: ExportTransportFormat; creditWindow: number }
  | { type: "nd:decodeRange"; sessionId: string; aUs: number; bUs: number }
  | { type: "nd:returnCredit"; sessionId: string; credits: number }
  | { type: "nd:close"; sessionId: string };
