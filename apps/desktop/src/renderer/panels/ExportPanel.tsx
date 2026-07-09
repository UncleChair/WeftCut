import { useTranslation } from "react-i18next";

import { AppDialog } from "../components/AppDialog";
import { Button } from "@/components/ui/button";

export interface ExportProgress {
  /// Which stage this progress is for. The ffmpeg path runs "encode" (the
  /// WebCodecs mezzanine, 0→100) then "transcode" (ffmpeg → target codec,
  /// 0→100); labeling the stage stops the bar's reset from reading as a stall.
  phase: "encode" | "transcode";
  progress: number;
  currentTimeUs: number;
  frame: number;
  fps: number;
  speed: number;
}

export interface ExportComplete {
  outputPath: string;
  durationUs: number;
}

export type ExportState =
  // `onCancel` is optional: the proxy-wait phase can abort its in-flight
  // wait, but the motif-bake phase has no cancellable step today, so it
  // omits the handler and the panel hides the Cancel button (rather than
  // showing one wired to a no-op).
  | { kind: "starting" }
  | { kind: "preparing"; labels: string[]; onCancel?: () => void }
  | { kind: "progress"; progress: ExportProgress }
  | { kind: "complete"; payload: ExportComplete }
  | { kind: "error"; detail: string };

export function ExportPanel({
  state,
  onClose,
  onPlay,
}: {
  state: ExportState;
  onClose: () => void;
  /// When set, the panel renders a "Play" button next to the dismiss
  /// button on the complete state. Clicking opens a popup window
  /// playing the just-exported file.
  onPlay?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const inProgress = state.kind === "starting" || state.kind === "progress";
  // Modal during work: no dismiss/close affordance until complete/error (the
  // "preparing" wait has its own Cancel). This also blocks UI interaction.
  const dismissable = !inProgress && state.kind !== "preparing";

  let body: React.ReactNode;
  let percent = 0;
  switch (state.kind) {
    case "starting":
      body = <p className="export-progress-status">{t("export.starting")}</p>;
      break;
    case "preparing":
      body = (
        <p className="export-progress-status">
          {t("export.preparing", {
            labels: state.labels.join(", "),
            count: state.labels.length,
          })}
        </p>
      );
      break;
    case "progress": {
      percent = Math.round(state.progress.progress * 100);
      const phaseLabel =
        state.progress.phase === "transcode"
          ? t("export.phase_transcode")
          : t("export.phase_encode");
      // The transcode stage has no per-frame fps/speed (ffmpeg `-progress`
      // gives time only), so show just the stage + percent there.
      const detail =
        state.progress.phase === "transcode"
          ? `${percent}%`
          : t("export.progress_label", {
              percent,
              frame: state.progress.frame,
              fps: state.progress.fps.toFixed(1),
              speed: state.progress.speed.toFixed(2),
            });
      body = (
        <p className="export-progress-status">
          <strong>{phaseLabel}</strong>
          <span className="export-progress-detail">{detail}</span>
        </p>
      );
      break;
    }
    case "complete":
      percent = 100;
      body = (
        <p className="export-progress-status">
          {t("export.complete", { path: state.payload.outputPath })}
        </p>
      );
      break;
    case "error":
      body = (
        <p className="export-progress-status error">
          {t("export.failed", { detail: state.detail })}
        </p>
      );
      break;
  }

  return (
    <AppDialog
      title={t("export.title")}
      onClose={dismissable ? onClose : undefined}
      closeLabel={t("export.dismiss")}
      panelClassName="settings-panel export-progress-panel"
    >
        <div className="settings-body">
          <div className="settings-card">
            {body}
            <div
              className={`progress-track ${
                state.kind === "error" ? "is-error" : ""
              }`}
            >
              <div
                className="progress-fill"
                style={{ width: `${state.kind === "error" ? 100 : percent}%` }}
              />
            </div>
            {((state.kind === "preparing" && state.onCancel) || dismissable) && (
              <div className="export-actions">
                {state.kind === "preparing" && state.onCancel && (
                  <Button size="lg" onClick={state.onCancel}>
                    {t("export.preparing_cancel")}
                  </Button>
                )}
                {state.kind === "complete" && onPlay && (
                  <Button
                    size="lg"
                    onClick={() => onPlay(state.payload.outputPath)}
                    title={t("export.play_hint", {
                      defaultValue:
                        "Open the exported MP4 in a Render & Play popup.",
                    })}
                  >
                    {t("export.play", { defaultValue: "Play" })}
                  </Button>
                )}
                {dismissable && (
                  <Button variant="default" size="lg" onClick={onClose}>
                    {t("export.dismiss")}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
    </AppDialog>
  );
}
