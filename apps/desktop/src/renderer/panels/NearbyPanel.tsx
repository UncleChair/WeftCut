// A/B-roll context panel. This module owns the full "near playhead" feature:
// mode gating, window calculation, filtering, grouping, and row presentation.
// Its caller only handles the semantic result of a pick (layer + track).

import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FilmIcon, MusicIcon, TypeIcon } from "lucide-react";

import { formatTimecode } from "../frames";
import { type LayerSummary, type TrackSummary } from "../ipc";
import { useDeltaWindowUs, useDisplayMode } from "../settings/appSettingsStore";
import { usePlayheadTimeUsThrottled } from "../state/playheadStore";
import { MediaThumbnail } from "./MediaThumbnail";
import {
  buildPeekItems,
  groupPeekItems,
  peekCategory,
  PEEK_CATEGORY_ORDER,
  type PeekCategory,
  type PeekItem,
} from "./peek";

const PEEK_FILTERS: ("all" | PeekCategory)[] = ["all", ...PEEK_CATEGORY_ORDER];

export interface NearbyPanelProps {
  tracks: TrackSummary[];
  selectedLayerId: string | null;
  fpsNum: number;
  fpsDen: number;
  onPick: (layerId: string, trackId: string) => void;
}

export function NearbyPanel({
  tracks,
  selectedLayerId,
  fpsNum,
  fpsDen,
  onPick,
}: NearbyPanelProps) {
  const { t } = useTranslation();
  const displayMode = useDisplayMode();
  const deltaWindowUs = useDeltaWindowUs();
  const currentTimeUs = usePlayheadTimeUsThrottled();
  const [filter, setFilter] = useState<"all" | PeekCategory>("all");

  const items = useMemo(() => {
    if (displayMode !== "AbRoll") return [];
    return buildPeekItems(tracks, currentTimeUs, deltaWindowUs);
  }, [tracks, currentTimeUs, deltaWindowUs, displayMode]);

  const sections = useMemo(() => groupPeekItems(items, filter), [items, filter]);

  // The module is contextual, not a permanent empty destination: outside
  // A/B Roll or with an empty ±Δ window it contributes no layout at all.
  if (displayMode !== "AbRoll" || items.length === 0) return null;

  return (
    <section className="right-panel-peek" aria-label={t("peek.section_label")}>
      <header className="right-panel-peek-header">
        <span>{t("peek.heading", { count: items.length })}</span>
        <span className="right-panel-peek-window">
          ±{formatTimecode(deltaWindowUs, fpsNum, fpsDen)}
        </span>
      </header>
      <div
        className="peek-filter"
        role="group"
        aria-label={t("peek.filter_label")}
      >
        {PEEK_FILTERS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className={`peek-filter-chip ${filter === candidate ? "is-active" : ""}`}
            aria-pressed={filter === candidate}
            onClick={() => setFilter(candidate)}
          >
            {candidate === "all"
              ? t("peek.filter_all")
              : t(`peek.cat_${candidate}`, { defaultValue: candidate })}
          </button>
        ))}
      </div>
      <div className="right-panel-peek-results">
        {sections.length === 0 ? (
          <p className="peek-filter-empty">{t("peek.filter_empty")}</p>
        ) : (
          sections.map((section) => (
            <div key={section.category}>
              <div className="peek-section-header">
                {t(`peek.cat_${section.category}`, {
                  defaultValue: section.category,
                })}
              </div>
              <ul className="right-panel-peek-list">
                {section.items.map((item) => (
                  <PeekRow
                    key={item.layer.id}
                    item={item}
                    isSelected={item.layer.id === selectedLayerId}
                    fpsNum={fpsNum}
                    fpsDen={fpsDen}
                    onClick={() => onPick(item.layer.id, item.trackId)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </section>
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
    ? t("peek.live")
    : formatOffset(item.offsetUs, fpsNum, fpsDen, t);
  const durationLabel = formatTimecode(durationUs, fpsNum, fpsDen);
  const thumbMediaId =
    item.layer.params.kind === "VideoClip" ||
    item.layer.params.kind === "ImageOverlay"
      ? item.layer.params.media_id
      : null;
  const primaryLabel =
    item.layer.label ?? mediaLabelFor(item.layer) ?? item.trackLabel;

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
              {iconForCategory(peekCategory(item.layer.params.kind))}
            </span>
          )}
        </span>
        <span className="peek-meta">
          <span className="peek-label">{primaryLabel}</span>
          <span className="peek-sublabel">{item.trackLabel}</span>
        </span>
        <span className="peek-times">
          <span className={`peek-offset ${item.spansPlayhead ? "is-live" : ""}`}>
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
  t: (key: string, values: Record<string, unknown>) => string,
): string {
  const timecode = formatTimecode(Math.abs(offsetUs), fpsNum, fpsDen);
  const value = `${offsetUs >= 0 ? "+" : "−"}${timecode}`;
  return t("peek.offset", { defaultValue: value, value });
}

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

function iconForCategory(category: PeekCategory): ReactNode {
  switch (category) {
    case "video":
      return <FilmIcon size={14} />;
    case "audio":
      return <MusicIcon size={14} />;
    case "text":
      return <TypeIcon size={14} />;
  }
}
