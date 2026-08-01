import { useTranslation } from "react-i18next";
import {
  forwardRef,
  type ForwardedRef,
} from "react";

import {
  type AgentSession,
  type ProjectSummary,
} from "../ipc";
import {
  PreviewSurface,
  type PreviewSurfaceHandle,
} from "../preview/PreviewSurface";
import { MiniTimeline } from "./MiniTimeline";
import { RecordPanel } from "./RecordPanel";
import { setPlayheadTimeUs } from "../state/playheadStore";
import { Button } from "@/components/ui/button";
import { WindowControls } from "../components/WindowControls";

/// Agent mode — the simplified preview / mini-timeline / record-panel
/// layout the human sees while an agent session is active. Entered via
/// the `begin_agent_session` MCP tool or locally via the View menu /
/// command palette (`agent_session_begin` channel); exited via the
/// persistent "Exit to editor" button in the record-panel header.
///
/// Layout: preview top-left (expanding), mini timeline bottom-left
/// (fixed ~80 px), record panel right (fixed ~360 px). See docs/mcp.md.
/// Both the menu bar and editor-mode status bar are hidden — in
/// agent mode the record panel IS the surface for activity.
interface AgentModeProps {
  session: AgentSession;
  summary: ProjectSummary | null;
  onPausedChange: (paused: boolean) => void;
  onSeek: (tUs: number) => void;
  /// User-side exit handler. Wired by the parent to call
  /// `agentSessionEnd` then refresh state.
  onExit: () => void;
}

export const AgentMode = forwardRef(function AgentMode(
  {
    session,
    summary,
    onPausedChange,
    onSeek,
    onExit,
  }: AgentModeProps,
  previewRef: ForwardedRef<PreviewSurfaceHandle>,
) {
  return (
    <div className="agent-mode-shell">
      {/* Frameless window: agent mode replaces the whole app layout, so
          it carries its own slim drag strip + caption buttons. */}
      <div className="agent-titlebar" data-drag-region>
        <WindowControls />
      </div>
      <section className="agent-preview">
        <div id="video-surface" className="video-surface">
          <PreviewSurface
            ref={previewRef}
            hasContent={(summary?.layer_count ?? 0) > 0}
            onTimeUpdate={setPlayheadTimeUs}
            onPausedChange={onPausedChange}
          />
        </div>
      </section>

      <section className="agent-mini-timeline">
        <MiniTimeline
          durationUs={summary?.duration_us ?? 0}
          markers={summary?.markers ?? []}
          onSeek={onSeek}
          fpsNum={summary?.composition.fps_num ?? 30}
          fpsDen={summary?.composition.fps_den ?? 1}
        />
      </section>

      <section className="agent-record">
        <RecordPanelHeader session={session} onExit={onExit} />
        <RecordPanel
          sessionStartedAt={session.started_at}
          lockReason={summary?.history.lock_reason ?? null}
        />
      </section>
    </div>
  );
});

function RecordPanelHeader({
  session,
  onExit,
}: {
  session: AgentSession;
  onExit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <header className="agent-record-header">
      <div className="agent-record-title">
        <span className="agent-record-client">
          {t("agent_mode.client_label", { client: session.client })}
        </span>
        <span className="agent-record-reason" title={session.reason}>
          {session.reason}
        </span>
      </div>
      <Button size="lg" onClick={onExit} title={t("agent_mode.exit_hint")}>
        {t("agent_mode.exit")}
      </Button>
    </header>
  );
}

