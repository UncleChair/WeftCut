/// Project preview surface. Renders the project through the Pixi
/// compositor (the only preview path) inside a PixiErrorBoundary, or an
/// empty-state / loading placeholder when there is no content or no
/// composition yet. Forwards play/pause/seek/refresh/export to the
/// underlying PixiPreview.

import { forwardRef, useImperativeHandle, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useProjectStore } from "../state/projectStore";
import { PixiPreview } from "../render/PixiPreview";
import type {
  PixiExportResult,
  PixiPreviewHandle,
} from "../render/pixiPreviewFlag";
import { PixiErrorBoundary } from "../render/PixiErrorBoundary";

interface Props {
  /// True when the project has at least one layer. When false we
  /// render the empty-state placeholder.
  hasContent: boolean;
  /// Master clock callback in microseconds. Engine throttles to
  /// ~30 Hz so this is safe to drop into React state directly.
  onTimeUpdate: (tUs: number) => void;
  /// Mirror of `engine.isPlaying()`, inverted to the "paused" boolean the
  /// parent's transport button expects.
  onPausedChange: (paused: boolean) => void;
  /// Live accessor for the session decodability verdict (App's
  /// decodeProbeMemo). When it returns true for a source, the preview
  /// resolver shows the original immediately instead of waiting on a proxy.
  previewDecodableOf?: (mediaId: string) => boolean;
}

export interface PreviewSurfaceHandle {
  play(): void;
  pause(): void;
  seekTo(tUs: number): void;
  paused(): boolean;
  /// Re-resolve every clip's preview source against the live decodability
  /// bridge and re-composite. Delegates to the underlying PixiPreview.
  refreshSources(): void;
  /// Run the Pixi export pipeline. Resolves with the encoded MP4
  /// bytes; rejects on failure. App.tsx owns the save dialog + file
  /// write so the existing ExportPanel can drive the pipeline.
  runPixiExport(opts: {
    onProgress?: (encoded: number, total: number) => void;
    encoderConfig?: VideoEncoderConfig;
    outputFps?: { num: number; den: number };
    startUs?: number;
    endUs?: number;
    keyframeIntervalSec?: number;
    writeChunk: (data: ArrayBuffer) => Promise<void>;
    /// Pre-rasterized Motif-layer frames baked on the main thread before
    /// launching the export Worker (which has no DOM). Threaded through to
    /// `runExport` and transferred into the Worker.
    motifFrames?: Record<string, ImageBitmap[]>;
    /// Output bit depth (8 = existing pipeline; 10 = f16/WebGL2 + native-encode).
    bitDepth?: 8 | 10;
    /// Present ⇒ the worker packs frames to this format and streams them to
    /// the native ffmpeg sink instead of WebCodecs-encoding.
    nativeSinkPixFmt?: "yuv420p" | "yuv420p10le" | "yuv422p" | "yuv422p10le";
  }): Promise<PixiExportResult>;
}

export const PreviewSurface = forwardRef<PreviewSurfaceHandle, Props>(
  function PreviewSurface(
    { hasContent, onTimeUpdate, onPausedChange, previewDecodableOf },
    forwardedRef,
  ) {
    const { t } = useTranslation();
    const composition = useProjectStore((s) => s.summary?.composition);

    const pixiRef = useRef<PixiPreviewHandle | null>(null);

    useImperativeHandle(
      forwardedRef,
      (): PreviewSurfaceHandle => ({
        play() {
          pixiRef.current?.play();
        },
        pause() {
          pixiRef.current?.pause();
        },
        seekTo(tUs: number) {
          pixiRef.current?.seek(tUs);
        },
        paused() {
          return pixiRef.current?.paused() ?? true;
        },
        refreshSources() {
          pixiRef.current?.refreshSources();
        },
        async runPixiExport(opts) {
          const handle = pixiRef.current;
          if (!handle) {
            throw new Error("Pixi preview is not initialized yet.");
          }
          return handle.runExport(opts);
        },
      }),
      [],
    );

    if (!hasContent) {
      return <span className="placeholder">{t("preview.empty_hint")}</span>;
    }
    if (!composition) {
      return (
        <div className="preview-loading" aria-live="polite">
          <span className="preview-spinner" aria-hidden="true" />
          <span className="placeholder">{t("preview.preparing")}</span>
        </div>
      );
    }

    return (
      <div
        className="preview-video"
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          overflow: "hidden",
          // Letterbox bars stay pure black (broadcast convention) — the
          // `.preview-video { background: #000 }` rule owns this surface.
        }}
      >
        <PixiErrorBoundary>
          <PixiPreview
            ref={pixiRef}
            onTimeUpdate={onTimeUpdate}
            onPausedChange={onPausedChange}
            previewDecodableOf={previewDecodableOf}
          />
        </PixiErrorBoundary>
      </div>
    );
  },
);
