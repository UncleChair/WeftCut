// Transport-bar dropped-frame indicator — the NLE-standard "playback
// couldn't keep up" signal (Premiere's dropped-frame dot, Resolve's red
// fps readout). Lit while decode is actively behind; stays visible with
// the session count after recovery/pause (the count resets on the next
// play). Renders nothing when the session had no drops, so the transport
// bar stays clean in the common case.

import { useTranslation } from "react-i18next";

import {
  useUnderrunActive,
  useUnderrunDroppedFrames,
} from "../state/underrunStore";

export function DroppedFramesIndicator() {
  const { t } = useTranslation();
  const active = useUnderrunActive();
  const droppedFrames = useUnderrunDroppedFrames();
  if (droppedFrames === 0) return null;
  const label = t("transport.dropped_frames", { count: droppedFrames });
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
      {droppedFrames}
    </span>
  );
}
