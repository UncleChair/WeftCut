import { useTranslation } from "react-i18next";
import { Eye, EyeOff, Lock, LockOpen } from "lucide-react";
import { updateTrackFlags, type TrackSummary } from "../ipc";

function FlagButton({ active, activeClass, label, onToggle, children }: {
  active: boolean;
  activeClass: string;
  label: string;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onToggle}
      className={`inline-flex size-[18px] items-center justify-center rounded-[4px] text-[9px] font-semibold transition-colors ${
        active ? activeClass : "text-muted-foreground/60 hover:bg-secondary hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

/// One sticky header cell per track row: name + the eye/M/S/lock flag
/// toggles. Flag changes go through the unrecorded `update_track_flags`
/// path (never enter undo history); `onMutated` re-fetches the summary.
/// pointerdown must not bubble into the timeline-root seek path.
export function TrackHeader({ track, height, isRevealed, isGroupStart, onMutated }: {
  track: TrackSummary;
  height: number;
  isRevealed: boolean;
  /// Mirrors the lane's section-divider border so it crosses the header column too.
  isGroupStart: boolean;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const kindLabel = t(`kinds.${track.kind.toLowerCase()}`, { defaultValue: track.kind });
  const toggle = (patch: Parameters<typeof updateTrackFlags>[1]) => async () => {
    try {
      await updateTrackFlags(track.id, patch);
      await onMutated();
    } catch (err) {
      console.error("update_track_flags failed:", err);
    }
  };
  return (
    <div
      className={`flex items-center gap-1 border-b border-border-soft px-1.5 ${isGroupStart ? "border-t border-t-border" : ""}`}
      style={{ height }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-muted-foreground">
        {track.label ?? kindLabel}
        {isRevealed && <span className="font-medium text-blue-400/70"> (revealed)</span>}
      </span>
      <FlagButton
        active={!track.enabled}
        activeClass="bg-secondary text-foreground"
        label={t("timeline.track_eye_hint", { defaultValue: "Hide this track's output (affects export)" })}
        onToggle={toggle({ enabled: !track.enabled })}
      >
        {track.enabled ? <Eye size={11} aria-hidden /> : <EyeOff size={11} aria-hidden />}
      </FlagButton>
      <FlagButton
        active={track.muted}
        activeClass="bg-red-500/20 text-red-300"
        label={t("timeline.track_mute_hint", { defaultValue: "Mute this track's audio (affects export)" })}
        onToggle={toggle({ muted: !track.muted })}
      >
        M
      </FlagButton>
      <FlagButton
        active={track.solo}
        activeClass="bg-amber-500/25 text-amber-300"
        label={t("timeline.track_solo_hint", { defaultValue: "Solo this track's audio (affects export)" })}
        onToggle={toggle({ solo: !track.solo })}
      >
        S
      </FlagButton>
      <FlagButton
        active={track.locked}
        activeClass="bg-secondary text-foreground"
        label={t("timeline.track_lock_hint", { defaultValue: "Lock this track against edits" })}
        onToggle={toggle({ locked: !track.locked })}
      >
        {track.locked ? <Lock size={11} aria-hidden /> : <LockOpen size={11} aria-hidden />}
      </FlagButton>
    </div>
  );
}
