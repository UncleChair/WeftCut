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

/// Agent mode — the simplified preview / mini-timeline / record-panel
/// layout the human sees while an MCP-initiated agent session is
/// active. Entered only via the `begin_agent_session` MCP tool (see
/// `agent_session.rs` in the Rust crate); exited via the persistent
/// "Exit to editor" button in the record-panel header.
///
/// Layout (Q10): preview top-left (expanding), mini timeline
/// bottom-left (fixed ~80 px), record panel right (fixed ~360 px).
/// Both the menu bar and editor-mode status bar are hidden — in
/// agent mode the record panel IS the surface for activity.
///
/// Phase split (see `MEMORY.md`):
///  - Phase 5 (this file): shell + Exit button + placeholders.
///  - Phase 6 will replace `<MiniTimelinePlaceholder>` with the real
///    scrub bar (ticks + project markers + timecode readout).
///  - Phase 7 will replace `<RecordPanelPlaceholder>` with the
///    filtered + op_id-grouped log stream + checkpoint rows + lock
///    badge.
interface AgentModeProps {
  session: AgentSession;
  summary: ProjectSummary | null;
  currentTimeUs: number;
  onTimeUpdate: (tUs: number) => void;
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
    currentTimeUs,
    onTimeUpdate,
    onPausedChange,
    onSeek,
    onExit,
  }: AgentModeProps,
  previewRef: ForwardedRef<PreviewSurfaceHandle>,
) {
  return (
    <div className="agent-mode-shell">
      <section className="agent-preview">
        <div id="video-surface" className="video-surface">
          <PreviewSurface
            ref={previewRef}
            hasContent={(summary?.layer_count ?? 0) > 0}
            onTimeUpdate={onTimeUpdate}
            onPausedChange={onPausedChange}
          />
        </div>
      </section>

      <section className="agent-mini-timeline">
        <MiniTimeline
          currentTimeUs={currentTimeUs}
          durationUs={summary?.duration_us ?? 0}
          markers={summary?.markers ?? []}
          onSeek={onSeek}
        />
      </section>

      <section className="agent-record">
        <RecordPanelHeader session={session} onExit={onExit} />
        <RecordPanelPlaceholder />
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
      <button
        className="agent-exit-button"
        onClick={onExit}
        title={t("agent_mode.exit_hint")}
      >
        {t("agent_mode.exit")}
      </button>
    </header>
  );
}

function RecordPanelPlaceholder() {
  const { t } = useTranslation();
  return (
    <div className="agent-record-body-stub">
      <p>{t("agent_mode.placeholder_body")}</p>
    </div>
  );
}
