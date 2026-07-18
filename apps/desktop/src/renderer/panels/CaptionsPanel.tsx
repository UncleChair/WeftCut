// Captions panel — the Project-wide caption corpus surface. It flattens the
// cues of EVERY caption-role Track (`role === "caption"`) in start-time order,
// including overlapping lanes, and exposes them as one editable cue list.
// Activating a cue selects its Text Layer, seeks the playhead to its start, and
// reveals it in Timeline (composed by the host via `onActivateCue`). Inline text
// editing still updates a single ordinary Text Layer. The style controls restyle
// the WHOLE corpus — every caption-role Track — in one atomic undo entry.
// Each caption cue is a first-class Text Layer built by `apply_subtitles` /
// transcribe / subtitle import.

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useProjectSummary } from "../state/projectStore";
import { transportSeek } from "../state/playbackStore";
import { AppColorField } from "../components/AppColorField";
import { AppNumberField } from "../components/AppNumberField";
import {
  updateLayerParams,
  restyleCaptions,
  trackStatic,
  type LayerSummary,
  type Rgba,
} from "../ipc";

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };

/// One flattened caption cue plus the caption-role Track that owns it. The
/// track id is what `onActivateCue` reveals in Timeline.
interface CaptionCue {
  layer: LayerSummary;
  trackId: string;
}

export interface CaptionPanelProps {
  onMutated: () => Promise<void>;
  /// The primary selected Layer — highlights the matching cue row.
  selectedLayerId?: string | null;
  /// Activate a cue: select its Text Layer, seek to its start, and reveal it in
  /// Timeline. When omitted (the retiring RightPanel), the cue timecode falls
  /// back to a bare transport seek.
  onActivateCue?: ((layerId: string, trackId: string, startUs: number) => void) | undefined;
}

export function CaptionPanel({ onMutated, selectedLayerId, onActivateCue }: CaptionPanelProps) {
  const { t } = useTranslation();
  const summary = useProjectSummary();

  const captionTracks = (summary?.tracks ?? []).filter((tr) => tr.role === "caption");

  // Flatten every caption-role track's Text layers in start-time order,
  // carrying the owning track id so activation can reveal the right lane.
  const cues: CaptionCue[] = captionTracks
    .flatMap((tr) => tr.layers.filter((l) => l.params.kind === "Text").map((layer) => ({ layer, trackId: tr.id })))
    .sort((a, b) => a.layer.t_start_us - b.layer.t_start_us);

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

  const commitText = (layerId: string, content: string) =>
    updateLayerParams(layerId, { kind: "Text", content })
      .then(onMutated)
      .catch((e) => console.warn("update caption text failed:", e));

  const activateCue = ({ layer, trackId }: CaptionCue) => {
    if (onActivateCue) onActivateCue(layer.id, trackId, layer.t_start_us);
    else transportSeek(layer.t_start_us);
  };

  return (
    <section className="captions-panel" aria-label={t("captions.title")}>
      {cues.length === 0 ? (
        <p className="placeholder">{t("captions.empty")}</p>
      ) : (
        <>
          <ul className="captions-list">
            {cues.map((cue) => {
              const { layer } = cue;
              return (
                <li
                  key={layer.id}
                  className={`caption-row ${layer.id === selectedLayerId ? "is-selected" : ""}`}
                >
                  <button
                    type="button"
                    className="caption-seek"
                    onClick={() => activateCue(cue)}
                    aria-label={`seek ${fmtTc(layer.t_start_us)}`}
                  >
                    {fmtTc(layer.t_start_us)}
                  </button>
                  <input
                    className="app-input caption-text"
                    defaultValue={layer.params.kind === "Text" ? layer.params.content : ""}
                    aria-label={`${t("captions.title")} ${fmtTc(layer.t_start_us)}`}
                    onBlur={(e) => commitText(layer.id, e.target.value)}
                  />
                </li>
              );
            })}
          </ul>
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
                restyleCaptions({ font_size_px: v })
                  .then(onMutated)
                  .catch((e) => console.warn("restyle captions failed:", e))
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
                  restyleCaptions({ color: next })
                    .then(onMutated)
                    .catch((e) => console.warn("restyle captions color failed:", e));
                }, 250);
              }}
            />
          </section>
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
