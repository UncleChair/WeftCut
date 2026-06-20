import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen, type UnlistenFn } from "@/bridge/events";
import { useLogStore, ERROR_STICKY_MS } from "./store";
import { MEDIA_JOB_EVENTS, type LogEntry, type LogLevel } from "../ipc";

/// Persistent ~28px status bar pinned to the bottom of the editor view.
/// Shows a severity dot + time + truncated message + source pill on the
/// left; error badge + running badge + Logs toggle on the right. The
/// toggle opens the expanded console overlay.
///
/// Layout decision (Q5 hybrid C): always-visible left-aligned "latest
/// message" line; right-aligned counters; errors stick for 10s before
/// being overwritten by subsequent Info entries.
///
/// Accessibility (Q14): errors are announced via a visually-hidden
/// polite live region; info/warn entries do not announce.
export function StatusBar({ onToggleLogs }: { onToggleLogs?: () => void }) {
  const { t } = useTranslation();
  // Atomic selectors — returning a composite object literal from one
  // selector triggers an infinite useSyncExternalStore loop because each
  // call yields a new reference. Primitive/store-owned references compare
  // stable under the default Object.is equality.
  const latest = useLogStore((s) => s.latest);
  const errorCount = useLogStore((s) => s.errorCount);
  const runningCount = useLogStore((s) =>
    Object.keys(s.runningOps).length,
  );
  // Agent-attributed running ops: a subset of runningOps where the
  // associated entry's source kind is "Agent". Surfaced as its own
  // pill so the user has a signal that an MCP client is still working
  // after exiting agent mode (Q4: ops finish in the background).
  const agentRunningCount = useLogStore((s) => {
    let n = 0;
    for (const opId of Object.keys(s.runningOps)) {
      const e = s.entries.find((x) => x.op_id === opId);
      if (e?.source.kind === "Agent") n += 1;
    }
    return n;
  });
  // Derivative-job tracker. Increments on `media:job_started`,
  // decrements on `media:job_complete` / `media:job_error`. The total
  // renders a "Generating derivatives (N)…" pill so the user sees that
  // proxies / thumbnails / waveforms are still grinding in the
  // background.
  const [pendingDerivatives, setPendingDerivatives] = useState<number>(0);
  // The visually-hidden live region is only updated on errors. Tracked
  // separately from `latest` so a flurry of low-severity entries
  // doesn't spam the screen reader.
  const [announce, setAnnounce] = useState("");

  useEffect(() => {
    if (latest && latest.level === "error") {
      setAnnounce(`${t("status_bar.announce_error_prefix")}: ${latest.message}`);
    }
  }, [latest, t]);

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;
    (async () => {
      const onStarted = await listen(MEDIA_JOB_EVENTS.started, () => {
        setPendingDerivatives((n) => n + 1);
      });
      const onComplete = await listen(MEDIA_JOB_EVENTS.complete, () => {
        setPendingDerivatives((n) => Math.max(0, n - 1));
      });
      const onError = await listen(MEDIA_JOB_EVENTS.error, () => {
        setPendingDerivatives((n) => Math.max(0, n - 1));
      });
      if (cancelled) {
        onStarted();
        onComplete();
        onError();
        return;
      }
      unlisteners.push(onStarted, onComplete, onError);
    })();
    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
  }, []);

  return (
    <footer
      className="status-bar"
      role="status"
      aria-label={t("status_bar.label")}
    >
      <div className="status-bar-left">
        {latest ? (
          <>
            <LevelDot level={latest.level} />
            <span className="status-bar-time">{formatTime(latest.ts)}</span>
            <span className="status-bar-message" title={latest.message}>
              {latest.message}
            </span>
            <SourcePill entry={latest} />
          </>
        ) : (
          <span className="status-bar-empty">{t("status_bar.empty")}</span>
        )}
      </div>
      <div className="status-bar-right">
        {pendingDerivatives > 0 && (
          <span
            className="derivatives-pill"
            title={t("project.derivatives_pending_hint")}
          >
            <span className="derivatives-pill-spinner" aria-hidden="true" />
            {t("project.derivatives_pending", { count: pendingDerivatives })}
          </span>
        )}
        {agentRunningCount > 0 && (
          <span
            className="agent-running-pill"
            title={t("agent_mode.running_pill_hint")}
          >
            <span className="agent-running-spinner" aria-hidden="true" />
            {t("agent_mode.running_pill", { count: agentRunningCount })}
          </span>
        )}
        {errorCount > 0 && (
          <button
            type="button"
            className="status-bar-badge status-bar-badge-error"
            onClick={onToggleLogs}
            title={t("status_bar.error_badge_hint", { count: errorCount })}
            aria-label={t("status_bar.error_badge_hint", { count: errorCount })}
          >
            <span aria-hidden="true">⚠</span>
            {errorCount}
          </button>
        )}
        {runningCount > 0 && (
          <button
            type="button"
            className="status-bar-badge status-bar-badge-running"
            onClick={onToggleLogs}
            title={t("status_bar.running_badge_hint", { count: runningCount })}
            aria-label={t("status_bar.running_badge_hint", { count: runningCount })}
          >
            <span className="status-bar-spinner" aria-hidden="true" />
            {runningCount}
          </button>
        )}
        <button
          type="button"
          className="status-bar-logs-toggle"
          onClick={onToggleLogs}
          title={t("status_bar.toggle_hint")}
          aria-label={t("status_bar.toggle_hint")}
          disabled={!onToggleLogs}
        >
          {t("status_bar.toggle_label")}
        </button>
      </div>
      <div
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
        role="status"
      >
        {announce}
      </div>
    </footer>
  );
}

function LevelDot({ level }: { level: LogLevel }) {
  return (
    <span
      className={`status-bar-level-dot level-${level}`}
      aria-hidden="true"
      title={level}
    />
  );
}

function SourcePill({ entry }: { entry: LogEntry }) {
  const { t } = useTranslation();
  const kind = entry.source.kind;
  let label: string;
  if (kind === "User") {
    label = t("status_bar.source_user");
  } else if (kind === "Agent") {
    label = t("status_bar.source_agent", { client: entry.source.client });
  } else {
    label = t("status_bar.source_system");
  }
  return (
    <span className={`status-bar-source source-${kind.toLowerCase()}`}>
      {label}
    </span>
  );
}

/// HH:MM:SS in the user's locale.
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

/// Re-export so a future "tick the error-sticky timer at expiry" effect
/// can read the same constant from one place.
export const _ERROR_STICKY_MS = ERROR_STICKY_MS;
