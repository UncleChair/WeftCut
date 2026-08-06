// Transport-bar underrun indicator — the NLE-standard "playback couldn't
// keep up" signal (Premiere's dropped-frame dot, Resolve's red fps
// readout). Lit while playback is actively behind; stays visible with the
// session counts after recovery/pause (they reset on the next play).
// Renders nothing when the session was clean, so the transport bar stays
// clean in the common case.
//
// Two counts, never merged into a total — see `render/underrunTracker.ts`
// for why the two causes stay apart.

import { useTranslation } from "react-i18next";

import {
  useUnderrunActive,
  useUnderrunDroppedFrames,
  useUnderrunLateFrames,
} from "../state/underrunStore";

export function DroppedFramesIndicator() {
  const { t } = useTranslation();
  const active = useUnderrunActive();
  const droppedFrames = useUnderrunDroppedFrames();
  const lateFrames = useUnderrunLateFrames();
  if (droppedFrames === 0 && lateFrames === 0) return null;
  const causes: string[] = [];
  if (droppedFrames > 0) {
    causes.push(t("transport.dropped_frames", { count: droppedFrames }));
  }
  if (lateFrames > 0) {
    causes.push(t("transport.late_frames", { count: lateFrames }));
  }
  const label = causes.join(" · ");
  const text =
    droppedFrames > 0 && lateFrames > 0
      ? `${droppedFrames}/${lateFrames}`
      : String(droppedFrames > 0 ? droppedFrames : lateFrames);
  return (
    <span
      className={
        active ? "dropped-frames-indicator is-active" : "dropped-frames-indicator"
      }
      role="status"
      title={label}
      aria-label={label}
    >
      <span className="dropped-frames-dot" aria-hidden />
      {text}
    </span>
  );
}
