import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { XIcon } from "lucide-react";
import { open as openInShell } from "@/bridge/shell";
import { AppInput } from "../components/AppInput";
import {
  logClear,
  logDirPath,
  type LogCategory,
  type LogEntry,
  type LogLevel,
  type LogSource,
  type OpState,
} from "../ipc";
import { renderLogMessage } from "./renderMessage";
import { useLogStore } from "./store";

/// Expanded console overlay — lifts above the editor. Layout decision +
/// deferred-features list: `docs/status-log.md`.
///
/// Defaults: level `Info+`, ops collapsed.
///
/// Non-virtualised — the ring is 1000 entries, which renders fine on
/// any modern Chromium. If a future workload changes that, drop in
/// `react-window`.

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

type LevelFilter = "all" | "info" | "warn" | "errorOnly";
const LEVEL_THRESHOLDS: Record<LevelFilter, LogLevel> = {
  all: "trace",
  info: "info",
  warn: "warn",
  errorOnly: "error",
};

const CATEGORY_KINDS = [
  "Shortcut",
  "Mcp",
  "Job",
  "Export",
  "Import",
  "Project",
  "System",
  "Agent",
] as const;
type CategoryKind = (typeof CATEGORY_KINDS)[number];

const SOURCE_KINDS = ["User", "Agent", "System"] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];

export interface LogConsoleHandle {
  focusSearch: () => void;
}

interface Props {
  onClose: () => void;
}

async function clearLogs(): Promise<void> {
  try {
    await logClear();
    useLogStore.getState().clear();
  } catch (e) {
    console.warn("logClear failed:", e);
  }
}

export const LogConsole = forwardRef<LogConsoleHandle, Props>(function LogConsole(
  { onClose },
  ref,
) {
  const { t } = useTranslation();
  const entries = useLogStore((s) => s.entries);
  const acknowledgeErrorSticky = useLogStore((s) => s.acknowledgeErrorSticky);

  const [levelFilter, setLevelFilter] = useState<LevelFilter>("info");
  const [categoryFilters, setCategoryFilters] = useState<Set<CategoryKind>>(
    () => new Set(CATEGORY_KINDS),
  );
  const [sourceFilters, setSourceFilters] = useState<Set<SourceKind>>(
    () => new Set(SOURCE_KINDS),
  );
  const [search, setSearch] = useState("");
  const [expandedOps, setExpandedOps] = useState<Set<string>>(new Set());
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());
  const [autoscroll, setAutoscroll] = useState(true);
  const [logsDir, setLogsDir] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Expose `focusSearch` so the toggle-with-Ctrl+Shift+` shortcut can
  // open the console and drop focus into the search box.
  useImperativeHandle(
    ref,
    () => ({
      focusSearch: () => {
        searchRef.current?.focus();
        searchRef.current?.select();
      },
    }),
    [],
  );

  // Acknowledge any sticky error in the bar when the console opens —
  // the user is now looking; the bar can roll forward.
  useEffect(() => {
    acknowledgeErrorSticky();
  }, [acknowledgeErrorSticky]);

  // Resolve the workspace's Logs/ path so the "Open log folder" action
  // can hand it to the OS file manager.
  useEffect(() => {
    let cancelled = false;
    logDirPath()
      .then((p) => {
        if (!cancelled) setLogsDir(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const minLevel = LEVEL_THRESHOLDS[levelFilter];
  const minLevelOrd = LEVEL_ORDER[minLevel];
  // Op grouping: walk the ring; the FIRST entry seen per op_id is the
  // "head" row. Subsequent entries with the same op_id become
  // children of that head. Entries without op_id are their own rows.
  //
  // Because the ring is newest-first, the head is the newest update
  // (i.e. "latest state wins"), which matches the design's "collapsed
  // row shows latest state".
  const filteredRows = useMemo(() => {
    type Row = {
      head: LogEntry;
      children: LogEntry[];
    };
    const headByOp: Record<string, Row> = {};
    const rows: Row[] = [];
    const term = search.trim().toLowerCase();
    for (const e of entries) {
      if (LEVEL_ORDER[e.level] < minLevelOrd) continue;
      const catKind = e.category.kind as CategoryKind;
      if (!categoryFilters.has(catKind)) continue;
      const srcKind = e.source.kind as SourceKind;
      if (!sourceFilters.has(srcKind)) continue;
      if (term) {
        // Raw English + translated rendering + details, per the search
        // contract in docs/status-log.md § i18n.
        const haystack = (
          e.message +
          " " +
          renderLogMessage(e, t) +
          " " +
          (e.details ? JSON.stringify(e.details) : "")
        ).toLowerCase();
        if (!haystack.includes(term)) continue;
      }
      if (e.op_id) {
        const existing = headByOp[e.op_id];
        if (existing) {
          existing.children.push(e);
        } else {
          const row = { head: e, children: [] as LogEntry[] };
          headByOp[e.op_id] = row;
          rows.push(row);
        }
      } else {
        rows.push({ head: e, children: [] });
      }
    }
    return rows;
  }, [entries, minLevelOrd, categoryFilters, sourceFilters, search, t]);

  // Autoscroll on new entries when enabled; the toolbar's autoscroll toggle
  // suspends it (the user scrolled up to read history).
  useEffect(() => {
    if (autoscroll && listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [autoscroll, filteredRows.length]);

  const toggleCategory = (k: CategoryKind) => {
    setCategoryFilters((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };
  const toggleSource = (k: SourceKind) => {
    setSourceFilters((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const toggleOp = (opId: string) => {
    setExpandedOps((prev) => {
      const next = new Set(prev);
      if (next.has(opId)) next.delete(opId);
      else next.add(opId);
      return next;
    });
  };
  const toggleEntry = (id: string) => {
    setExpandedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onCopy = async () => {
    const lines: string[] = [];
    for (const row of filteredRows) {
      lines.push(renderEntryAsLine(row.head));
      for (const child of row.children) lines.push(renderEntryAsLine(child));
    }
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      console.warn("clipboard write failed:", e);
    }
  };

  const onOpenLogFolder = async () => {
    if (!logsDir) return;
    try {
      await openInShell(logsDir);
    } catch (e) {
      console.warn("open log folder failed:", e);
    }
  };

  // Two-stage Esc inside search: first clears the term, second collapses.
  const onKeyDownSearch = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (search) {
        e.preventDefault();
        setSearch("");
      } else {
        e.preventDefault();
        onClose();
      }
    }
  };

  const onKeyDownPanel = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      const target = e.target as HTMLElement | null;
      // Skip — the search-box handler above owns this case.
      if (target?.tagName === "INPUT") return;
      onClose();
    }
  };

  const total = entries.length;
  const shown = filteredRows.reduce(
    (acc, r) => acc + 1 + r.children.length,
    0,
  );

  return (
    <div className="log-console" role="log" onKeyDown={onKeyDownPanel}>
      <div className="log-console-toolbar">
        <div className="log-chip-group" role="group" aria-label={t("log.level_filter")}>
          {(["all", "info", "warn", "errorOnly"] as LevelFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={`log-chip${levelFilter === f ? " active" : ""}`}
              onClick={() => setLevelFilter(f)}
            >
              {t(`log.level_${f}`)}
            </button>
          ))}
        </div>

        <div
          className="log-chip-group"
          role="group"
          aria-label={t("log.category_filter")}
        >
          {CATEGORY_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={`log-chip${categoryFilters.has(k) ? " active" : ""}`}
              onClick={() => toggleCategory(k)}
            >
              {t(`log.category_${k}`, { defaultValue: k })}
            </button>
          ))}
        </div>

        <div className="log-chip-group" role="group" aria-label={t("log.source_filter")}>
          {SOURCE_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={`log-chip${sourceFilters.has(k) ? " active" : ""}`}
              onClick={() => toggleSource(k)}
            >
              {t(`log.source_${k}`, { defaultValue: k })}
            </button>
          ))}
        </div>

        <AppInput
          ref={searchRef}
          type="search"
          className="log-search"
          placeholder={t("log.search_placeholder")}
          ariaLabel={t("log.search_placeholder")}
          value={search}
          onValueChange={setSearch}
          onKeyDown={onKeyDownSearch}
        />

        <div className="log-toolbar-actions">
          <button
            type="button"
            className={`log-action${autoscroll ? "" : " is-off"}`}
            onClick={() => setAutoscroll((v) => !v)}
            title={t("log.autoscroll_hint")}
          >
            {autoscroll ? t("log.autoscroll_on") : t("log.autoscroll_off")}
          </button>
          <button type="button" className="log-action" onClick={onCopy}>
            {t("log.copy")}
          </button>
          <button type="button" className="log-action" onClick={clearLogs}>
            {t("log.clear")}
          </button>
          <button
            type="button"
            className="log-action"
            onClick={onOpenLogFolder}
            disabled={!logsDir}
            title={logsDir ?? t("log.open_folder_unavailable_hint")}
          >
            {t("log.open_folder")}
          </button>
          <button
            type="button"
            className="log-action log-close"
            onClick={onClose}
            aria-label={t("log.close")}
          >
            <XIcon size={13} aria-hidden />
          </button>
        </div>
      </div>

      <div className="log-console-list" ref={listRef}>
        {filteredRows.length === 0 ? (
          <p className="log-empty">{t("log.empty")}</p>
        ) : (
          <ul>
            {filteredRows.map((row) => {
              const opId = row.head.op_id;
              const isGroup = !!opId && row.children.length > 0;
              const opExpanded = !!opId && expandedOps.has(opId);
              const entryExpanded = expandedEntries.has(row.head.id);
              return (
                <li
                  key={row.head.id}
                  className={`log-row level-${row.head.level}`}
                >
                  <div className="log-row-main">
                    <span className="log-time">{formatTime(row.head.ts)}</span>
                    <span className={`log-level-dot level-${row.head.level}`} />
                    <CategoryPill category={row.head.category} />
                    <SourcePill source={row.head.source} />
                    <span
                      className="log-message"
                      title={renderLogMessage(row.head, t)}
                    >
                      {renderLogMessage(row.head, t)}
                    </span>
                    {row.head.op_state && (
                      <OpStatePill state={row.head.op_state} />
                    )}
                    {isGroup && (
                      <button
                        type="button"
                        className="log-op-counter"
                        onClick={() => opId && toggleOp(opId)}
                        title={t("log.op_counter_hint")}
                      >
                        ({row.children.length + 1})
                      </button>
                    )}
                    {(row.head.details != null || row.head.op_id) && (
                      <button
                        type="button"
                        className="log-details-toggle"
                        onClick={() => toggleEntry(row.head.id)}
                        aria-label={t("log.toggle_details")}
                      >
                        ⋯
                      </button>
                    )}
                  </div>
                  {entryExpanded && (
                    <div className="log-row-details">
                      {row.head.op_id && (
                        <div className="log-op-id">
                          op_id: <code>{row.head.op_id}</code>
                        </div>
                      )}
                      {row.head.details != null && (
                        <pre className="log-details-json">
                          {JSON.stringify(row.head.details, null, 2)}
                        </pre>
                      )}
                    </div>
                  )}
                  {isGroup && opExpanded && (
                    <ul className="log-op-children">
                      {row.children.map((c) => (
                        <li key={c.id} className={`log-row level-${c.level}`}>
                          <span className="log-time">{formatTime(c.ts)}</span>
                          <span className={`log-level-dot level-${c.level}`} />
                          <span className="log-message">
                            {renderLogMessage(c, t)}
                          </span>
                          {c.op_state && <OpStatePill state={c.op_state} />}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="log-console-footer">
        <span className="log-footer-count">
          {t("log.showing_of", { shown, total })}
        </span>
        {logsDir && (
          <span className="log-footer-path" title={logsDir}>
            {logsDir}
          </span>
        )}
      </div>
    </div>
  );
});

function CategoryPill({ category }: { category: LogCategory }) {
  const { t } = useTranslation();
  const label =
    category.kind === "Other"
      ? category.name
      : t(`log.category_${category.kind}`, { defaultValue: category.kind });
  return (
    <span className={`log-category-pill category-${category.kind.toLowerCase()}`}>
      {label}
    </span>
  );
}

function SourcePill({ source }: { source: LogSource }) {
  const { t } = useTranslation();
  let label: string;
  if (source.kind === "User") label = t("log.source_User");
  else if (source.kind === "Agent")
    label = t("status_bar.source_agent", { client: source.client });
  else label = t("log.source_System");
  return (
    <span className={`log-source-pill source-${source.kind.toLowerCase()}`}>
      {label}
    </span>
  );
}

function OpStatePill({ state }: { state: OpState }) {
  const { t } = useTranslation();
  if (state.state === "Progress") {
    const pct = Math.round((state.progress ?? 0) * 100);
    return (
      <span className="log-op-state progress">
        <span className="log-op-progress-fill" style={{ width: `${pct}%` }} />
        <span className="log-op-progress-label">{pct}%</span>
      </span>
    );
  }
  return (
    <span className={`log-op-state state-${state.state.toLowerCase()}`}>
      {t(`log.op_state_${state.state}`, { defaultValue: state.state })}
    </span>
  );
}

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

function renderEntryAsLine(e: LogEntry): string {
  const time = formatTime(e.ts);
  const cat = e.category.kind === "Other" ? e.category.name : e.category.kind;
  const src =
    e.source.kind === "Agent"
      ? `Agent(${e.source.client})`
      : e.source.kind;
  const tail = e.details != null ? ` ${JSON.stringify(e.details)}` : "";
  return `[${time}] ${e.level.toUpperCase()} ${cat} ${src} — ${e.message}${tail}`;
}
