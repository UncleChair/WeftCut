// A/B-roll context panel. Owns mode gating, row presentation, the two
// navigation gestures (pick vs Go To — see the props below), and the
// At-playhead restack drag (grip per visual stack row); double-click renames
// via the recorded Layer label command. Windowing, filtering, the
// At-playhead / Nearby split and the drop's gap→anchor mapping live in
// `peek.ts` (ADR 0044). Outside A/B Roll (or with an empty window) the panel
// renders an explainer instead of rows.

import {
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  CrosshairIcon,
  FilmIcon,
  GripVerticalIcon,
  MusicIcon,
  TypeIcon,
} from "lucide-react";

import { formatTimecode } from "../frames";
import { usePointerReorder } from "../hooks/usePointerReorder";
import { type TrackSummary } from "../ipc";
import { layerDisplayName } from "../lib/layerName";
import { useDeltaWindowUs, useDisplayMode } from "../settings/appSettingsStore";
import { usePlayheadTimeUsThrottled } from "../state/playheadStore";
import { MediaThumbnail } from "./MediaThumbnail";
import {
  buildPeekItems,
  peekCategory,
  PEEK_CATEGORY_ORDER,
  restackTargetForGap,
  splitPeekSections,
  type PeekCategory,
  type PeekItem,
  type PeekSections,
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
  /// Restack `layerId` directly above/below `anchorLayerId` in the z-stack —
  /// ONE anchored op per completed drag (ADR 0044). The host wires this to
  /// the `restack_layer` command + summary refresh. When omitted, the
  /// At-playhead rows render without grips.
  onRestack?:
    | ((
        layerId: string,
        anchorLayerId: string,
        position: "above" | "below",
      ) => void)
    | undefined;
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
  onRestack,
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

  const live = useMemo(
    () => splitPeekSections(items, filter),
    [items, filter],
  );

  // ── At-playhead restack gesture (ADR 0044 decision 6) ──────────────────
  // The effect chain's pointer-reorder skeleton, inherited: drag state, gap
  // hit-testing by row midlines, edge auto-scroll and the Escape /
  // pointercancel disarm all live in the hook. Pure pointer events — never
  // HTML5 drag-and-drop — so a row drag can never become a Dockview panel
  // drag. Zero commands mid-gesture; exactly one restack at a non-noop drop.
  //
  // The row snapshot freezes for the duration of a gesture: the playhead
  // ticks on a throttle and must never reshuffle rows under the pointer.
  // Both are written at grip pointerdown and only read while the hook
  // reports an active drag; they go stale (not cleared) after the gesture
  // and the next pointerdown overwrites them.
  const [frozen, setFrozen] = useState<PeekSections | null>(null);
  const gestureRowsRef = useRef<PeekItem[]>([]);

  const reorder = usePointerReorder({
    // Read per render. A pointerdown can only start on the displayed rows,
    // which are the live ones whenever no gesture is armed.
    rowIds: visualStackOf(live).map((row) => row.layer.id),
    onDrop: ({ fromIndex, gap }) => {
      // Resolve against the pointerdown snapshot — the same rows the user
      // grabbed and has been looking at all gesture long.
      const rows = gestureRowsRef.current;
      const target = restackTargetForGap(rows, fromIndex, gap);
      const mover = rows[fromIndex];
      if (!target || !mover) return;
      onRestack?.(mover.layer.id, target.anchorId, target.position);
    },
  });

  const sections = reorder.drag && frozen ? frozen : live;
  const { atPlayhead, nearby } = sections;
  const visualRows = visualStackOf(sections);

  const startRestackDrag = (index: number, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    gestureRowsRef.current = visualRows;
    setFrozen(sections);
    reorder.startDrag(index, e);
  };

  // Rows render identically in both sections — a row's information set
  // (thumbnail / icon, name, track name, offset / LIVE badge, duration) does
  // not depend on which side of the playhead boundary it landed on. An
  // At-playhead index adds the reorder chrome (grip, rect registration,
  // drag / insertion-indicator classes) to the section's visual prefix; the
  // audio tail and the Nearby section stay grip-less.
  const renderRow = (item: PeekItem, stackIndex?: number) => {
    const draggable =
      stackIndex !== undefined && stackIndex < visualRows.length;
    const rowClassName = draggable
      ? [
          reorder.drag?.id === item.layer.id ? "peek-row--dragging" : "",
          reorder.indicatorGap === stackIndex ? "peek-row--drop-before" : "",
          reorder.indicatorGap === visualRows.length &&
          stackIndex === visualRows.length - 1
            ? "peek-row--drop-after"
            : "",
        ]
          .filter(Boolean)
          .join(" ")
      : "";
    return (
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
        onRename={
          onRename ? (next) => onRename(item.layer.id, next) : undefined
        }
        rowClassName={rowClassName === "" ? undefined : rowClassName}
        rowRef={
          draggable ? (el) => reorder.setRowEl(stackIndex, el) : undefined
        }
        onGripPointerDown={
          draggable && onRestack
            ? (e) => startRestackDrag(stackIndex, e)
            : undefined
        }
      />
    );
  };

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
                a section to hide. The container ref anchors the reorder
                gesture's edge auto-scroll. */}
            <section
              ref={reorder.containerRef}
              className={
                reorder.drag
                  ? "peek-section peek-stack--reordering"
                  : "peek-section"
              }
              aria-label={t("peek.section_at_playhead")}
            >
              <div className="peek-section-header">
                {t("peek.section_at_playhead")}
              </div>
              {atPlayhead.length === 0 ? (
                <p className="peek-stack-empty">{t("peek.at_playhead_empty")}</p>
              ) : (
                <ul className="right-panel-peek-list">
                  {atPlayhead.map((item, i) => renderRow(item, i))}
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
                <ul className="right-panel-peek-list">
                  {nearby.map((item) => renderRow(item))}
                </ul>
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

/// The draggable prefix of the At-playhead section: splitPeekSections puts
/// the z-ordered visual rows first, the grip-less audio tail after, so the
/// reorderable list is exactly this filter's result in this order.
function visualStackOf(sections: PeekSections): PeekItem[] {
  return sections.atPlayhead.filter(
    (item) => peekCategory(item.layer.params.kind) !== "audio",
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
  rowClassName,
  rowRef,
  onGripPointerDown,
}: {
  item: PeekItem;
  isSelected: boolean;
  fpsNum: number;
  fpsDen: number;
  onReveal: () => void;
  onGoTo?: (() => void) | undefined;
  onRename?: ((nextLabel: string) => void) | undefined;
  /// Reorder-gesture presentation owned by the panel (see usePointerReorder):
  /// drag / insertion-indicator classes for the row's <li>.
  rowClassName?: string | undefined;
  /// Registers the <li> as the live rect source for gap hit-testing. Present
  /// only on At-playhead visual rows.
  rowRef?: ((el: HTMLLIElement | null) => void) | undefined;
  /// When present the row shows a grip and is draggable to restack.
  onGripPointerDown?: ((e: ReactPointerEvent) => void) | undefined;
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
      // Keeps the row ref through a rename so a concurrent gesture on a
      // sibling row still hit-tests against every visual row's rect.
      <li className={rowClassName} ref={rowRef}>
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
    <li className={rowClassName} ref={rowRef}>
      <div className="peek-item-row">
        {/* Pointer-only restack affordance (ADR 0044 decision 6): the row
            body already spends click on select and double-click on rename,
            so the drag needs its own handle. Pure pointer events — never
            HTML5 draggable — so the gesture can't become a Dockview drag. */}
        {onGripPointerDown && (
          <span
            className="peek-grip"
            title={t("peek.restack_grip", { label: primaryLabel })}
            aria-label={t("peek.restack_grip", { label: primaryLabel })}
            onPointerDown={onGripPointerDown}
          >
            <GripVerticalIcon size={13} />
          </span>
        )}
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
