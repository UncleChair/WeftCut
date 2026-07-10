// Handle types for the PixiJS preview surface. Kept in a non-
// component module so Vite's React Fast Refresh doesn't bail on
// `PixiPreview.tsx` ("component file exports non-component values").
//
// The Pixi compositor is the only preview surface, so there is no opt-in
// flag. Devtools hooks read the `window.__weftcut*` globals directly.

/// Result of a successful Pixi export. The output bytes are streamed to disk
/// via the caller's `writeChunk` during the run (not returned here) so the
/// whole MP4 is never held in one ArrayBuffer.
export interface PixiExportResult {
  framesEncoded: number;
  totalFrames: number;
  /// Output frame rate (fps_num / fps_den) — caller needs this to
  /// translate frame counts into ExportProgress.currentTimeUs and
  /// ExportComplete.durationUs.
  fpsNum: number;
  fpsDen: number;
}

/// Transport interface exposed by `<PixiPreview ref={...}>`. Mirrors
/// `PreviewSurfaceHandle` so the parent's imperative handle can
/// forward play/pause/seek straight through to the underlying PIXI
/// `PlaybackEngine` when the flag is on.
export interface PixiPreviewHandle {
  play(): void;
  pause(): void;
  seek(tUs: number): void;
  paused(): boolean;
  /// Re-resolve every clip's preview source against the current project +
  /// the live decodability bridge, then re-composite the current frame.
  /// Used to nudge a paused clip to pick up its original the moment a
  /// mid-session probe verdict flips to "ok".
  refreshSources(): void;
  /// Run the PixiJS-backed export. The compositor + engine are
  /// suspended for the duration so the preview decoder doesn't fight
  /// the export decoder for the hardware decode slot. Resolves with
  /// frame counters after video chunks have streamed through `writeChunk`;
  /// rejects on failure.
  ///
  /// App.tsx owns the save dialog, temp file, audio export, and final
  /// mux/transcode so the existing ExportPanel progress UI can drive the
  /// full pipeline.
  runExport(opts: {
    onProgress?: (encoded: number, total: number) => void;
    /// Full encoder config (codec/dims/bitrate/bitrateMode/framerate). When
    /// omitted, the worker falls back to its 1080p H.264 default.
    encoderConfig?: VideoEncoderConfig;
    /// Output fps rational (overrides composition fps). Omit ⇒ comp fps.
    outputFps?: { num: number; den: number };
    /// Sink for each sequential output-file slice (append-only). Must resolve
    /// once durably written; the worker backpressures on it.
    writeChunk: (data: ArrayBuffer) => Promise<void>;
    /// Pre-rasterized Motif-layer frames (`layerId → ImageBitmap[]`),
    /// baked on the main thread (the export Worker has no DOM). Transferred
    /// into the Worker and bound by comp-frame index. Omit ⇒ no motifs.
    motifFrames?: Record<string, ImageBitmap[]>;
    /// Output bit depth (8 = existing pipeline; 10 = f16/WebGL2 + native-encode).
    bitDepth?: 8 | 10;
    /// Present ⇒ the worker packs frames to this format and streams them to
    /// the native ffmpeg sink instead of WebCodecs-encoding.
    nativeSinkPixFmt?: "yuv420p" | "yuv420p10le" | "yuv422p" | "yuv422p10le";
  }): Promise<PixiExportResult>;
}
