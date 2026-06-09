import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  projectRestoreCheckpoint,
  type LogEntry,
  type OpState,
} from "../ipc";
import { useLogStore } from "../logs/store";

/// Agent-mode record panel — filtered + grouped view of the log
/// stream that the agent-attributed entries produce while a session
/// is active. See `docs/mcp.md` Q6 + Q7 + Q8 for the design.
///
/// Filter (Q6.B + Q6.X):
///   * source.kind === "Agent"     (agent-attributed events only)
///   * ts >= session.started_at    (this-session-only window)
///
/// Grouping:
///   * Entries with op_id collapse into a single row per op. The
///     row shows the latest message + a status icon derived from the
///     terminal op_state (Started/Progress → running, Ok → done,
///     Err → error).
///   * Entries with details.kind === "Checkpoint" are rendered as
///     pin-style rows with a Restore button regardless of op_id.
///   * Entries with neither become single-entry rows.
///
/// Order: chronological (oldest first), with an auto-scroll-to-bottom
/// behavior that yields the moment the user scrolls up — Premiere /
/// build-log convention.
///
/// Lock badge (Q8): rendered above the row list when the project's
/// HistoryView reports a non-null lock_reason. Restore buttons on
/// checkpoint rows are disabled while the lock is held (the Tauri
/// command would reject anyway, but disabling the click is friendlier
/// UX).

interface RecordPanelProps {
  sessionStartedAt: string; // ISO 8601 (chrono::DateTime<Utc>)
  lockReason: string | null;
}

type Row =
  | { kind: "op"; id: string; firstTs: string; latest: LogEntry; status: OpStatus; count: number }
  | { kind: "standalone"; id: string; ts: string; entry: LogEntry }
  | {
      kind: "checkpoint";
      id: string; // checkpoint id from the structured details
      ts: string;
      label: string;
      entryId: string; // log entry id, for React key uniqueness
    }
  | {
      kind: "restore-divider";
      id: string; // log entry id, for React key uniqueness
      ts: string;
      targetLabel: string;
    };

type OpStatus = "running" | "done" | "error";

function statusFromOpState(state: OpState | null | undefined, current: OpStatus): OpStatus {
  if (!state) return current;
  // Last writer wins: a later Err displaces a prior Ok, etc.
  switch (state.state) {
    case "Started":
    case "Progress":
      return "running";
    case "Ok":
      return "done";
    case "Err":
      return "error";
  }
}

function isCheckpointDetails(details: unknown): details is { kind: "Checkpoint"; id: string; label: string } {
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { kind?: unknown }).kind === "Checkpoint"
  );
}

function isRestoreDetails(
  details: unknown,
): details is { kind: "Restore"; checkpoint_id: string; label: string | null } {
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { kind?: unknown }).kind === "Restore"
  );
}

function buildRows(entries: LogEntry[], sessionStartedAt: string): Row[] {
  const sessionStart = Date.parse(sessionStartedAt);

  // Chronological order. We accept entries from any source here so
  // user-initiated Restore events (which carry `source: User`) reach
  // the rolled-back-range collector below. The Agent-source filter is
  // applied per-row inside the build loop, EXCLUDING Restore entries
  // which we always surface as boundary markers.
  const chronological: LogEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (Date.parse(e.ts) < sessionStart) continue;
    chronological.push(e);
  }

  // Pass 1: build a checkpoint_id → ts lookup, then collect the
  // [target_cp.ts, restore_event.ts] ranges that the user / agent
  // rolled back. Entries with ts strictly inside any of these
  // ranges are hidden from the panel — they happened but have been
  // undone, so showing them is misleading.
  const cpTsMap = new Map<string, number>();
  for (const e of chronological) {
    if (isCheckpointDetails(e.details)) {
      cpTsMap.set(e.details.id, Date.parse(e.ts));
    }
  }
  const rolledBackRanges: { start: number; end: number }[] = [];
  for (const e of chronological) {
    if (isRestoreDetails(e.details)) {
      const targetTs = cpTsMap.get(e.details.checkpoint_id);
      if (targetTs !== undefined) {
        rolledBackRanges.push({ start: targetTs, end: Date.parse(e.ts) });
      }
    }
  }
  const isRolledBack = (ts: string): boolean => {
    const t = Date.parse(ts);
    for (const r of rolledBackRanges) {
      // Strict exclusion on both ends so the target checkpoint pin
      // and the Restore divider itself stay visible.
      if (t > r.start && t < r.end) return true;
    }
    return false;
  };

  // Pass 2: build rows. Op groups settle on the LATEST entry naturally
  // because chronological order means later entries overwrite earlier
  // state for the same op_id key.
  type Group = { firstTs: string; latest: LogEntry; status: OpStatus; count: number };
  const groups = new Map<string, Group>();
  const rows: Row[] = [];
  for (const e of chronological) {
    if (isRolledBack(e.ts)) continue;

    // Restore boundary rows always show, regardless of source.
    if (isRestoreDetails(e.details)) {
      rows.push({
        kind: "restore-divider",
        id: e.id,
        ts: e.ts,
        targetLabel: e.details.label ?? "checkpoint",
      });
      continue;
    }

    // Checkpoint rows always stand alone, regardless of op_id.
    if (isCheckpointDetails(e.details)) {
      rows.push({
        kind: "checkpoint",
        id: e.details.id,
        ts: e.ts,
        label: e.details.label,
        entryId: e.id,
      });
      continue;
    }

    // Everything else: agent-attributed only.
    if (e.source.kind !== "Agent") continue;

    if (e.op_id) {
      const g = groups.get(e.op_id);
      if (g) {
        g.latest = e;
        g.status = statusFromOpState(e.op_state, g.status);
        g.count += 1;
      } else {
        const fresh: Group = {
          firstTs: e.ts,
          latest: e,
          status: statusFromOpState(e.op_state, "running"),
          count: 1,
        };
        groups.set(e.op_id, fresh);
        // Insert a placeholder row at first-seen position; we
        // rewrite its `latest` / `status` as more entries land
        // in this same op below.
        rows.push({
          kind: "op",
          id: e.op_id,
          firstTs: fresh.firstTs,
          latest: fresh.latest,
          status: fresh.status,
          count: fresh.count,
        });
      }
      continue;
    }
    rows.push({ kind: "standalone", id: e.id, ts: e.ts, entry: e });
  }

  // Patch op-rows with their finalized state (the placeholder was
  // inserted at first-seen position; the accumulator gathered every
  // entry's contribution after that).
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.kind !== "op") continue;
    const g = groups.get(r.id);
    if (!g) continue;
    rows[i] = {
      kind: "op",
      id: r.id,
      firstTs: g.firstTs,
      latest: g.latest,
      status: g.status,
      count: g.count,
    };
  }
  return rows;
}

function formatClock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function shortOpName(message: string): string {
  // MCP entries lead with "MCP: <tool> <verb> ...". Strip both
  // prefixes for a tight panel row. Fall back to the full message.
  const m = /^MCP:\s+([a-z_]+)/.exec(message);
  if (m) return m[1]!;
  return message;
}

export function RecordPanel({ sessionStartedAt, lockReason }: RecordPanelProps) {
  const { t } = useTranslation();
  const entries = useLogStore((s) => s.entries);
  const rows = useMemo(() => buildRows(entries, sessionStartedAt), [
    entries,
    sessionStartedAt,
  ]);

  // Auto-scroll-to-bottom UX: stick to the latest unless the user
  // has scrolled up far enough that we should yield. 24 px slack
  // tolerates a single overscroll tick without breaking stickiness.
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef<boolean>(true);
  useEffect(() => {
    const el = listRef.current;
    if (!el || !stickyRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [rows]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    stickyRef.current = distanceFromBottom < 24;
  };

  const [restoring, setRestoring] = useState<string | null>(null);
  const onRestore = async (checkpointId: string) => {
    if (lockReason) return; // belt-and-suspenders; backend would also reject
    setRestoring(checkpointId);
    try {
      await projectRestoreCheckpoint(checkpointId);
    } catch (e) {
      console.warn("restore failed:", e);
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div className="agent-record-body">
      {lockReason && (
        <div className="agent-lock-badge" title={t("agent_mode.lock_hint")}>
          <span className="agent-lock-icon" aria-hidden="true">🔒</span>
          <span className="agent-lock-reason">{lockReason}</span>
        </div>
      )}
      <div className="agent-record-list" ref={listRef} onScroll={onScroll}>
        {rows.length === 0 ? (
          <div className="agent-record-empty">{t("agent_mode.empty_waiting")}</div>
        ) : (
          rows.map((row) => {
            if (row.kind === "checkpoint") {
              const disabled = !!lockReason || restoring === row.id;
              return (
                <div key={row.entryId} className="agent-record-row checkpoint-row">
                  <span className="row-time">{formatClock(row.ts)}</span>
                  <span className="row-icon" aria-hidden="true">📌</span>
                  <span className="row-body row-checkpoint-label" title={row.label}>
                    {row.label}
                  </span>
                  <button
                    className="row-restore"
                    onClick={() => onRestore(row.id)}
                    disabled={disabled}
                    title={
                      lockReason
                        ? t("agent_mode.restore_locked_hint", { reason: lockReason })
                        : t("agent_mode.restore_hint")
                    }
                  >
                    {restoring === row.id
                      ? t("agent_mode.restoring")
                      : t("agent_mode.restore")}
                  </button>
                </div>
              );
            }
            if (row.kind === "op") {
              return (
                <div
                  key={row.id}
                  className={`agent-record-row op-row status-${row.status}`}
                >
                  <span className="row-time">{formatClock(row.firstTs)}</span>
                  <span className={`row-icon status-${row.status}`} aria-hidden="true">
                    {row.status === "running" ? "◌" : row.status === "done" ? "✓" : "⚠"}
                  </span>
                  <span className="row-body" title={row.latest.message}>
                    <span className="row-tool">{shortOpName(row.latest.message)}</span>
                  </span>
                </div>
              );
            }
            if (row.kind === "restore-divider") {
              return (
                <div key={row.id} className="agent-record-row restore-divider-row">
                  <span className="row-time">{formatClock(row.ts)}</span>
                  <span className="row-icon" aria-hidden="true">↩</span>
                  <span className="row-body" title={row.targetLabel}>
                    {t("agent_mode.restored_to", { label: row.targetLabel })}
                  </span>
                </div>
              );
            }
            // standalone
            return (
              <div
                key={row.id}
                className={`agent-record-row standalone-row level-${row.entry.level}`}
              >
                <span className="row-time">{formatClock(row.ts)}</span>
                <span className="row-body" title={row.entry.message}>
                  {row.entry.message}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
