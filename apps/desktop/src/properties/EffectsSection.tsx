/// Generic effects-chain editor. Renders inside `PropertyPanel` for
/// per-layer effect chains and (when the primary-selected layer is
/// inside a group) for the group's chain too. The parent owns the
/// "where this commits" decision via the `onCommit` prop — the
/// section itself is owner-agnostic.
///
/// 2026-05-17 redesign — effects model A/B/C/D: effect chains live
/// on both layers and groups; generic chain-replace ops
/// (`layersSetEffects` / `groupsSetEffects`); engine + distiller
/// compose per-layer HtmlTransform; LiveLayers' html-cap detection
/// widens to member-layer effects.
///
/// **Per-kind authoring UI is filled in progressively.** Today only
/// `HtmlTransform` has a full param editor. The other kinds
/// (Blur / ColorCorrect / ChromaKey / Speed / Vignette) can still be
/// added to the chain via the add-dropdown — each card just shows a
/// "params editor coming in a future release" placeholder until the
/// real param surfaces land. This lets the chain shape and ordering
/// be tested end-to-end before any one kind is feature-complete.
///
/// Edits debounce 250 ms before invoking `onCommit(chain)`. The
/// parent decides whether that's `layersSetEffects(layerId, chain)`
/// or `groupsSetEffects(groupId, chain)`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  AnimTrack,
  Effect,
  EffectParams,
  Interpolation,
  Keyframe,
} from "../ipc";

const COMMIT_DEBOUNCE_MS = 250;

/// All kinds the add-dropdown can produce. Order = display order.
const KINDS = [
  "HtmlTransform",
  "Blur",
  "ColorCorrect",
  "ChromaKey",
  "Speed",
  "Vignette",
] as const;
type EffectKind = (typeof KINDS)[number];

interface Props {
  heading: string;
  chain: Effect[];
  onCommit: (chain: Effect[]) => Promise<void>;
}

export function EffectsSection({ heading, chain, onCommit }: Props) {
  const { t } = useTranslation();

  const [state, setState] = useState<Effect[]>(chain);
  const lastAppliedSigRef = useRef<string>(JSON.stringify(chain));

  // External sync: when the project re-fetches and the chain
  // diverges from what we last sent, reset. JSON-sig compare avoids
  // a feedback loop with our own debounced commits.
  useEffect(() => {
    const sig = JSON.stringify(chain);
    if (sig !== lastAppliedSigRef.current) {
      lastAppliedSigRef.current = sig;
      setState(chain);
    }
  }, [chain]);

  // Debounced commit pump.
  const pendingRef = useRef<Effect[] | null>(null);
  const timerRef = useRef<number | null>(null);
  const commit = useCallback(
    (next: Effect[]) => {
      pendingRef.current = next;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const payload = pendingRef.current;
        pendingRef.current = null;
        if (!payload) return;
        lastAppliedSigRef.current = JSON.stringify(payload);
        void onCommit(payload).catch((e) =>
          console.warn("effects commit failed:", e),
        );
      }, COMMIT_DEBOUNCE_MS);
    },
    [onCommit],
  );
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const update = useCallback(
    (next: Effect[]) => {
      setState(next);
      commit(next);
    },
    [commit],
  );

  const onAdd = (kind: EffectKind) => {
    update([...state, defaultEffect(kind)]);
  };

  const onPatchEffect = (idx: number, patch: Partial<Effect>) => {
    update(state.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  };

  const onPatchParams = (idx: number, params: EffectParams) => {
    onPatchEffect(idx, { params });
  };

  const onRemove = (idx: number) => {
    update(state.filter((_, i) => i !== idx));
  };

  return (
    <section className="prop-section effects-section">
      <h3>{heading}</h3>
      {state.length === 0 ? (
        <p className="placeholder">
          {t("effects_section.empty", {
            defaultValue: "No effects. Use the + Add menu below.",
          })}
        </p>
      ) : (
        <ul className="effects-list">
          {state.map((effect, idx) => (
            <li key={effect.id} className="effect-card">
              <div className="effect-card-header">
                <label className="effect-enable">
                  <input
                    type="checkbox"
                    checked={effect.enabled}
                    onChange={(e) =>
                      onPatchEffect(idx, { enabled: e.target.checked })
                    }
                  />
                </label>
                <span className="effect-name">{effect.params.kind}</span>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => onRemove(idx)}
                >
                  {t("effects_section.remove", { defaultValue: "Remove" })}
                </button>
              </div>
              <EffectBody
                effect={effect}
                onParamsChange={(p) => onPatchParams(idx, p)}
              />
            </li>
          ))}
        </ul>
      )}
      <AddEffectMenu onAdd={onAdd} />
    </section>
  );
}

// ===== add menu =====

function AddEffectMenu({ onAdd }: { onAdd: (kind: EffectKind) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="add-effect">
      <button
        type="button"
        className="button-primary"
        onClick={() => setOpen((v) => !v)}
      >
        + {t("effects_section.add", { defaultValue: "Add effect" })}
      </button>
      {open && (
        <ul className="add-effect-menu">
          {KINDS.map((kind) => (
            <li key={kind}>
              <button
                type="button"
                onClick={() => {
                  onAdd(kind);
                  setOpen(false);
                }}
              >
                {kind}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ===== per-effect body dispatch =====

function EffectBody({
  effect,
  onParamsChange,
}: {
  effect: Effect;
  onParamsChange: (params: EffectParams) => void;
}) {
  const { t } = useTranslation();
  if (effect.params.kind === "HtmlTransform") {
    return (
      <HtmlTransformEditor
        params={effect.params as EffectParams & { kind: "HtmlTransform" }}
        onChange={onParamsChange}
      />
    );
  }
  return (
    <p className="placeholder">
      {t("effects_section.placeholder_body", {
        kind: effect.params.kind,
        defaultValue:
          "{{kind}} — params editor coming in a future release. The effect is in the chain but has no UI controls yet.",
      })}
    </p>
  );
}

// ===== HtmlTransform editor =====

interface TransformState {
  x: AnimTrack<number>;
  y: AnimTrack<number>;
  scaleX: AnimTrack<number>;
  scaleY: AnimTrack<number>;
  rotationDeg: AnimTrack<number>;
  opacity: AnimTrack<number>;
}

const IDENTITY_VALUE: Record<keyof TransformState, number> = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  opacity: 1,
};

function HtmlTransformEditor({
  params,
  onChange,
}: {
  params: EffectParams & { kind: "HtmlTransform" };
  onChange: (params: EffectParams) => void;
}) {
  const { t } = useTranslation();
  const state = useMemo<TransformState>(
    () => ({
      x: params.x,
      y: params.y,
      scaleX: params.scale_x,
      scaleY: params.scale_y,
      rotationDeg: params.rotation_deg,
      opacity: params.opacity,
    }),
    [params],
  );

  const update = (next: TransformState) => {
    onChange({
      kind: "HtmlTransform",
      x: next.x,
      y: next.y,
      scale_x: next.scaleX,
      scale_y: next.scaleY,
      rotation_deg: next.rotationDeg,
      opacity: next.opacity,
    });
  };

  const fields: Array<[keyof TransformState, string]> = [
    ["x", t("effects_section.field_x", { defaultValue: "x (px)" })],
    ["y", t("effects_section.field_y", { defaultValue: "y (px)" })],
    ["scaleX", t("effects_section.field_scale_x", { defaultValue: "scale x" })],
    ["scaleY", t("effects_section.field_scale_y", { defaultValue: "scale y" })],
    [
      "rotationDeg",
      t("effects_section.field_rotation_deg", { defaultValue: "rotation (deg)" }),
    ],
    ["opacity", t("effects_section.field_opacity", { defaultValue: "opacity" })],
  ];

  return (
    <div className="html-transform-editor">
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
        {t("effects_section.html_transform_hint", {
          defaultValue:
            "Times are owner-local (0 = layer's or group's earliest start). First and last keyframes implicitly mark the html-cap window; outside the window the field returns to identity.",
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
      const v = (track.value as number) ?? identityValue;
      onChange({ mode: "Keyframed", value: [kf(0, v)] });
    } else {
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
          title={t("effects_section.mode_toggle_hint", {
            defaultValue: "Toggle between a static value and keyframed animation",
          })}
        >
          {isStatic
            ? t("effects_section.mode_static", { defaultValue: "static" })
            : t("effects_section.mode_keyframed", { defaultValue: "keyframed" })}
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
    onChange([...kfs, kf(lastT + 1_000_000, identityValue)]);
  };

  const onPatchRow = (idx: number, patch: Partial<Keyframe<number>>) => {
    const next = kfs.map((k, i) => (i === idx ? { ...k, ...patch } : k));
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
          {t("effects_section.no_keyframes", {
            defaultValue:
              "No keyframes yet. Add at least two keyframes at different times to create an animation; one keyframe acts as a static value at that time.",
          })}
        </p>
      ) : (
        <ul>
          <li className="keyframe-list-header">
            <span>{t("effects_section.kf_time", { defaultValue: "time (s)" })}</span>
            <span>{t("effects_section.kf_value", { defaultValue: "value" })}</span>
            <span>{t("effects_section.kf_interp", { defaultValue: "interp" })}</span>
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
                title={t("effects_section.remove_kf", {
                  defaultValue: "Remove keyframe",
                })}
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
        {t("effects_section.add_kf", { defaultValue: "+ Add keyframe" })}
      </button>
    </div>
  );
}

// ===== helpers =====

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

/// Default-shape effect for the chosen kind. Param values mirror the
/// Rust `EffectParams` variant shape exactly so the chain round-trips
/// cleanly through `from_value::<Vec<Effect>>` on the actor side.
function defaultEffect(kind: EffectKind): Effect {
  const id = crypto.randomUUID();
  const stat = (v: number): AnimTrack<number> => ({ mode: "Static", value: v });
  switch (kind) {
    case "HtmlTransform":
      return {
        id,
        enabled: true,
        params: {
          kind: "HtmlTransform",
          x: stat(0),
          y: stat(0),
          scale_x: stat(1),
          scale_y: stat(1),
          rotation_deg: stat(0),
          opacity: stat(1),
        },
      };
    case "ColorCorrect":
      return {
        id,
        enabled: true,
        params: {
          kind: "ColorCorrect",
          brightness: stat(1),
          contrast: stat(1),
          saturation: stat(1),
          gamma: stat(1),
        } as unknown as EffectParams,
      };
    case "Blur":
      return {
        id,
        enabled: true,
        params: { kind: "Blur", radius: stat(0) } as unknown as EffectParams,
      };
    case "ChromaKey":
      return {
        id,
        enabled: true,
        params: {
          kind: "ChromaKey",
          key: { r: 0, g: 255, b: 0, a: 255 },
          similarity: stat(0.1),
          smoothness: stat(0.1),
        } as unknown as EffectParams,
      };
    case "Speed":
      return {
        id,
        enabled: true,
        params: {
          kind: "Speed",
          factor: stat(1),
          preserve_pitch: true,
        } as unknown as EffectParams,
      };
    case "Vignette":
      return {
        id,
        enabled: true,
        params: { kind: "Vignette", amount: stat(0) } as unknown as EffectParams,
      };
  }
}
