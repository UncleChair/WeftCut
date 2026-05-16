// Right panel — peek list (top) + unified inspector (bottom).
// `docs/ab-roll-redesign` R.6.
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

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { type GroupSummary, type LayerSummary, type TrackSummary } from "../ipc";
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
  /// R.7 inline-reveal hook. When provided, clicking a peek item
  /// dispatches the track id so the Timeline can temporarily inject
  /// that row into its rendered list. R.6 leaves this `undefined`.
  onRevealTrack?: (trackId: string, layerId: string) => void;
}

/// One row in the peek list. Carries enough state to render the row +
/// drive selection / reveal on click.
interface PeekItem {
  layer: LayerSummary;
  trackId: string;
  trackLabel: string;
  trackKind: string;
  /// Microseconds from playhead to the *layer's nearest edge* —
  /// negative when the layer ended in the past, positive when it
  /// starts in the future, zero when it spans the playhead.
  offsetUs: number;
  /// True when `playhead ∈ [t_start, t_end]` — gets the LIVE badge.
  spansPlayhead: boolean;
}

function buildPeekItems(
  tracks: TrackSummary[],
  currentTimeUs: number,
  deltaUs: number,
): PeekItem[] {
  const lo = currentTimeUs - deltaUs;
  const hi = currentTimeUs + deltaUs;
  const items: PeekItem[] = [];
  for (const t of tracks) {
    if (t.role !== null) continue;
    for (const layer of t.layers) {
      // Window intersection: layer.t_end > lo AND layer.t_start < hi.
      if (layer.t_end_us <= lo || layer.t_start_us >= hi) continue;
      const spans =
        layer.t_start_us <= currentTimeUs && layer.t_end_us >= currentTimeUs;
      const offset = spans
        ? 0
        : layer.t_start_us > currentTimeUs
          ? layer.t_start_us - currentTimeUs
          : layer.t_end_us - currentTimeUs;
      items.push({
        layer,
        trackId: t.id,
        trackLabel: t.label ?? t.kind,
        trackKind: t.kind,
        offsetUs: offset,
        spansPlayhead: spans,
      });
    }
  }
  // Order: spanning items first (LIVE bubble), then chronologically by
  // t_start. Equal t_start ties break by track label (stable enough).
  items.sort((a, b) => {
    if (a.spansPlayhead !== b.spansPlayhead) {
      return a.spansPlayhead ? -1 : 1;
    }
    if (a.layer.t_start_us !== b.layer.t_start_us) {
      return a.layer.t_start_us - b.layer.t_start_us;
    }
    return a.trackLabel.localeCompare(b.trackLabel);
  });
  return items;
}

export function RightPanel({
  tracks,
  groups: _groups,
  selectedLayerId,
  currentTimeUs,
  onSelect,
  onMutated,
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
              ±{(deltaWindowUs / 1_000_000).toFixed(0)}s
            </span>
          </header>
          <ul className="right-panel-peek-list">
            {peekItems.map((item) => (
              <PeekRow
                key={item.layer.id}
                item={item}
                isSelected={item.layer.id === selectedLayerId}
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
          selectedLayerId={selectedLayerId}
          onMutated={onMutated}
        />
      </section>
    </aside>
  );
}

function PeekRow({
  item,
  isSelected,
  onClick,
}: {
  item: PeekItem;
  isSelected: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const durationUs = item.layer.t_end_us - item.layer.t_start_us;
  const offsetLabel = item.spansPlayhead
    ? t("peek.live", { defaultValue: "LIVE" })
    : formatOffset(item.offsetUs, t);
  const durationLabel = `${(durationUs / 1_000_000).toFixed(2)}s`;
  const thumbMediaId =
    item.layer.params.kind === "VideoClip" ||
    item.layer.params.kind === "ImageOverlay"
      ? item.layer.params.media_id
      : null;
  return (
    <li>
      <button
        type="button"
        className={`peek-item kind-${item.trackKind.toLowerCase()} ${
          isSelected ? "is-selected" : ""
        } ${item.spansPlayhead ? "is-live" : ""}`}
        onClick={onClick}
        title={item.layer.label ?? item.trackLabel}
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
          <span className="peek-label">
            {item.layer.label ?? item.trackLabel}
          </span>
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
  t: (k: string, v: Record<string, unknown>) => string,
): string {
  const sec = offsetUs / 1_000_000;
  // 1-decimal precision is enough at ±10s scale. Sign prefix is
  // explicit so the reader can immediately tell past from future.
  const formatted = `${sec >= 0 ? "+" : "−"}${Math.abs(sec).toFixed(1)}s`;
  return t("peek.offset", {
    defaultValue: formatted,
    value: formatted,
  });
}

function iconForKind(kind: string): string {
  // Cheap text glyph fallback when no thumbnail/waveform is available.
  // Subtitle layers + audio layers tend not to have a thumbnail path.
  switch (kind.toLowerCase()) {
    case "video":
      return "▶";
    case "audio":
      return "♪";
    case "subtitle":
      return "T";
    default:
      return "•";
  }
}
