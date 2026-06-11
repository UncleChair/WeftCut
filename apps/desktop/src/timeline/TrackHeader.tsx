import { useTranslation } from "react-i18next";
import type { TrackSummary } from "../ipc";

/// One sticky header cell per track row. Controls (eye/M/S/lock) land in
/// a later task; this version carries the name + revealed suffix that
/// used to float over the lane. pointerdown must not bubble into the
/// timeline-root seek path.
export function TrackHeader({ track, height, isRevealed }: {
  track: TrackSummary;
  height: number;
  isRevealed: boolean;
}) {
  const { t } = useTranslation();
  const kindLabel = t(`kinds.${track.kind.toLowerCase()}`, { defaultValue: track.kind });
  return (
    <div
      className="flex items-center gap-1.5 border-b border-border-soft px-2"
      style={{ height }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-muted-foreground">
        {track.label ?? kindLabel}
        {isRevealed && <span className="font-medium text-blue-400/70"> (revealed)</span>}
      </span>
    </div>
  );
}
