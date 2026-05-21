// Handle types for the PixiJS preview surface. Kept in a non-
// component module so Vite's React Fast Refresh doesn't bail on
// `PixiPreview.tsx` ("component file exports non-component values").
//
// The `?pixi=1` opt-in flag is gone — the Pixi compositor is the only
// preview surface after P12-e. Devtools hooks check
// `window.__weftcut_*` directly and no longer need the flag.

/// Result of a successful Pixi export. The handle just delivers
/// the bytes — writing them to disk + showing UI is the caller's
/// job so App.tsx can drive the save dialog + ExportPanel state
/// without PixiPreview needing to know about either.
export interface PixiExportResult {
  videoBytes: ArrayBuffer;
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
  /// Run the PixiJS-backed export. The compositor + engine are
  /// suspended for the duration so the preview decoder doesn't fight
  /// the export decoder for the hardware decode slot. Resolves with
  /// the encoded MP4 bytes; rejects on failure.
  ///
  /// The handle does not write the bytes anywhere — App.tsx owns
  /// the save dialog + file write so the existing ExportPanel
  /// progress UI can drive both pipelines.
  runExport(opts?: {
    onProgress?: (encoded: number, total: number) => void;
  }): Promise<PixiExportResult>;
}
