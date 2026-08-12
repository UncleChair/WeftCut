import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { tryMutate } from "../errors/tryMutate";
import { ChevronDown, ChevronRight, Eye, EyeOff, Lock, LockOpen, Music } from "lucide-react";
import { renameTrack, updateTrackFlags, type TrackSummary } from "../ipc";
import { AppInput } from "../components/AppInput";
import { trackDisplayName } from "../lib/trackName";
import { useProjectStore } from "../state/projectStore";
import { trackHeaderControls } from "./geometry";
import { beginTrackRename, endRename, useEditingTrackId } from "./renameStore";
import { TrackContextMenu } from "./TrackContextMenu";

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

/// One sticky header cell per track row: name + the eye/lock flag
/// toggles. Flag changes go through the unrecorded `update_track_flags`
/// path (never enter undo history) while the name goes through the RECORDED
/// `rename_track`, so one undo can revert a name without touching a control the
/// editor set (ADR 0042); `onMutated` re-fetches the summary.
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
  // The name a lane's positional number counts against is its slot in the
  // PROJECT's track vector, read from the mirror rather than from the rows this
  // header renders beside: the timeline's row list is filtered in A/B mode, so
  // numbering off it would renumber every lane when the user toggles the filter.
  // Atomic selector — `tracks` is one field of one snapshot.
  const tracks = useProjectStore((s) => s.summary?.tracks);
  const name = trackDisplayName(track, tracks ?? [], t);
  const toggle = (patch: Parameters<typeof updateTrackFlags>[1]) => async () => {
    if (await tryMutate(() => updateTrackFlags(track.id, patch), "Update track flag")) {
      await onMutated();
    }
  };
  const controls = trackHeaderControls(track);
  // Pure-audio lane = has audio, no visual (eye hidden). Show a music
  // glyph so the lane reads as audio at a glance.
  const isAudioLane = controls.hasAudio && !controls.showEye;

  const isEditing = useEditingTrackId() === track.id;
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!isEditing) return;
    setDraft(track.label ?? "");
    // preventScroll: the header column sits inside the timeline's scroll
    // container, so a plain focus() would scroll this row into view and jolt
    // the timeline out from under the pointer.
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, [isEditing, track.id, track.label]);

  // Close the menu when the timeline scrolls under it — same reason the layer
  // menu does it: the popup is anchored to fixed cursor coordinates.
  useEffect(() => {
    if (menu === null) return;
    const onScroll = () => setMenu(null);
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [menu]);

  const commitRename = () => {
    const next = draft.trim();
    endRename();
    if (next === (track.label ?? "")) return;
    // A cleared field commits `null`, which restores the DERIVED name — the
    // deliberate difference from the layer rename, where an empty value
    // abandons the edit instead. A lane's derived name is a meaningful default
    // the editor needs a route back to, and a layer has no equivalent
    // (ADR 0042). Do not "fix" the inconsistency.
    void (async () => {
      if (await tryMutate(() => renameTrack(track.id, next === "" ? null : next), "Rename track")) {
        await onMutated();
      }
    })();
  };
  return (
    <div
      className={`flex items-center gap-1 border-b border-border-soft px-1.5 ${isGroupStart ? "border-t border-t-border" : ""}`}
      style={{ height }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <button
        type="button"
        data-testid="kf-lane-twirl"
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
      {isEditing ? (
        <AppInput
          ref={inputRef}
          className="min-w-0 flex-1"
          value={draft}
          ariaLabel={t("timeline.rename_track_label", { label: name, defaultValue: "Rename {{label}}" })}
          onValueChange={setDraft}
          onBlur={commitRename}
          onKeyDown={(e) => {
            // The header's own handlers stop clicks from reaching the timeline
            // root; keystrokes need the same, or typing drives the shortcuts.
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              endRename();
            }
          }}
        />
      ) : (
        <span
          data-testid="track-header-name"
          className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-muted-foreground"
          title={name}
          onDoubleClick={() => beginTrackRename(track.id)}
        >
          {name}
          {isRevealed && <span className="font-medium text-blue-400/70"> (revealed)</span>}
        </span>
      )}
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
      {/* Mute / Solo belong to audio roles in the Role Mixer. The track header
          carries visibility and lock; per-role M/S use `update_role_flags`. */}
      <FlagButton
        active={track.locked}
        activeClass="bg-secondary text-foreground"
        label={t("timeline.track_lock_hint", { defaultValue: "Lock this track against edits" })}
        onToggle={toggle({ locked: !track.locked })}
      >
        {track.locked ? <Lock size={11} aria-hidden /> : <LockOpen size={11} aria-hidden />}
      </FlagButton>
      {menu && (
        <TrackContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onRename={() => {
            setMenu(null);
            beginTrackRename(track.id);
          }}
        />
      )}
    </div>
  );
}
