// Project-level role mixer (`docs/audio.md`). One row per canonical audio
// role: a gain field (typed entry via AppNumberField — typing + arrow keys +
// hover steppers) plus Mute / Solo toggles — this panel is the single home for
// per-role M/S. Gain edits via `setRoleGain` are RECORDED (undoable) — a
// debounced commit can produce one undo entry per pause; mute/solo via
// `updateRoleFlags` are UNRECORDED (never enter undo history). `onMutated`
// re-fetches the project summary.

import { useTranslation } from "react-i18next";
import { AppNumberField } from "../components/AppNumberField";
import { AUDIO_ROLES, setRoleGain, updateRoleFlags, type AudioRole } from "../ipc";
import { useAudioRoles } from "../state/projectStore";

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

export function MixerPanel({ onMutated }: { onMutated: () => Promise<void> }) {
  const { t } = useTranslation();
  const roles = useAudioRoles();
  const byRole = new Map(roles.map((r) => [r.role, r]));

  const flip = (
    role: AudioRole,
    patch: { muted?: boolean; solo?: boolean },
  ) => () => {
    updateRoleFlags(role, patch)
      .then(onMutated)
      .catch((e) => console.warn("update_role_flags failed:", e));
  };

  return (
    <section className="mixer-panel" aria-label={t("mixer.title")}>
      <h3>{t("mixer.title")}</h3>
      {AUDIO_ROLES.map((role: AudioRole) => {
        const r = byRole.get(role) ?? { role, gain_db: 0, muted: false, solo: false };
        const roleLabel = t(`audio_roles.${role}`);
        return (
          <div className="mixer-row prop-field" key={role}>
            <span className="prop-field-label mixer-role-name">{roleLabel}</span>
            <div className="mixer-row-controls">
              <AppNumberField
                value={r.gain_db}
                step={0.5}
                min={-30}
                max={20}
                ariaLabel={t("mixer.gain_db", { role: roleLabel })}
                onValueChange={() => {}}
                onCommit={(v) =>
                  setRoleGain(role, v)
                    .then(onMutated)
                    .catch((e) => console.warn("set_role_gain failed:", e))
                }
              />
              <MixerFlagButton
                active={r.muted}
                activeClass="bg-red-500/20 text-red-300"
                label={t("mixer.mute_hint")}
                onToggle={flip(role, { muted: !r.muted })}
              >
                M
              </MixerFlagButton>
              <MixerFlagButton
                active={r.solo}
                activeClass="bg-amber-500/25 text-amber-300"
                label={t("mixer.solo_hint")}
                onToggle={flip(role, { solo: !r.solo })}
              >
                S
              </MixerFlagButton>
            </div>
          </div>
        );
      })}
    </section>
  );
}
