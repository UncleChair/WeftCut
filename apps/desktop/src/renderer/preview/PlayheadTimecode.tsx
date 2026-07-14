import { useEffect, useRef } from "react";

import { formatTimecode } from "../frames";
import { playheadTimeUs, usePlayheadStore } from "../state/playheadStore";

/// Transport-bar timecode readout. Frame-rate text via a TRANSIENT
/// playhead-store subscription (tier 2, playheadStore.ts): the subscription
/// mutates the span's text node directly, so playback causes zero React
/// commits here. Click / Enter / Space hands off to the edit field.
export function PlayheadTimecode({
  fpsNum,
  fpsDen,
  editHint,
  onActivate,
}: {
  fpsNum: number;
  fpsDen: number;
  editHint: string;
  onActivate: () => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const apply = (tUs: number) => {
      if (ref.current) ref.current.textContent = formatTimecode(tUs, fpsNum, fpsDen);
    };
    apply(playheadTimeUs());
    return usePlayheadStore.subscribe((s) => apply(s.timeUs));
  }, [fpsNum, fpsDen]);
  return (
    <button
      type="button"
      ref={ref}
      className="preview-timecode"
      aria-live="polite"
      title={editHint}
      onClick={onActivate}
    >
      {formatTimecode(playheadTimeUs(), fpsNum, fpsDen)}
    </button>
  );
}
