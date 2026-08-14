// A/B-roll context panel. Owns mode gating, row presentation, and the two
// navigation gestures (pick vs Go To — see the props below); double-click
// renames via the recorded Layer label command. Windowing, filtering and the
// At-playhead / Nearby split live in `peek.ts` (ADR 0044). Outside A/B Roll
// (or with an empty window) the panel renders an explainer instead of rows.

import { useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CrosshairIcon, FilmIcon, MusicIcon, TypeIcon } from "lucide-react";

import { formatTimecode } from "../frames";
import { type TrackSummary } from "../ipc";
import { layerDisplayName } from "../lib/layerName";
import { useDeltaWindowUs, useDisplayMode } from "../settings/appSettingsStore";
import { usePlayheadTimeUsThrottled } from "../state/playheadStore";
import { MediaThumbnail } from "./MediaThumbnail";
import {
  buildPeekItems,
  peekCategory,
  PEEK_CATEGORY_ORDER,
  splitPeekSections,
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
    return buildPeekItems(tracks, currentTimeUs, deltaWindowUs, t);
  }, [tracks, currentTimeUs, deltaWindowUs, displayMode, t]);

  const { atPlayhead, nearby } = useMemo(
    () => splitPeekSections(items, filter),
    [items, filter],
  );

  // Rows render identically in both sections — a row's information set
  // (thumbnail / icon, name, track name, offset / LIVE badge, duration) does
  // not depend on which side of the playhead boundary it landed on.
  const renderRow = (item: PeekItem) => (
    <PeekRow
      key={item.layer.id}
      item={item}
      isSelected={item.layer.id === selectedLayerId}
      fpsNum={fpsNum}
      fpsDen={fpsDen}
      onReveal={() => onPick(item.layer.id, item.trackId)}
      onGoTo={
        onGoTo
          ? () => onGoTo(item.layer.id, item.trackId, item.layer.t_start_us)
          : undefined
      }
      onRename={onRename ? (next) => onRename(item.layer.id, next) : undefined}
    />
  );

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
        {atPlayhead.length === 0 && nearby.length === 0 ? (
          <p className="peek-filter-empty">{t("peek.filter_empty")}</p>
        ) : (
          <>
            {/* The stack being composited right now, top-of-stack first.
                Always present: an empty stack is a fact worth stating, not
                a section to hide. */}
            <section
              className="peek-section"
              aria-label={t("peek.section_at_playhead")}
            >
              <div className="peek-section-header">
                {t("peek.section_at_playhead")}
              </div>
              {atPlayhead.length === 0 ? (
                <p className="peek-stack-empty">{t("peek.at_playhead_empty")}</p>
              ) : (
                <ul className="right-panel-peek-list">
                  {atPlayhead.map(renderRow)}
                </ul>
              )}
            </section>
            {nearby.length > 0 && (
              <section
                className="peek-section"
                aria-label={t("peek.section_nearby")}
              >
                <div className="peek-section-header">
                  {t("peek.section_nearby")}
                </div>
                <ul className="right-panel-peek-list">{nearby.map(renderRow)}</ul>
              </section>
            )}
          </>
        )}
      </div>
    </section>
  );
}

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
  // Shared with the timeline block and the inspector — the row must call a Layer
  // what its clip is called.
  const primaryLabel = layerDisplayName(item.layer, t);

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
