import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from "lucide-react";

import { type ProjectSummary } from "../ipc";
import { formatTimecode } from "../frames";
import {
  playheadTimeUs,
  setPlayheadTimeUs,
} from "../state/playheadStore";
import { AppTimecodeField } from "../components/AppTimecodeField";
import {
  PreviewSurface,
  type PreviewSurfaceHandle,
} from "../preview/PreviewSurface";
import { PlayheadTimecode } from "../preview/PlayheadTimecode";

interface PreviewSectionProps {
  previewRef: React.RefObject<PreviewSurfaceHandle | null>;
  summary: ProjectSummary | null;
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  onSeek: (tUs: number) => void;          // App's seekTo
  onTogglePlay: () => void;
  previewDecodableOf: (id: string) => boolean;
}

/// The preview quadrant: `PreviewSurface` plus the transport strip
/// (editable timecode, skip/play buttons, canvas + duration meta).
/// Owns the timecode-edit state — purely local to this transport UI.
/// `paused` stays App state (AgentMode also writes it) and arrives as
/// a prop with `onPausedChange` forwarded back up.
export function PreviewSection({
  previewRef,
  summary,
  paused,
  onPausedChange,
  onSeek,
  onTogglePlay,
  previewDecodableOf,
}: PreviewSectionProps) {
  const { t } = useTranslation();
  // Timecode-edit state doubles as the field's seed value: capturing the
  // playhead at the moment editing opens (instead of live-updating the field
  // from a React-subscribed time) keeps the edit box stable during playback.
  const [tcEditUs, setTcEditUs] = useState<number | null>(null);

  const fpsLabel =
    summary &&
    (summary.composition.fps_den === 1
      ? t("project.fps_simple", { fps: summary.composition.fps_num })
      : t("project.fps_rational", {
          fps: (
            summary.composition.fps_num / summary.composition.fps_den
          ).toFixed(2),
        }));

  return (
    <section className="preview">
      <div id="video-surface" className="video-surface">
        <PreviewSurface
          ref={previewRef}
          hasContent={(summary?.layer_count ?? 0) > 0}
          onTimeUpdate={setPlayheadTimeUs}
          onPausedChange={onPausedChange}
          previewDecodableOf={previewDecodableOf}
        />
      </div>
      <div className="preview-transport" role="toolbar" aria-label="Preview transport">
        {tcEditUs !== null ? (
          <AppTimecodeField
            className="preview-timecode"
            valueUs={tcEditUs}
            fpsNum={summary?.composition.fps_num ?? 30}
            fpsDen={summary?.composition.fps_den ?? 1}
            autoFocus
            ariaLabel={t("transport.timecode_label")}
            onCommit={(us) => {
              setTcEditUs(null);
              void onSeek(us);
            }}
            onCancel={() => setTcEditUs(null)}
          />
        ) : (
          <PlayheadTimecode
            fpsNum={summary?.composition.fps_num ?? 30}
            fpsDen={summary?.composition.fps_den ?? 1}
            editHint={t("transport.timecode_edit_hint")}
            onActivate={() => setTcEditUs(playheadTimeUs())}
          />
        )}
        <div className="transport-buttons">
          <button
            type="button"
            onClick={() => onSeek(0)}
            title={t("transport.to_start_hint")}
            aria-label={t("transport.to_start_hint")}
          >
            <SkipBackIcon size={16} aria-hidden />
          </button>
          <button
            type="button"
            onClick={onTogglePlay}
            title={t("transport.play_pause_hint")}
            aria-label={t("transport.play_pause_hint")}
            disabled={(summary?.layer_count ?? 0) === 0}
          >
            {paused ? (
              <PlayIcon size={16} aria-hidden />
            ) : (
              <PauseIcon size={16} aria-hidden />
            )}
          </button>
          <button
            type="button"
            onClick={() => onSeek(summary?.duration_us ?? 0)}
            title={t("transport.to_end_hint")}
            aria-label={t("transport.to_end_hint")}
            disabled={!summary || summary.duration_us === 0}
          >
            <SkipForwardIcon size={16} aria-hidden />
          </button>
        </div>
        <span className="preview-meta" aria-hidden="true">
          {summary && (
            <>
              {t("project.canvas", {
                width: summary.composition.width,
                height: summary.composition.height,
                fps: fpsLabel,
              })}
              {" · "}
              {t("project.duration", {
                value: formatTimecode(summary.duration_us, summary.composition.fps_num, summary.composition.fps_den),
              })}
            </>
          )}
        </span>
      </div>
    </section>
  );
}
