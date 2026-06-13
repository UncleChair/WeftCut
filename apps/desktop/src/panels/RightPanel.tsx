// Right panel — peek list (top) + unified inspector (bottom).
// `docs/data-model.md` R.6.
//
// Layout (AB mode):
//   ┌─────────────────────────┐
//   │ Peek list               │  layers on hidden tracks within
//   │  (±Δ around playhead)   │  [playhead − Δ, playhead + Δ]
//   ├─────────────────────────┤
//   │ Inspector               │  PropertyPanel for selectedLayerId
//   │  (PropertyPanel)        │  — single inspector across the app
//   └─────────────────────────┘
//
// Layout (Show All mode):  peek section is hidden; only the inspector
// renders.
//
// Empty-state (Q14 lock): when no hidden-track layers fall in the
// window, the peek section collapses and the inspector grows to fill.
//
// Selection: clicking a peek item calls `onSelect(layerId)` AND, if
// `onRevealTrack` is provided (R.7), requests that the timeline
// temporarily reveal the clicked layer's track. R.6 ships without the
// reveal callback; R.7 wires it.

import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CircleIcon, FilmIcon, MusicIcon, TypeIcon } from "lucide-react";

import { formatTimecode } from "../frames";
import { type GroupSummary, type LayerSummary, type TrackSummary } from "../ipc";
import { buildPeekItems, type PeekItem } from "./peek";
import { PropertyPanel } from "../properties/PropertyPanel";
import { useDeltaWindowUs, useDisplayMode } from "../settings/appSettingsStore";
import { MediaThumbnail } from "./MediaThumbnail";

export interface RightPanelProps {
  tracks: TrackSummary[];
  groups: GroupSummary[];
  selectedLayerId: string | null;
  currentTimeUs: number;
  onSelect: (id: string | null) => void;
  onMutated: () => Promise<void>;
  fpsNum: number;
  fpsDen: number;
  /// R.7 inline-reveal hook. When provided, clicking a peek item
  /// dispatches the track id so the Timeline can temporarily inject
  /// that row into its rendered list. R.6 leaves this `undefined`.
  onRevealTrack?: (trackId: string, layerId: string) => void;
}

export function RightPanel({
  tracks,
  groups,
  selectedLayerId,
  currentTimeUs,
  onSelect,
  onMutated,
  fpsNum,
  fpsDen,
  onRevealTrack,
}: RightPanelProps) {
  const { t } = useTranslation();
  const displayMode = useDisplayMode();
  const deltaWindowUs = useDeltaWindowUs();

  const peekItems = useMemo(() => {
    if (displayMode !== "AbRoll") return [];
    return buildPeekItems(tracks, currentTimeUs, deltaWindowUs);
  }, [tracks, currentTimeUs, deltaWindowUs, displayMode]);

  const showPeek = displayMode === "AbRoll" && peekItems.length > 0;

  return (
    <aside className="right-panel">
      {showPeek && (
        <section
          className="right-panel-peek"
          aria-label={t("peek.section_label", {
            defaultValue: "Hidden-track layers near playhead",
          })}
        >
          <header className="right-panel-peek-header">
            <span>
              {t("peek.heading", {
                defaultValue: "Near playhead ({{count}})",
                count: peekItems.length,
              })}
            </span>
            <span className="right-panel-peek-window">
              ±{formatTimecode(deltaWindowUs, fpsNum, fpsDen)}
            </span>
          </header>
          <ul className="right-panel-peek-list">
            {peekItems.map((item) => (
              <PeekRow
                key={item.layer.id}
                item={item}
                isSelected={item.layer.id === selectedLayerId}
                fpsNum={fpsNum}
                fpsDen={fpsDen}
                onClick={() => {
                  onSelect(item.layer.id);
                  if (onRevealTrack) {
                    onRevealTrack(item.trackId, item.layer.id);
                  }
                }}
              />
            ))}
          </ul>
        </section>
      )}
      <section className="right-panel-inspector">
        <PropertyPanel
          tracks={tracks}
          groups={groups}
          selectedLayerId={selectedLayerId}
          onMutated={onMutated}
          fpsNum={fpsNum}
          fpsDen={fpsDen}
        />
      </section>
    </aside>
  );
}

function PeekRow({
  item,
  isSelected,
  fpsNum,
  fpsDen,
  onClick,
}: {
  item: PeekItem;
  isSelected: boolean;
  fpsNum: number;
  fpsDen: number;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const durationUs = item.layer.t_end_us - item.layer.t_start_us;
  const offsetLabel = item.spansPlayhead
    ? t("peek.live", { defaultValue: "LIVE" })
    : formatOffset(item.offsetUs, fpsNum, fpsDen, t);
  const durationLabel = formatTimecode(durationUs, fpsNum, fpsDen);
  const thumbMediaId =
    item.layer.params.kind === "VideoClip" ||
    item.layer.params.kind === "ImageOverlay"
      ? item.layer.params.media_id
      : null;
  // Prefer the media filename for media-backed layers so the user
  // can identify clips at a glance; fall back to a user-set layer
  // label or the track label.
  const mediaLabel = mediaLabelFor(item.layer);
  const primaryLabel = item.layer.label ?? mediaLabel ?? item.trackLabel;
  return (
    <li>
      <button
        type="button"
        className={`peek-item kind-${item.trackKind.toLowerCase()} ${
          isSelected ? "is-selected" : ""
        } ${item.spansPlayhead ? "is-live" : ""}`}
        onClick={onClick}
        title={primaryLabel}
      >
        <span className="peek-thumb">
          {thumbMediaId ? (
            <MediaThumbnail mediaId={thumbMediaId} mediaKind={item.trackKind} />
          ) : (
            <span className="peek-thumb-fallback" aria-hidden="true">
              {iconForKind(item.trackKind)}
            </span>
          )}
        </span>
        <span className="peek-meta">
          <span className="peek-label">{primaryLabel}</span>
          <span className="peek-sublabel">{item.trackLabel}</span>
        </span>
        <span className="peek-times">
          <span
            className={`peek-offset ${item.spansPlayhead ? "is-live" : ""}`}
          >
            {offsetLabel}
          </span>
          <span className="peek-duration">{durationLabel}</span>
        </span>
      </button>
    </li>
  );
}

function formatOffset(
  offsetUs: number,
  fpsNum: number,
  fpsDen: number,
  t: (k: string, v: Record<string, unknown>) => string,
): string {
  const tc = formatTimecode(Math.abs(offsetUs), fpsNum, fpsDen);
  const formatted = `${offsetUs >= 0 ? "+" : "−"}${tc}`;
  return t("peek.offset", {
    defaultValue: formatted,
    value: formatted,
  });
}

/// Media-backed layer params carry `media_label` (the filename / pool
/// label). Surface it for clip identification; non-media layers
/// (Text, Color, Subtitles, Motif) have no associated media.
function mediaLabelFor(layer: LayerSummary): string | null {
  switch (layer.params.kind) {
    case "VideoClip":
    case "ImageOverlay":
    case "Audio":
      return layer.params.media_label;
    default:
      return null;
  }
}

function iconForKind(kind: string): ReactNode {
  // Cheap icon fallback when no thumbnail/waveform is available.
  // Subtitle layers + audio layers tend not to have a thumbnail path.
  switch (kind.toLowerCase()) {
    case "video":
      return <FilmIcon size={14} />;
    case "audio":
      return <MusicIcon size={14} />;
    case "subtitle":
      return <TypeIcon size={14} />;
    default:
      return <CircleIcon size={10} />;
  }
}
