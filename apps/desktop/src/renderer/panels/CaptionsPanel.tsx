// Captions panel — lists all caption-track cues, seek on click, inline text edit.
// Caption tracks are `TrackSummary` entries where `role === "caption"`. Each
// such track holds one `Text` layer per cue (built by `apply_subtitles` /
// transcribe / manual import). This panel flattens all caption tracks' Text
// layers sorted by start time and exposes them as an editable cue list.

import { useTranslation } from "react-i18next";
import { useProjectSummary } from "../state/projectStore";
import { transportSeek } from "../state/playbackStore";
import { updateLayerParams, type LayerSummary } from "../ipc";

export function CaptionsPanel({ onMutated }: { onMutated: () => Promise<void> }) {
  const { t } = useTranslation();
  const summary = useProjectSummary();

  // Flatten all caption-role tracks' Text layers in start-time order.
  const cues: LayerSummary[] = (summary?.tracks ?? [])
    .filter((tr) => tr.role === "caption")
    .flatMap((tr) => tr.layers)
    .filter((l) => l.params.kind === "Text")
    .sort((a, b) => a.t_start_us - b.t_start_us);

  const commitText = (layerId: string, content: string) =>
    updateLayerParams(layerId, { kind: "Text", content })
      .then(onMutated)
      .catch((e) => console.warn("update caption text failed:", e));

  return (
    <section className="captions-panel" aria-label={t("captions.title")}>
      <h3>{t("captions.title")}</h3>
      {cues.length === 0 ? (
        <p className="placeholder">{t("captions.empty")}</p>
      ) : (
        <ul className="captions-list">
          {cues.map((c) => (
            <li key={c.id} className="caption-row">
              <button
                type="button"
                className="caption-seek"
                onClick={() => transportSeek(c.t_start_us)}
                aria-label={`seek ${fmtTc(c.t_start_us)}`}
              >
                {fmtTc(c.t_start_us)}
              </button>
              <input
                className="app-input caption-text"
                defaultValue={c.params.kind === "Text" ? c.params.content : ""}
                onBlur={(e) => commitText(c.id, e.target.value)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/// Format microseconds as MM:SS for the cue timecode label.
function fmtTc(us: number): string {
  const s = Math.floor(us / 1_000_000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
