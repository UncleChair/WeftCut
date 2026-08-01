import { useTranslation } from "react-i18next";

import { type AgentSession } from "../ipc";
import { RecordPanel } from "./RecordPanel";

/// Agent panel — the reusable agent-activity surface: title info on top,
/// the record stream below. One component, two arrangements:
///
///   - Agent mode (AgentMode): the fixed layout — panes cannot be dragged
///     or re-docked; the only adjustable seam is the panel width sash.
///     `session` is the live session, so the header shows the client's
///     name and reason, and the stream is windowed to the session start.
///   - Editor dock workspace (AgentDockPanel): a regular dock Panel,
///     draggable and resizable by Dockview. The dock only mounts outside
///     agent mode, so there is no session to headline — the header falls
///     back to the plain panel title — and the caller passes the epoch
///     window start to show full agent history.
interface AgentPanelProps {
  /// Session to headline the panel with (client + reason). Null outside an
  /// active session: the header shows the localized panel title instead.
  session: AgentSession | null;
  /// ISO 8601 log-stream window start (see RecordPanel).
  sessionStartedAt: string;
  lockReason: string | null;
}

export function AgentPanel({
  session,
  sessionStartedAt,
  lockReason,
}: AgentPanelProps) {
  const { t } = useTranslation();
  return (
    <div className="agent-panel">
      <header className="agent-record-header">
        <div className="agent-record-title">
          {session && (
            <span className="agent-record-client">
              {t("agent_mode.client_label", { client: session.client })}
            </span>
          )}
          {session ? (
            <span className="agent-record-reason" title={session.reason}>
              {session.reason}
            </span>
          ) : (
            <span className="agent-record-reason">
              {t("dock_workspace.panels.agent")}
            </span>
          )}
        </div>
      </header>
      <RecordPanel sessionStartedAt={sessionStartedAt} lockReason={lockReason} />
    </div>
  );
}
