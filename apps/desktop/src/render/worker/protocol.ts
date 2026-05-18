// postMessage protocol between the main thread and the export Worker.
//
// Plan: docs/pixi-renderer-plan.md (P8)

export type ExportRequest =
  | {
      type: "start";
      /// Snapshot of project state needed to render (layers, timeline,
      /// composition dimensions). P8 will firm up this shape; today
      /// `unknown` is a placeholder until the snapshot module exists.
      project: unknown;
      /// Output dimensions in pixels.
      width: number;
      height: number;
      /// Target frame rate.
      fps: number;
      /// Time range to encode in microseconds (inclusive of `startUs`,
      /// exclusive of `endUs`).
      startUs: number;
      endUs: number;
      /// VideoEncoder config payload — codec / bitrate / hardware pref.
      encoderConfig: VideoEncoderConfig;
    }
  | { type: "cancel" };

export type ExportEvent =
  | { type: "ready" }
  | { type: "progress"; framesEncoded: number; totalFrames: number }
  | { type: "done"; videoBytes: ArrayBuffer }
  | { type: "error"; message: string };
