import { useEffect, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";

import { useHideMpvHost } from "../mpv/useHideMpvHost";

interface Props {
  onClose: () => void;
}

interface ActivityEntry {
  op_id: string;
  actor_kind: "user" | "agent";
  client?: string | null;
  summary: string;
  timestamp: string;
  affected_count: number;
  /// Locally assigned receive time so duplicates within one render flush
  /// can be ordered.
  received_at: number;
}

type Filter = "all" | "user" | "agent";

const MAX_ENTRIES = 200;

export function ActivityPanel({ onClose }: Props) {
  useHideMpvHost();
  const { t } = useTranslation();
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const u = await listen<unknown>("project:changed", (event) => {
        const payload = event.payload as Partial<ActivityEntry> & {
          lagged?: number;
        };
        // Lagged events have no real entry — skip them silently here; the
        // bridge in App.tsx already logs.
        if (payload.lagged != null) return;
        if (typeof payload.op_id !== "string") return;
        const entry: ActivityEntry = {
          op_id: payload.op_id,
          actor_kind: (payload.actor_kind as "user" | "agent") ?? "user",
          client: payload.client ?? null,
          summary: payload.summary ?? "",
          timestamp: payload.timestamp ?? new Date().toISOString(),
          affected_count: payload.affected_count ?? 0,
          received_at: Date.now(),
        };
        setEntries((prev) => {
          // Prepend; cap at MAX_ENTRIES so a session running for hours
          // doesn't grow without bound. Older entries fall off the bottom.
          const next = [entry, ...prev];
          if (next.length > MAX_ENTRIES) next.length = MAX_ENTRIES;
          return next;
        });
      });
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

  const filtered = useMemo(() => {
    if (filter === "all") return entries;
    return entries.filter((e) => e.actor_kind === filter);
  }, [entries, filter]);

  return (
    <div className="activity-overlay" role="dialog" aria-modal="true">
      <div className="activity-panel">
        <header>
          <h2>{t("activity.heading")}</h2>
          <button
            className="activity-close"
            onClick={onClose}
            aria-label={t("activity.close")}
          >
            ✕
          </button>
        </header>

        <div className="activity-filters" role="tablist">
          <FilterButton
            label={t("activity.filter_all")}
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
          <FilterButton
            label={t("activity.filter_user")}
            active={filter === "user"}
            onClick={() => setFilter("user")}
          />
          <FilterButton
            label={t("activity.filter_agent")}
            active={filter === "agent"}
            onClick={() => setFilter("agent")}
          />
          <span className="activity-count">
            {filtered.length} / {entries.length}
          </span>
        </div>

        {filtered.length === 0 ? (
          <p className="activity-empty">{t("activity.empty")}</p>
        ) : (
          <ul className="activity-list">
            {filtered.map((e) => (
              <li
                key={e.op_id}
                className={`activity-entry actor-${e.actor_kind}`}
              >
                <span className="activity-time">{formatTime(e.timestamp)}</span>
                <span className="activity-actor">
                  {e.actor_kind === "agent"
                    ? `Agent · ${e.client ?? "?"}`
                    : "User"}
                </span>
                <span className="activity-summary">{e.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FilterButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={active ? "activity-filter is-active" : "activity-filter"}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/// Render the time portion of an ISO 8601 timestamp as HH:MM:SS without
/// pulling in a date library. Falls back to the raw string on parse failure.
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
