import { useTranslation } from "react-i18next";
import {
  forwardRef,
  useState,
  type CSSProperties,
  type ForwardedRef,
  type KeyboardEvent,
  type PointerEvent,
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
import { AgentPanel } from "./AgentPanel";
import { setPlayheadTimeUs } from "../state/playheadStore";
import { Button } from "@/components/ui/button";
import { WindowControls } from "../components/WindowControls";

/// Agent mode — the simplified preview / mini-timeline / record-panel
/// layout the human sees while an agent session is active. Entered via
/// the `begin_agent_session` MCP tool or locally via the View menu /
/// command palette (`agent_session_begin` channel); exited via the
/// persistent "Exit to editor" button in the titlebar's top-right.
///
/// Layout: preview top-left, mini timeline bottom-left, agent panel right
/// (resizable via the sash in the column gap) — grid metrics live in
/// styles/agent.css. The right pane is the shared AgentPanel component, the
/// same surface the editor dock's "Agent" panel renders. See docs/mcp.md.
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

/// Record-panel width bounds (px).
const RECORD_WIDTH_DEFAULT = 360;
const RECORD_WIDTH_MIN = 280;
const RECORD_WIDTH_MAX = 720;

function clampRecordWidth(width: number, viewportWidth: number): number {
  // Keep at least 480 px for the preview column so the video never
  // collapses to a sliver on narrow windows.
  const max = Math.max(
    RECORD_WIDTH_MIN,
    Math.min(RECORD_WIDTH_MAX, viewportWidth - 480),
  );
  return Math.round(Math.min(max, Math.max(RECORD_WIDTH_MIN, width)));
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
  const { t } = useTranslation();
  const [recordWidth, setRecordWidth] = useState(RECORD_WIDTH_DEFAULT);

  /* Width sash between the left column and the record panel — the only
     resizable seam in agent mode. Pointer capture keeps the drag alive
     off-sash; the width is measured from the drag start so the first move
     doesn't jump to the cursor. */
  const onSashPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const sash = event.currentTarget;
    sash.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = recordWidth;
    const onMove = (move: globalThis.PointerEvent) => {
      setRecordWidth(
        clampRecordWidth(
          startWidth + (startX - move.clientX),
          window.innerWidth,
        ),
      );
    };
    const onEnd = () => {
      sash.removeEventListener("pointermove", onMove);
      sash.removeEventListener("pointerup", onEnd);
      sash.removeEventListener("pointercancel", onEnd);
    };
    sash.addEventListener("pointermove", onMove);
    sash.addEventListener("pointerup", onEnd);
    sash.addEventListener("pointercancel", onEnd);
  };

  const onSashKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") {
      setRecordWidth((w) => clampRecordWidth(w + step, window.innerWidth));
    } else if (event.key === "ArrowRight") {
      setRecordWidth((w) => clampRecordWidth(w - step, window.innerWidth));
    } else {
      return;
    }
    event.preventDefault();
  };

  return (
    <div
      className="agent-mode-shell"
      style={{ "--agent-record-width": `${recordWidth}px` } as CSSProperties}
    >
      {/* Frameless window: agent mode replaces the whole app layout, so
          it carries its own slim drag strip + caption buttons. The exit
          button lives here too — top-right, ahead of the caption
          buttons. */}
      <div className="agent-titlebar" data-drag-region>
        <Button
          className="agent-exit-button"
          onClick={onExit}
          title={t("agent_mode.exit_hint")}
        >
          {t("agent_mode.exit")}
        </Button>
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
        <AgentPanel
          session={session}
          sessionStartedAt={session.started_at}
          lockReason={summary?.history.lock_reason ?? null}
        />
      </section>

      {/* The single resizable seam: record-panel width only. */}
      <div
        className="agent-width-sash"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("agent_mode.resize_record_panel")}
        aria-valuenow={recordWidth}
        aria-valuemin={RECORD_WIDTH_MIN}
        aria-valuemax={RECORD_WIDTH_MAX}
        tabIndex={0}
        onPointerDown={onSashPointerDown}
        onKeyDown={onSashKeyDown}
      />
    </div>
  );
});

