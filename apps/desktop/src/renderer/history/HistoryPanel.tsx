import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, ChevronDown, ChevronRight, Lock, User } from "lucide-react";

import { tryMutate } from "../errors/tryMutate";
import {
  projectJumpTo,
  type HistoryEntityLabel,
  type HistoryStackEntry,
} from "../ipc";
import { useHistoryStore, wireHistoryStore } from "../state/historyStore";
import { afterNextProjectSummary, revealAffected } from "./historyLinkage";
import {
  buildHistoryItems,
  groupState,
  historyGroupId,
  rowState,
  type HistoryGroupItem,
  type HistoryRowState,
} from "./historyRows";

/// The History Panel: the project edit stack as a NAVIGABLE timeline
/// (PS / Premiere semantics — click row *i*, the cursor moves to *i*).
///
/// Not an audit log. The log ring already has three surfaces (StatusBar,
/// LogConsole, the dock's Agent panel); this reads the edit stack, a different
/// source answering a different question. The two entry sets barely overlap:
/// an agent's `analyze_clip` makes a log row and no history entry, a gizmo drag
/// makes a history entry and no log row (spec decision 1).
///
/// The Panel owns its own data: it wires `historyStore` on mount and tears it
/// down on unmount, so a closed Panel issues no IPC at all.

const EMPTY_OPS: HistoryStackEntry[] = [];

function formatClock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function HistoryPanel() {
  const { t } = useTranslation();
  const view = useHistoryStore((s) => s.view);
  const ready = useHistoryStore((s) => s.ready);

  // Mount wiring: seed + `project:changed` subscription, torn down on unmount.
  // The cancelled/async dance mirrors useAppWiring's stream effects — under
  // StrictMode the first cleanup can run before its own wire resolves.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const u = await wireHistoryStore();
      if (cancelled) {
        u();
        return;
      }
      unlisten = u;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const ops = view?.ops ?? EMPTY_OPS;
  const cursor = view?.cursor ?? 0;
  const evicted = view?.evicted ?? 0;
  const lockReason = view?.lock_reason ?? null;
  const items = useMemo(() => buildHistoryItems(ops), [ops]);

  // Expanded agent groups, keyed by the run's first op_id so expansion
  // survives a refetch.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const toggleGroup = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  // Supersession guard: a second click while the first jump's refetch is still
  // in flight must not let the older linkage land last and select the wrong
  // thing.
  const jumpGeneration = useRef(0);

  const jumpTo = useCallback(
    async (index: number) => {
      if (lockReason) return;
      if (index < 0 || index >= ops.length) return;
      // Refs come off the entry the cursor is LANDING on — uniform for rows
      // and for group headers (which target `groupStart - 1`), and it is that
      // entry's state we are about to be looking at.
      const refs = ops[index]?.affected ?? [];
      const generation = ++jumpGeneration.current;
      // Armed BEFORE the jump: the refetch can land while `projectJumpTo` is
      // still awaiting, and a subscription registered afterwards would wait
      // for an event that has already gone by. See historyLinkage.ts.
      const pending = afterNextProjectSummary();
      const ok = await tryMutate(() => projectJumpTo(index), "project_jump_to");
      if (!ok) {
        pending.cancel();
        return;
      }
      await pending.settled;
      if (jumpGeneration.current !== generation) return;
      revealAffected(refs);
    },
    [lockReason, ops],
  );

  // Sticky cursor follow, yielding the moment the user scrolls up and resuming
  // at the bottom — the convention RecordPanel.tsx:22-24 already establishes
  // for this panel family. 24 px of slack tolerates one overscroll tick.
  const listRef = useRef<HTMLDivElement | null>(null);
  const cursorRowRef = useRef<HTMLElement | null>(null);
  const stickyRef = useRef(true);
  useEffect(() => {
    const list = listRef.current;
    if (!list || !stickyRef.current) return;
    const target = cursorRowRef.current;
    if (!target) {
      list.scrollTop = list.scrollHeight;
      return;
    }
    const top = target.offsetTop;
    const bottom = top + target.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [items, cursor, expanded]);

  const onScroll = () => {
    const list = listRef.current;
    if (!list) return;
    const distanceFromBottom =
      list.scrollHeight - list.clientHeight - list.scrollTop;
    stickyRef.current = distanceFromBottom < 24;
  };

  const separator = t("history_panel.list_separator");

  const entityNames = (labels: HistoryEntityLabel[]): string =>
    labels
      .map((label) => ("text" in label ? label.text : t(label.kind_key)))
      .filter((name) => name.length > 0)
      .join(separator);

  const rowTitle = (state: HistoryRowState): string => {
    if (lockReason) return t("history_panel.locked_hint", { reason: lockReason });
    if (state === "current") return t("history_panel.current_hint");
    return state === "future"
      ? t("history_panel.redo_hint")
      : t("history_panel.jump_hint");
  };

  const renderEntryRow = (
    index: number,
    entry: HistoryStackEntry,
    nested: boolean,
  ) => {
    const state = rowState(index, cursor);
    const isCursor = index === cursor;
    const names = entityNames(entry.entity_labels);
    const client = entry.actor.kind === "Agent" ? entry.actor.client : null;
    return (
      <button
        key={entry.op_id}
        type="button"
        ref={isCursor ? (el) => { cursorRowRef.current = el; } : undefined}
        className={`history-row history-entry-row${nested ? " is-nested" : ""}`}
        data-history-index={index}
        data-state={state}
        aria-current={isCursor ? "true" : undefined}
        disabled={lockReason !== null}
        title={rowTitle(state)}
        onClick={() => void jumpTo(index)}
      >
        <span className="history-row-time">{formatClock(entry.timestamp)}</span>
        <span
          className="history-row-actor"
          data-actor={client === null ? "user" : "agent"}
          aria-label={
            client === null
              ? t("history_panel.actor_user")
              : t("history_panel.agent_client", { client })
          }
        >
          {client === null ? (
            <User size={12} aria-hidden="true" />
          ) : (
            <Bot size={12} aria-hidden="true" />
          )}
        </span>
        <span className="history-row-body">
          <span className="history-row-label">
            {t(entry.label_key, entry.label_args ?? {})}
          </span>
          {names && <span className="history-row-entities">{names}</span>}
        </span>
      </button>
    );
  };

  const renderGroup = (item: HistoryGroupItem) => {
    const id = historyGroupId(item);
    const isExpanded = expanded.has(id);
    const state = groupState(item, cursor);
    // Collapsed, the header stands in for whichever inner row holds the
    // cursor, so sticky follow still has something to scroll to.
    const isCursorProxy = state === "current" && !isExpanded;
    const unreachable = item.jumpIndex === null;
    const aggregate = item.aggregate
      .map((part) => {
        const label = t(part.labelKey, part.labelArgs ?? {});
        return part.count > 1
          ? t("history_panel.aggregate_item", { label, count: part.count })
          : label;
      })
      .join(separator);
    return (
      <div key={id} className="history-group" data-state={state}>
        <div className="history-group-header">
          <button
            type="button"
            className="history-group-toggle"
            aria-expanded={isExpanded}
            aria-label={t(
              isExpanded
                ? "history_panel.collapse_group"
                : "history_panel.expand_group",
            )}
            onClick={() => toggleGroup(id)}
          >
            {isExpanded ? (
              <ChevronDown size={12} aria-hidden="true" />
            ) : (
              <ChevronRight size={12} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            ref={
              isCursorProxy ? (el) => { cursorRowRef.current = el; } : undefined
            }
            className="history-row history-group-row"
            data-history-group-start={item.startIndex}
            data-state={state}
            aria-current={isCursorProxy ? "true" : undefined}
            disabled={lockReason !== null || unreachable}
            title={
              lockReason
                ? t("history_panel.locked_hint", { reason: lockReason })
                : unreachable
                  ? t("history_panel.group_jump_unavailable")
                  : t("history_panel.group_jump_hint")
            }
            onClick={() => {
              if (item.jumpIndex !== null) void jumpTo(item.jumpIndex);
            }}
          >
            <span className="history-row-time">
              {formatClock(item.entries[0]?.timestamp ?? "")}
            </span>
            <span className="history-row-actor" data-actor="agent">
              <Bot size={12} aria-hidden="true" />
            </span>
            <span className="history-row-body">
              <span className="history-row-label">{item.client}</span>
              <span className="history-group-steps">
                {t("history_panel.group_steps", { count: item.entries.length })}
              </span>
              <span className="history-group-aggregate">{aggregate}</span>
            </span>
          </button>
        </div>
        {isExpanded &&
          item.entries.map((entry, offset) =>
            renderEntryRow(item.startIndex + offset, entry, true),
          )}
      </div>
    );
  };

  return (
    <div className="history-panel">
      {/* Checkpoints live above the stack in their own section — they are not
          stack rows: `restore_checkpoint` RECORDS a new entry rather than
          moving the cursor, so drawing them inline would lie about what a
          click does (spec decision 9). Ticket 04 fills this slot; it is empty
          on purpose, not forgotten. */}
      <section className="history-checkpoints" data-history-section="checkpoints" />
      {lockReason && (
        <div className="history-lock-badge" title={lockReason}>
          <Lock size={12} aria-hidden="true" />
          <span className="history-lock-reason">
            {t("history_panel.locked_hint", { reason: lockReason })}
          </span>
        </div>
      )}
      <div
        className="history-stack"
        ref={listRef}
        onScroll={onScroll}
        data-testid="history-stack"
      >
        {evicted > 0 && (
          // Non-interactive: `record()`'s shift() does not spare the `Initial`
          // entry, so without this the top row is an ordinary op and nothing
          // says whether everything before it was discarded (spec decision 12).
          // Those snapshots are gone — there is nothing to jump to.
          <div className="history-row history-evicted-row" role="note">
            {t("history_panel.evicted", { count: evicted })}
          </div>
        )}
        {items.map((item) =>
          item.kind === "group"
            ? renderGroup(item)
            : renderEntryRow(item.index, item.entry, false),
        )}
        {items.length === 0 && (
          <div className="history-empty">
            {t(ready ? "history_panel.empty" : "history_panel.loading")}
          </div>
        )}
      </div>
    </div>
  );
}
