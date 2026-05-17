/// Group-level effects editor. Renders inside `PropertyPanel` when the
/// primary-selected layer is a member of some group.
///
/// 2026-05-17 redesign scope: only the group's `HtmlTransform` effect
/// is editable here. v1 supports exactly one HtmlTransform per group;
/// adding it flips the group to html-cap rendering for preview +
/// export. Per-layer effects, per-effect time windows (export-planner
/// segment stitching), additional html-class effect kinds — all later
/// work.
///
/// Authoring model:
///   - "Add zoom animation" preset bootstraps an HtmlTransform with
///     scale_x/scale_y keyframes (1.0 → 1.3 over 0–5s) and identity
///     tracks for everything else. One click to see something move.
///   - Each track has a Static / Keyframed toggle. Static = one
///     number input; Keyframed = a list of (time, value, interp) rows
///     with add/remove.
///   - All edits debounce 250ms before committing via
///     `groupsSetHtmlTransform` so dragging a number field doesn't
///     flood the actor.
///   - The Remove button calls `groupsClearHtmlTransform`, dropping
///     the effect from the chain and reverting the group to ffmpeg
///     rendering.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  groupsClearHtmlTransform,
  groupsSetHtmlTransform,
  type AnimTrack,
  type EffectParams,
  type GroupSummary,
  type Interpolation,
  type Keyframe,
  type LayerSummary,
} from "../ipc";

const COMMIT_DEBOUNCE_MS = 250;

interface Props {
  layer: LayerSummary;
  groups: GroupSummary[];
  onMutated: () => Promise<void>;
}

interface TransformState {
  x: AnimTrack<number>;
  y: AnimTrack<number>;
  scaleX: AnimTrack<number>;
  scaleY: AnimTrack<number>;
  rotationDeg: AnimTrack<number>;
  opacity: AnimTrack<number>;
}

const IDENTITY: TransformState = {
  x: { mode: "Static", value: 0 },
  y: { mode: "Static", value: 0 },
  scaleX: { mode: "Static", value: 1 },
  scaleY: { mode: "Static", value: 1 },
  rotationDeg: { mode: "Static", value: 0 },
  opacity: { mode: "Static", value: 1 },
};

/// Each field's identity default, used when the user toggles Static →
/// Keyframed (the new track keeps a single keyframe at t=0 with the
/// identity value).
const IDENTITY_VALUE: Record<keyof TransformState, number> = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  opacity: 1,
};

export function GroupEffectsSection({ layer, groups, onMutated }: Props) {
  const { t } = useTranslation();
  const group = useMemo(
    () => groups.find((g) => g.layer_ids.includes(layer.id)),
    [groups, layer.id],
  );
  if (!group) return null;

  return (
    <section className="prop-section group-effects-section">
      <h3>
        {t("group_effects.heading", { defaultValue: "Group effects" })}
        <span className="group-effects-subhead">
          {" "}
          ({group.label ?? `group ${group.id.slice(0, 6)}`})
        </span>
      </h3>
      <HtmlTransformEditor group={group} onMutated={onMutated} />
    </section>
  );
}

function HtmlTransformEditor({
  group,
  onMutated,
}: {
  group: GroupSummary;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const existing = useMemo<EffectParams | null>(() => {
    for (const e of group.effects) {
      if (e.enabled && e.params.kind === "HtmlTransform") return e.params;
    }
    return null;
  }, [group.effects]);

  const [state, setState] = useState<TransformState>(() =>
    existing && existing.kind === "HtmlTransform"
      ? toState(existing)
      : IDENTITY,
  );
  // External-change reset: if the project re-fetches and the group's
  // HtmlTransform changes shape underneath us, sync without dropping
  // user edits in flight. We compare against `existing` identity, not
  // a deep-equal, because the debounced commit just round-tripped it
  // and we'd otherwise loop.
  const lastAppliedSigRef = useRef<string>(stateSig(state));
  useEffect(() => {
    const incomingState =
      existing && existing.kind === "HtmlTransform"
        ? toState(existing)
        : IDENTITY;
    const sig = stateSig(incomingState);
    if (sig !== lastAppliedSigRef.current) {
      lastAppliedSigRef.current = sig;
      setState(incomingState);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id, existing]);

  // Debounced commit pump.
  const pendingRef = useRef<TransformState | null>(null);
  const timerRef = useRef<number | null>(null);
  const commit = useCallback(
    (next: TransformState) => {
      pendingRef.current = next;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const payload = pendingRef.current;
        pendingRef.current = null;
        if (!payload) return;
        const sig = stateSig(payload);
        lastAppliedSigRef.current = sig;
        void (async () => {
          try {
            await groupsSetHtmlTransform({
              groupId: group.id,
              x: payload.x,
              y: payload.y,
              scaleX: payload.scaleX,
              scaleY: payload.scaleY,
              rotationDeg: payload.rotationDeg,
              opacity: payload.opacity,
            });
            await onMutated();
          } catch (e) {
            console.warn("groups_set_html_transform failed:", e);
          }
        })();
      }, COMMIT_DEBOUNCE_MS);
    },
    [group.id, onMutated],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const update = (next: TransformState) => {
    setState(next);
    commit(next);
  };

  const onAddZoomPreset = async () => {
    const kfs5sZoom: AnimTrack<number> = {
      mode: "Keyframed",
      value: [
        kf(0, 1.0),
        kf(5_000_000, 1.3),
      ],
    };
    const next: TransformState = {
      ...IDENTITY,
      scaleX: kfs5sZoom,
      scaleY: kfs5sZoom,
    };
    setState(next);
    lastAppliedSigRef.current = stateSig(next);
    try {
      await groupsSetHtmlTransform({
        groupId: group.id,
        x: next.x,
        y: next.y,
        scaleX: next.scaleX,
        scaleY: next.scaleY,
        rotationDeg: next.rotationDeg,
        opacity: next.opacity,
      });
      await onMutated();
    } catch (e) {
      console.warn("add zoom preset failed:", e);
    }
  };

  const onRemove = async () => {
    try {
      await groupsClearHtmlTransform(group.id);
      await onMutated();
    } catch (e) {
      console.warn("groups_clear_html_transform failed:", e);
    }
  };

  if (!existing) {
    return (
      <div className="html-transform-empty">
        <p className="placeholder">
          {t("group_effects.html_transform_empty", {
            defaultValue:
              "No HtmlTransform on this group. Adding one flips the group to html-cap rendering — preview and export both honor CSS keyframes on the composition.",
          })}
        </p>
        <button
          type="button"
          className="button-primary"
          onClick={() => void onAddZoomPreset()}
        >
          {t("group_effects.add_zoom_preset", {
            defaultValue: "+ Add 5s zoom (1.0 → 1.3)",
          })}
        </button>
      </div>
    );
  }

  const fields: Array<[keyof TransformState, string]> = [
    ["x", t("group_effects.field_x", { defaultValue: "x (px)" })],
    ["y", t("group_effects.field_y", { defaultValue: "y (px)" })],
    ["scaleX", t("group_effects.field_scale_x", { defaultValue: "scale x" })],
    ["scaleY", t("group_effects.field_scale_y", { defaultValue: "scale y" })],
    ["rotationDeg", t("group_effects.field_rotation_deg", { defaultValue: "rotation (deg)" })],
    ["opacity", t("group_effects.field_opacity", { defaultValue: "opacity" })],
  ];

  return (
    <div className="html-transform-editor">
      <div className="html-transform-header">
        <span className="effect-name">HtmlTransform</span>
        <button
          type="button"
          className="button-secondary"
          onClick={() => void onRemove()}
        >
          {t("group_effects.remove", { defaultValue: "Remove" })}
        </button>
      </div>
      {fields.map(([field, label]) => (
        <FieldEditor
          key={field}
          label={label}
          identityValue={IDENTITY_VALUE[field]}
          track={state[field]}
          onChange={(track) => update({ ...state, [field]: track })}
        />
      ))}
      <p className="html-transform-hint">
        {t("group_effects.html_transform_hint", {
          defaultValue:
            "Times are group-local (0 = group's earliest member t_start). First and last keyframes implicitly mark the html-cap window; outside the window the field returns to identity. Add a closing keyframe at the identity value if you want a smooth handoff to ffmpeg.",
        })}
      </p>
    </div>
  );
}

function FieldEditor({
  label,
  identityValue,
  track,
  onChange,
}: {
  label: string;
  identityValue: number;
  track: AnimTrack<number>;
  onChange: (next: AnimTrack<number>) => void;
}) {
  const { t } = useTranslation();
  const isStatic = track.mode === "Static";

  const onToggleMode = () => {
    if (isStatic) {
      // Static → Keyframed: seed with a single keyframe at t=0 carrying
      // the current static value (so the visible value doesn't jump).
      const v = (track.value as number) ?? identityValue;
      onChange({
        mode: "Keyframed",
        value: [kf(0, v)],
      });
    } else {
      // Keyframed → Static: collapse to the first keyframe's value.
      const kfs = track.value as Keyframe<number>[];
      const v = kfs[0]?.value ?? identityValue;
      onChange({ mode: "Static", value: v });
    }
  };

  return (
    <div className="field-editor">
      <div className="field-header">
        <span className="field-label">{label}</span>
        <button
          type="button"
          className="mode-toggle"
          onClick={onToggleMode}
          title={t("group_effects.mode_toggle_hint", {
            defaultValue: "Toggle between a static value and keyframed animation",
          })}
        >
          {isStatic
            ? t("group_effects.mode_static", { defaultValue: "static" })
            : t("group_effects.mode_keyframed", { defaultValue: "keyframed" })}
        </button>
      </div>
      {track.mode === "Static" ? (
        <input
          type="number"
          className="field-value"
          step={0.05}
          value={track.value}
          onChange={(e) =>
            onChange({
              mode: "Static",
              value: parseNumber(e.target.value, identityValue),
            })
          }
        />
      ) : (
        <KeyframeList
          kfs={track.value}
          onChange={(kfs) => onChange({ mode: "Keyframed", value: kfs })}
          identityValue={identityValue}
        />
      )}
    </div>
  );
}

function KeyframeList({
  kfs,
  onChange,
  identityValue,
}: {
  kfs: Keyframe<number>[];
  onChange: (next: Keyframe<number>[]) => void;
  identityValue: number;
}) {
  const { t } = useTranslation();

  const onAddRow = () => {
    const lastT = kfs.length > 0 ? kfs[kfs.length - 1]!.t_us : -1_000_000;
    onChange([
      ...kfs,
      kf(lastT + 1_000_000, identityValue),
    ]);
  };

  const onPatchRow = (idx: number, patch: Partial<Keyframe<number>>) => {
    const next = kfs.map((k, i) => (i === idx ? { ...k, ...patch } : k));
    // Re-sort by t_us so the engine's lerp is always monotonic.
    next.sort((a, b) => a.t_us - b.t_us);
    onChange(next);
  };

  const onRemoveRow = (idx: number) => {
    onChange(kfs.filter((_, i) => i !== idx));
  };

  return (
    <div className="keyframe-list">
      {kfs.length === 0 ? (
        <p className="placeholder">
          {t("group_effects.no_keyframes", {
            defaultValue:
              "No keyframes yet. Add at least two keyframes at different times to create an animation; one keyframe acts as a static value at that time.",
          })}
        </p>
      ) : (
        <ul>
          <li className="keyframe-list-header">
            <span>{t("group_effects.kf_time", { defaultValue: "time (s)" })}</span>
            <span>{t("group_effects.kf_value", { defaultValue: "value" })}</span>
            <span>{t("group_effects.kf_interp", { defaultValue: "interp" })}</span>
            <span />
          </li>
          {kfs.map((k, i) => (
            <li key={k.id} className="keyframe-row">
              <input
                type="number"
                step={0.1}
                value={(k.t_us / 1_000_000).toFixed(3)}
                onChange={(e) =>
                  onPatchRow(i, {
                    t_us: Math.round(parseNumber(e.target.value, 0) * 1_000_000),
                  })
                }
              />
              <input
                type="number"
                step={0.05}
                value={k.value}
                onChange={(e) =>
                  onPatchRow(i, {
                    value: parseNumber(e.target.value, identityValue),
                  })
                }
              />
              <select
                value={k.interp.kind}
                onChange={(e) =>
                  onPatchRow(i, {
                    interp: { kind: e.target.value as Interpolation["kind"] } as Interpolation,
                  })
                }
              >
                <option value="Linear">Linear</option>
                <option value="EaseIn">EaseIn</option>
                <option value="EaseOut">EaseOut</option>
                <option value="Hold">Hold</option>
              </select>
              <button
                type="button"
                className="kf-remove"
                onClick={() => onRemoveRow(i)}
                title={t("group_effects.remove_kf", { defaultValue: "Remove keyframe" })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="button-secondary kf-add"
        onClick={onAddRow}
      >
        {t("group_effects.add_kf", { defaultValue: "+ Add keyframe" })}
      </button>
    </div>
  );
}

// ---- helpers ----------------------------------------------------------

function kf(t_us: number, value: number): Keyframe<number> {
  return {
    id: crypto.randomUUID(),
    t_us,
    value,
    interp: { kind: "Linear" },
  };
}

function parseNumber(raw: string, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function toState(params: EffectParams & { kind: "HtmlTransform" }): TransformState {
  return {
    x: params.x,
    y: params.y,
    scaleX: params.scale_x,
    scaleY: params.scale_y,
    rotationDeg: params.rotation_deg,
    opacity: params.opacity,
  };
}

function stateSig(s: TransformState): string {
  return JSON.stringify(s);
}
