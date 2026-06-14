import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Eye, EyeOff, Lock, LockOpen, Music } from "lucide-react";
import { updateTrackFlags, type TrackSummary } from "../ipc";
import { trackHeaderControls } from "./geometry";

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
/// pointerdown must not bubble into the timeline root's seek path.
export function TrackHeader({ track, height, isRevealed, isGroupStart, isExpanded, hasKeyframes, onToggleExpand, onMutated }: {
  track: TrackSummary;
  height: number;
  isRevealed: boolean;
  /// Mirrors the lane's section-divider border so it crosses the header column too.
  isGroupStart: boolean;
  /// True when this track's keyframe sub-lanes are expanded (twirl points down).
  isExpanded: boolean;
  /// True when at least one layer on the track has a keyframed property —
  /// the twirl is disabled (grayed) otherwise.
  hasKeyframes: boolean;
  onToggleExpand: () => void;
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
  const controls = trackHeaderControls(track);
  // Pure-audio lane = has audio, no visual (eye hidden). Show a music
  // glyph so the lane reads as audio at a glance.
  const isAudioLane = controls.showMute && !controls.showEye;
  return (
    <div
      className={`flex items-center gap-1 border-b border-border-soft px-1.5 ${isGroupStart ? "border-t border-t-border" : ""}`}
      style={{ height }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="inline-flex size-[14px] shrink-0 items-center justify-center text-muted-foreground/60 disabled:opacity-30"
        disabled={!hasKeyframes}
        aria-label={t("timeline.toggle_keyframe_lanes", { defaultValue: "Expand keyframe lanes" })}
        aria-expanded={isExpanded}
        onClick={onToggleExpand}
      >
        {isExpanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
      </button>
      {isAudioLane && (
        <Music size={11} aria-hidden className="shrink-0 text-muted-foreground/70" />
      )}
      <span
        className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-muted-foreground"
        title={track.label ?? kindLabel}
      >
        {track.label ?? kindLabel}
        {isRevealed && <span className="font-medium text-blue-400/70"> (revealed)</span>}
      </span>
      {controls.showEye && (
        <FlagButton
          active={!track.enabled}
          activeClass="bg-secondary text-foreground"
          label={t("timeline.track_eye_hint", { defaultValue: "Hide this track's output (affects export)" })}
          onToggle={toggle({ enabled: !track.enabled })}
        >
          {track.enabled ? <Eye size={11} aria-hidden /> : <EyeOff size={11} aria-hidden />}
        </FlagButton>
      )}
      {controls.showMute && (
        <FlagButton
          active={track.muted}
          activeClass="bg-red-500/20 text-red-300"
          label={t("timeline.track_mute_hint", { defaultValue: "Mute this track's audio (affects export)" })}
          onToggle={toggle({ muted: !track.muted })}
        >
          M
        </FlagButton>
      )}
      {controls.showSolo && (
        <FlagButton
          active={track.solo}
          activeClass="bg-amber-500/25 text-amber-300"
          label={t("timeline.track_solo_hint", { defaultValue: "Solo this track's audio (affects export)" })}
          onToggle={toggle({ solo: !track.solo })}
        >
          S
        </FlagButton>
      )}
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
