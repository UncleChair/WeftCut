// The project-wide Role Mixer Panel and the single home for per-Role mute/solo.
// Boundary: it mixes the four canonical Audio Roles, never Tracks or per-Layer
// audio, and folds Role gain — no real per-Role buses or meters live here. The
// only meter is the real master RMS/Peak read off the shared store. The
// recorded-gain / unrecorded-mute-solo model is documented in `docs/audio.md`.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcwIcon } from "lucide-react";
import { AppNumberField } from "../components/AppNumberField";
import { AppSlider } from "../components/AppSlider";
import { tryMutate } from "../errors/tryMutate";
import {
  AUDIO_ROLES,
  setRoleGain,
  updateRoleFlags,
  type AudioRole,
  type RoleMixView,
} from "../ipc";
import { useAudioRoles } from "../state/projectStore";
import {
  SILENCE_DB,
  useMasterPeakDb,
  useMasterRmsDb,
} from "../state/masterMeterStore";
import {
  clearRoleGainOverride,
  setRoleGainOverride,
} from "../render/audio/roleGainOverrides";

// Role gain range and step mirror the per-layer GAIN_DB descriptor so the mixer
// and the inspector agree on the same scale. 0 dB is the neutral/unity value the
// reset action restores (roleGate treats an absent Role as 0 dB).
const GAIN_MIN_DB = -30;
const GAIN_MAX_DB = 20;
const GAIN_STEP_DB = 0.5;
const NEUTRAL_GAIN_DB = 0;

// At/above this content width the four Roles read as side-by-side channel strips;
// below it they stack as rows. ~90px per strip keeps every control legible.
const STRIP_LAYOUT_MIN_WIDTH = 360;

// Master meter fill scale: -60 dBFS is the visual floor (0% fill), 0 dBFS is
// full scale. (Silence is the store's `SILENCE_DB` sentinel, rendered "−∞".)
const METER_FLOOR_DB = -60;

type MixerLayout = "strips" | "rows";

/// One M/S toggle, styled to match the track header's flag buttons.
function MixerFlagButton({ active, activeClass, label, onToggle, children }: {
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

/// One Role channel: fader + numeric dB entry + mute/solo + reset. Owns a shared
/// gain draft so the fader and the number field track each other during an edit
/// (mirrors KeyframeField). Gain is recorded; mute/solo go through the
/// unrecorded `updateRoleFlags`.
function RoleChannel({ role, mix, onMutated }: {
  role: AudioRole;
  mix: RoleMixView;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const roleLabel = t(`audio_roles.${role}`);
  // null = idle (display the committed `mix.gain_db`, which tracks undo/redo); a
  // number while the fader is mid-drag. Both widgets read `value` and write the
  // draft, so a fader drag and the number field stay in sync. A non-null draft
  // is exactly "a fader audition is in flight".
  const [draft, setDraft] = useState<number | null>(null);
  const value = draft ?? mix.gain_db;
  // Set by Escape so the pointer-release `onValueCommitted` that still fires
  // after a cancel records nothing.
  const cancelledRef = useRef(false);

  useEffect(
    () => () => {
      clearRoleGainOverride(role);
    },
    [role],
  );

  // Live audition: the fader drives the draft (so the number field mirrors it)
  // and a renderer-local Role override the Compositor's audio pass folds in
  // place of the committed gain — audible immediately, recorded nowhere.
  const audition = (gainDb: number) => {
    cancelledRef.current = false;
    setDraft(gainDb);
    setRoleGainOverride(role, gainDb);
  };
  // Commit exactly one recorded Role gain and drop the override so the audio
  // pass returns to the committed value. Shared by fader release, number-field
  // blur/Enter, and reset.
  const commitGain = (gainDb: number) => {
    clearRoleGainOverride(role);
    setDraft(null);
    void tryMutate(
      () => setRoleGain(role, gainDb).then(onMutated),
      "Set role gain",
    );
  };
  // Escape: abandon the gesture. Clear the override (restores the original
  // sound), drop the draft (restores the displayed value), and arm the guard so
  // the release commits nothing.
  const cancelGesture = () => {
    if (draft === null) return;
    cancelledRef.current = true;
    clearRoleGainOverride(role);
    setDraft(null);
  };
  const flip = (patch: { muted?: boolean; solo?: boolean }) => () => {
    void tryMutate(
      () => updateRoleFlags(role, patch).then(onMutated),
      "Toggle role flag",
    );
  };

  return (
    <div
      className="mixer-channel"
      key={role}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || draft === null) return;
        // Keep the cancel local — don't let a global Escape handler also fire.
        e.stopPropagation();
        cancelGesture();
      }}
    >
      <span className="mixer-role-name">{roleLabel}</span>
      <AppSlider
        className="mixer-fader"
        value={value}
        min={GAIN_MIN_DB}
        max={GAIN_MAX_DB}
        step={GAIN_STEP_DB}
        ariaLabel={t("mixer.gain_fader", { role: roleLabel })}
        onValueChange={audition}
        onValueCommitted={(gainDb) => {
          if (cancelledRef.current) {
            cancelledRef.current = false;
            return;
          }
          commitGain(gainDb);
        }}
      />
      <AppNumberField
        className="mixer-gain-field"
        value={value}
        step={GAIN_STEP_DB}
        min={GAIN_MIN_DB}
        max={GAIN_MAX_DB}
        align="center"
        ariaLabel={t("mixer.gain_db", { role: roleLabel })}
        // No-op live change: Base UI self-buffers the typed text and commits on
        // blur/Enter. The fader drives `draft`, so this field still reflects a
        // drag live.
        onValueChange={() => {}}
        onCommit={commitGain}
      />
      <div className="mixer-channel-flags">
        <MixerFlagButton
          active={mix.muted}
          activeClass="bg-red-500/20 text-red-300"
          label={t("mixer.mute_hint")}
          onToggle={flip({ muted: !mix.muted })}
        >
          M
        </MixerFlagButton>
        <MixerFlagButton
          active={mix.solo}
          activeClass="bg-amber-500/25 text-amber-300"
          label={t("mixer.solo_hint")}
          onToggle={flip({ solo: !mix.solo })}
        >
          S
        </MixerFlagButton>
        <button
          type="button"
          title={t("mixer.reset_hint", { role: roleLabel })}
          aria-label={t("mixer.reset_hint", { role: roleLabel })}
          onClick={() => commitGain(NEUTRAL_GAIN_DB)}
          className="inline-flex size-[18px] items-center justify-center rounded-[4px] text-muted-foreground/60 transition-colors hover:bg-secondary hover:text-foreground"
        >
          <RotateCcwIcon size={11} />
        </button>
      </div>
    </div>
  );
}

/// One master-meter readout (RMS or Peak). Reads dBFS off the shared store and
/// renders a floor-clamped fill plus a numeric readout ("−∞" at silence).
function MeterBar({ label, db }: { label: string; db: number }) {
  const silent = db <= SILENCE_DB;
  const fill = silent
    ? 0
    : Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / (0 - METER_FLOOR_DB)));
  return (
    <div className="mixer-meter" aria-label={label}>
      <span className="mixer-meter-label">{label}</span>
      <div className="mixer-meter-track">
        <div className="mixer-meter-fill" style={{ width: `${fill * 100}%` }} />
      </div>
      <span className="mixer-meter-value">{silent ? "−∞" : db.toFixed(1)}</span>
    </div>
  );
}

/// The single real Master meter. Subscribes to the shared master RMS/Peak store
/// the preview audio graph publishes to, rather than polling the Compositor.
function MasterMeter() {
  const { t } = useTranslation();
  const rmsDb = useMasterRmsDb();
  const peakDb = useMasterPeakDb();
  return (
    <div className="mixer-master" role="group" aria-label={t("mixer.master_meter")}>
      <span className="mixer-master-label">{t("mixer.master")}</span>
      <div className="mixer-master-bars">
        <MeterBar label={t("mixer.rms")} db={rmsDb} />
        <MeterBar label={t("mixer.peak")} db={peakDb} />
      </div>
    </div>
  );
}

export interface RoleMixerPanelProps {
  onMutated: () => Promise<void>;
  visible?: boolean;
}

export function RoleMixerPanel({ onMutated, visible = true }: RoleMixerPanelProps) {
  const { t } = useTranslation();
  const roles = useAudioRoles();
  const byRole = new Map(roles.map((r) => [r.role, r]));

  // Measure our own content width to choose channel strips vs rows. No shared
  // ResizeObserver hook exists; inline the timeline's jsdom-guarded pattern (the
  // observer is absent under jsdom, so the synchronous initial measure carries
  // the tests).
  const rootRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      setWidth((prev) => (prev === w ? prev : w));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const layout: MixerLayout = width >= STRIP_LAYOUT_MIN_WIDTH ? "strips" : "rows";

  return (
    <section
      ref={rootRef}
      className={`mixer-panel mixer-panel--${layout}`}
      aria-label={t("mixer.title")}
    >
      <div className="mixer-roles">
        {AUDIO_ROLES.map((role: AudioRole) => {
          const mix = byRole.get(role) ?? { role, gain_db: 0, muted: false, solo: false };
          return <RoleChannel key={role} role={role} mix={mix} onMutated={onMutated} />;
        })}
      </div>
      {visible ? <MasterMeter /> : null}
    </section>
  );
}
