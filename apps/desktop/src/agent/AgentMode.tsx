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
        <MiniTimelinePlaceholder
          currentTimeUs={currentTimeUs}
          durationUs={summary?.duration_us ?? 0}
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

function MiniTimelinePlaceholder({
  currentTimeUs,
  durationUs,
}: {
  currentTimeUs: number;
  durationUs: number;
}) {
  // Phase 6 replaces this with the real scrub bar. For now we show
  // the timecode + a flat progress strip so the shell isn't blank.
  const ratio = durationUs > 0 ? currentTimeUs / durationUs : 0;
  return (
    <div className="mini-timeline-stub" aria-hidden="true">
      <div className="mini-timeline-strip">
        <div
          className="mini-timeline-progress"
          style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }}
        />
      </div>
      <div className="mini-timeline-tc">
        {formatTimecode(currentTimeUs)} / {formatTimecode(durationUs)}
      </div>
    </div>
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

function formatTimecode(us: number): string {
  const totalMs = Math.max(0, Math.floor(us / 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n: number, w: number) => n.toString().padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}
