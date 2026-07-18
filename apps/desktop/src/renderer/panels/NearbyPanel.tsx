// A/B-roll context panel. This module owns the full "near playhead" feature:
// mode gating, window calculation, filtering, grouping, row presentation, and
// the two navigation gestures. A plain pick selects + reveals the layer WITHOUT
// moving the playhead (the near-playhead observation window stays put); an
// explicit Go To seeks + scrolls. Double-click renames via the recorded Layer
// label command. Outside A/B Roll (or with an empty window) the panel explains
// itself rather than leaving an unexplained blank area.

import { useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CrosshairIcon, FilmIcon, MusicIcon, TypeIcon } from "lucide-react";

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
  visible?: boolean;
  /// Plain pick: select + reveal the Track WITHOUT seeking, so the
  /// near-playhead observation window is not disturbed.
  onPick: (layerId: string, trackId: string) => void;
  /// Explicit Go To: seek to the Layer's start and scroll it into view. When
  /// omitted, the panel hides that optional action.
  onGoTo?: ((layerId: string, trackId: string, startUs: number) => void) | undefined;
  /// Commit a lightweight inline rename through the recorded Layer label
  /// command. The host wires this to `updateLayer` + summary refresh.
  onRename?: ((layerId: string, nextLabel: string) => void) | undefined;
}

export function NearbyPanel({
  tracks,
  selectedLayerId,
  fpsNum,
  fpsDen,
  visible = true,
  onPick,
  onGoTo,
  onRename,
}: NearbyPanelProps) {
  const { t } = useTranslation();
  const displayMode = useDisplayMode();
  const deltaWindowUs = useDeltaWindowUs();
  const currentTimeUs = usePlayheadTimeUsThrottled(100, visible);
  const [filter, setFilter] = useState<"all" | PeekCategory>("all");

  const items = useMemo(() => {
    if (displayMode !== "AbRoll") return [];
    return buildPeekItems(tracks, currentTimeUs, deltaWindowUs);
  }, [tracks, currentTimeUs, deltaWindowUs, displayMode]);

  const sections = useMemo(() => groupPeekItems(items, filter), [items, filter]);

  // Never an unexplained blank Panel: Show All mode has no hidden tracks to
  // surface, and an empty ±Δ window means nothing intersects right now — both
  // states say so explicitly instead of collapsing to nothing.
  if (displayMode !== "AbRoll") {
    return (
      <Explainer
        title={t("peek.show_all_title")}
        message={t("peek.show_all_msg")}
      />
    );
  }
  if (items.length === 0) {
    return (
      <Explainer
        title={t("peek.empty_title")}
        message={t("peek.empty_msg", {
          window: formatTimecode(deltaWindowUs, fpsNum, fpsDen),
        })}
      />
    );
  }

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
                    onReveal={() => onPick(item.layer.id, item.trackId)}
                    onGoTo={
                      onGoTo
                        ? () =>
                            onGoTo(
                              item.layer.id,
                              item.trackId,
                              item.layer.t_start_us,
                            )
                        : undefined
                    }
                    onRename={
                      onRename
                        ? (next) => onRename(item.layer.id, next)
                        : undefined
                    }
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

/// Self-explaining empty state — keeps the Nearby dock Panel from ever
/// rendering as an unexplained blank area.
function Explainer({ title, message }: { title: string; message: string }) {
  const { t } = useTranslation();
  return (
    <section
      className="right-panel-peek right-panel-peek--empty"
      aria-label={t("peek.section_label")}
    >
      <header className="right-panel-peek-header">
        <span>{title}</span>
      </header>
      <p className="peek-empty">{message}</p>
    </section>
  );
}

function PeekRow({
  item,
  isSelected,
  fpsNum,
  fpsDen,
  onReveal,
  onGoTo,
  onRename,
}: {
  item: PeekItem;
  isSelected: boolean;
  fpsNum: number;
  fpsDen: number;
  onReveal: () => void;
  onGoTo?: (() => void) | undefined;
  onRename?: ((nextLabel: string) => void) | undefined;
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

  // Inline rename. Enter commits, Escape cancels, click-away commits — all
  // funnelled through `commit`/`cancel`, which a single latch (`settled`)
  // guards so a key-driven finish can't also fire the follow-up blur.
  const currentLabel = item.layer.label ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const settled = useRef(false);

  const startEdit = () => {
    if (!onRename) return;
    settled.current = false;
    setDraft(currentLabel);
    setEditing(true);
  };
  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    const next = draft.trim();
    // Empty reverts (the label command can't clear to null); an unchanged
    // value records no undo entry.
    if (next === "" || next === currentLabel) return;
    onRename?.(next);
  };
  const cancel = () => {
    settled.current = true;
    setEditing(false);
  };

  if (editing) {
    return (
      <li>
        <input
          className="peek-rename-input"
          aria-label={t("peek.rename_label", { label: primaryLabel })}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          onBlur={commit}
        />
      </li>
    );
  }

  return (
    <li>
      <div className="peek-item-row">
        <button
          type="button"
          className={`peek-item kind-${item.trackKind.toLowerCase()} ${
            isSelected ? "is-selected" : ""
          } ${item.spansPlayhead ? "is-live" : ""}`}
          onClick={onReveal}
          onDoubleClick={onRename ? startEdit : undefined}
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
        {onGoTo && (
          <button
            type="button"
            className="peek-goto"
            onClick={onGoTo}
            title={t("peek.goto", { label: primaryLabel })}
            aria-label={t("peek.goto", { label: primaryLabel })}
          >
            <CrosshairIcon size={14} />
          </button>
        )}
      </div>
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
