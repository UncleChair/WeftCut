// Captions panel — lists all caption-track cues, seek on click, inline text edit,
// and batch style controls (font size, color) for all cues in one undo entry.
// Caption tracks are `TrackSummary` entries where `role === "caption"`. Each
// such track holds one `Text` layer per cue (built by `apply_subtitles` /
// transcribe / manual import). This panel flattens all caption tracks' Text
// layers sorted by start time and exposes them as an editable cue list.

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useProjectSummary } from "../state/projectStore";
import { transportSeek } from "../state/playbackStore";
import { AppColorField } from "../components/AppColorField";
import { AppNumberField } from "../components/AppNumberField";
import {
  updateLayerParams,
  restyleCaptionTrack,
  trackStatic,
  type LayerSummary,
  type Rgba,
} from "../ipc";

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };

export interface CaptionPanelProps {
  onMutated: () => Promise<void>;
}

export function CaptionPanel({ onMutated }: CaptionPanelProps) {
  const { t } = useTranslation();
  const summary = useProjectSummary();

  const captionTracks = (summary?.tracks ?? []).filter((tr) => tr.role === "caption");

  // Flatten all caption-role tracks' Text layers in start-time order.
  const cues: LayerSummary[] = captionTracks
    .flatMap((tr) => tr.layers.filter((l) => l.params.kind === "Text"))
    .sort((a, b) => a.t_start_us - b.t_start_us);

  // Seed style controls from the first Text layer on the first caption track.
  const firstTextParams =
    captionTracks[0]?.layers.find((l) => l.params.kind === "Text")?.params;
  const seedSize =
    firstTextParams?.kind === "Text" ? firstTextParams.font_size_px : 54;
  const seedColor =
    firstTextParams?.kind === "Text"
      ? trackStatic(firstTextParams.color, WHITE)
      : WHITE;

  const [fontSize, setFontSize] = useState(seedSize);
  const [color, setColor] = useState(seedColor);
  // Debounce slot for caption color commits — the native color picker fires
  // onChange continuously; each IPC call creates a history entry, so we must
  // coalesce bursts into one commit per gesture.
  const colorDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resync style controls when the first caption track changes (e.g. after undo).
  useEffect(() => {
    setFontSize(seedSize);
    setColor(seedColor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captionTracks[0]?.id]);

  // Clear any pending debounced color commit on unmount so a late call can't
  // fire after the component is gone.
  useEffect(() => {
    return () => {
      if (colorDebounceRef.current) clearTimeout(colorDebounceRef.current);
    };
  }, []);

  const primaryTrackId = captionTracks[0]?.id;

  const commitText = (layerId: string, content: string) =>
    updateLayerParams(layerId, { kind: "Text", content })
      .then(onMutated)
      .catch((e) => console.warn("update caption text failed:", e));

  return (
    <section className="captions-panel" aria-label={t("captions.title")}>
      {cues.length === 0 ? (
        <p className="placeholder">{t("captions.empty")}</p>
      ) : (
        <>
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
                  aria-label={`${t("captions.title")} ${fmtTc(c.t_start_us)}`}
                  onBlur={(e) => commitText(c.id, e.target.value)}
                />
              </li>
            ))}
          </ul>
          {primaryTrackId != null && (
            <section className="captions-style-section" aria-label={t("captions.style_heading")}>
              <h4>{t("captions.style_heading")}</h4>
              <AppNumberField
                value={fontSize}
                step={1}
                min={6}
                max={400}
                ariaLabel={t("property_panel.font_size_px")}
                onValueChange={setFontSize}
                onCommit={(v) =>
                  restyleCaptionTrack(primaryTrackId, { font_size_px: v })
                    .then(onMutated)
                    .catch((e) => console.warn("restyle caption failed:", e))
                }
              />
              <AppColorField
                value={rgbaToHex(color)}
                ariaLabel={t("property_panel.color")}
                onValueChange={(hex) => {
                  const next = hexToRgba(hex, color);
                  setColor(next);
                  if (colorDebounceRef.current) clearTimeout(colorDebounceRef.current);
                  colorDebounceRef.current = setTimeout(() => {
                    restyleCaptionTrack(primaryTrackId, { color: next })
                      .then(onMutated)
                      .catch((e) => console.warn("restyle caption color failed:", e));
                  }, 250);
                }}
              />
            </section>
          )}
        </>
      )}
    </section>
  );
}

// Temporary source-compatible name while the fixed RightPanel is retired.
export { CaptionPanel as CaptionsPanel };

/// Format microseconds as MM:SS for the cue timecode label.
function fmtTc(us: number): string {
  const s = Math.floor(us / 1_000_000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function rgbaToHex(c: Rgba): string {
  return `#${[c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgba(hex: string, fallback: Rgba): Rgba {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || !m[1]) return fallback;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff, a: fallback.a };
}
