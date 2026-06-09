import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { formatTimecode, parseTimecode } from "../frames";
import {
  updateLayer,
  updateLayerParams,
  installMotif,
  deleteMotif,
  getMotifSource,
  amendMotifDraft,
  createEditDraft,
  type GroupSummary,
  type LayerParamsPatch,
  type LayerSummary,
  type Rgba,
  type TrackSummary,
} from "../ipc";
import { getMotif, subscribeMotifCatalog, motifCatalogRevision, type PropSpec } from "../render/motifs/catalog";
import { useProjectStore } from "../state/projectStore";
import { useLayerBakeStatus } from "../timeline/motifBakeStatusStore";
// EffectsSection + effects-related ipc calls removed in P12-a.

interface Props {
  tracks: TrackSummary[];
  groups: GroupSummary[];
  selectedLayerId: string | null;
  onMutated: () => Promise<void>;
  fpsNum: number;
  fpsDen: number;
}

const COMMIT_DEBOUNCE_MS = 250;

export function PropertyPanel({
  tracks,
  groups,
  selectedLayerId,
  onMutated,
  fpsNum,
  fpsDen,
}: Props) {
  const { t } = useTranslation();
  const layer = useMemo(
    () => findLayer(tracks, selectedLayerId),
    [tracks, selectedLayerId],
  );

  if (!layer) {
    return (
      <aside className="property-panel">
        <h2>{t("property_panel.heading")}</h2>
        <p className="placeholder">{t("property_panel.empty")}</p>
      </aside>
    );
  }

  // `groups` is unused after the EffectsSection removal but kept in the
  // prop signature to avoid churn at the call site. P12-b's IR cleanup
  // can reconsider once `layer.effects` / `group.effects` are gone.
  void groups;

  return (
    <aside className="property-panel">
      <h2>
        {t("property_panel.heading")} —{" "}
        {t(`kinds.${layer.kind.toLowerCase()}`, { defaultValue: layer.kind })}
      </h2>
      <EnvelopeFields layer={layer} onMutated={onMutated} fpsNum={fpsNum} fpsDen={fpsDen} />
      <hr />
      <KindFields layer={layer} onMutated={onMutated} fpsNum={fpsNum} fpsDen={fpsDen} />
    </aside>
  );
}

function findLayer(
  tracks: TrackSummary[],
  layerId: string | null,
): LayerSummary | null {
  if (!layerId) return null;
  for (const t of tracks) {
    const m = t.layers.find((l) => l.id === layerId);
    if (m) return m;
  }
  return null;
}

function EnvelopeFields({
  layer,
  onMutated,
  fpsNum,
  fpsDen,
}: {
  layer: LayerSummary;
  onMutated: () => Promise<void>;
  fpsNum: number;
  fpsDen: number;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState<string>(layer.label ?? "");
  const [enabled, setEnabled] = useState(layer.enabled);
  const [tStartTc, setTStartTc] = useState(formatTimecode(layer.t_start_us, fpsNum, fpsDen));
  const [tEndTc, setTEndTc] = useState(formatTimecode(layer.t_end_us, fpsNum, fpsDen));

  // Reset form state when the user selects a different layer.
  useEffect(() => {
    setLabel(layer.label ?? "");
    setEnabled(layer.enabled);
    setTStartTc(formatTimecode(layer.t_start_us, fpsNum, fpsDen));
    setTEndTc(formatTimecode(layer.t_end_us, fpsNum, fpsDen));
  }, [layer.id, layer.label, layer.enabled, layer.t_start_us, layer.t_end_us, fpsNum, fpsDen]);

  const commit = async (
    patch: Parameters<typeof updateLayer>[1],
  ): Promise<void> => {
    try {
      await updateLayer(layer.id, patch);
      await onMutated();
    } catch (e) {
      console.warn("update_layer failed:", e);
    }
  };

  return (
    <section className="prop-section">
      <h3>{t("property_panel.envelope")}</h3>
      <Field label={t("property_panel.label")}>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => {
            if ((layer.label ?? "") !== label) commit({ label });
          }}
        />
      </Field>
      <Field label={t("property_panel.enabled")}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            commit({ enabled: e.target.checked });
          }}
        />
      </Field>
      <Field
        label={t("property_panel.t_start")}
        hint={t("property_panel.t_start_hint")}
      >
        <input
          type="text"
          value={tStartTc}
          onChange={(e) => setTStartTc(e.target.value)}
          onBlur={() => {
            const us = parseTimecode(tStartTc, fpsNum, fpsDen);
            if (us !== null) {
              commit({ t_start_us: us });
            } else {
              setTStartTc(formatTimecode(layer.t_start_us, fpsNum, fpsDen));
            }
          }}
        />
      </Field>
      <Field
        label={t("property_panel.t_end")}
        hint={t("property_panel.t_end_hint")}
      >
        <input
          type="text"
          value={tEndTc}
          onChange={(e) => setTEndTc(e.target.value)}
          onBlur={() => {
            const us = parseTimecode(tEndTc, fpsNum, fpsDen);
            if (us !== null) {
              commit({ t_end_us: us });
            } else {
              setTEndTc(formatTimecode(layer.t_end_us, fpsNum, fpsDen));
            }
          }}
        />
      </Field>
    </section>
  );
}

function KindFields({
  layer,
  onMutated,
  fpsNum,
  fpsDen,
}: {
  layer: LayerSummary;
  onMutated: () => Promise<void>;
  fpsNum: number;
  fpsDen: number;
}) {
  const commit = async (patch: LayerParamsPatch): Promise<void> => {
    try {
      await updateLayerParams(layer.id, patch);
      await onMutated();
    } catch (e) {
      console.warn("update_layer_params failed:", e);
    }
  };
  switch (layer.params.kind) {
    case "Text":
      return <TextFields layer={layer} v={layer.params} commit={commit} />;
    case "VideoClip":
      return <VideoClipFields layer={layer} v={layer.params} commit={commit} fpsNum={fpsNum} fpsDen={fpsDen} />;
    case "ImageOverlay":
      return (
        <ImageOverlayFields layer={layer} v={layer.params} commit={commit} fpsNum={fpsNum} fpsDen={fpsDen} />
      );
    case "Color":
      return <ColorFields v={layer.params} commit={commit} />;
    case "Audio":
      return <AudioFields v={layer.params} commit={commit} />;
    case "Subtitles":
      return <SubtitlesFields v={layer.params} />;
    case "Motif":
      return <MotifFields layer={layer} v={layer.params} commit={commit} onMutated={onMutated} />;
  }
}

type Commit = (patch: LayerParamsPatch) => Promise<void>;

function TextFields({
  layer,
  v,
  commit,
}: {
  layer: LayerSummary;
  v: Extract<LayerSummary["params"], { kind: "Text" }>;
  commit: Commit;
}) {
  const { t } = useTranslation();
  const [content, setContent] = useState(v.content);
  const [family, setFamily] = useState(v.font_family);
  const [size, setSize] = useState(v.font_size_px);
  const [color, setColor] = useState(v.color);
  const [x, setX] = useState(v.x);
  const [y, setY] = useState(v.y);
  const [opacity, setOpacity] = useState(v.opacity);
  useEffect(() => {
    setContent(v.content);
    setFamily(v.font_family);
    setSize(v.font_size_px);
    setColor(v.color);
    setX(v.x);
    setY(v.y);
    setOpacity(v.opacity);
  }, [layer.id, v]);

  const debouncedCommit = useDebouncedCommit<LayerParamsPatch>(commit);

  return (
    <section className="prop-section">
      <h3>{t("property_panel.text")}</h3>
      <Field label={t("property_panel.content")}>
        <textarea
          value={content}
          rows={2}
          onChange={(e) => setContent(e.target.value)}
          onBlur={() => commit({ kind: "Text", content })}
        />
      </Field>
      <Field label={t("property_panel.font_family")}>
        <select
          value={family}
          onChange={(e) => {
            setFamily(e.target.value);
            commit({ kind: "Text", font_family: e.target.value });
          }}
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("property_panel.font_size_px")}>
        <input
          type="number"
          value={size}
          step={1}
          min={6}
          max={400}
          onChange={(e) => setSize(parseFloat(e.target.value) || size)}
          onBlur={() => commit({ kind: "Text", font_size_px: size })}
        />
      </Field>
      <Field label={t("property_panel.color")}>
        <input
          type="color"
          value={rgbaToHex(color)}
          onChange={(e) => {
            const next = hexToRgba(e.target.value, color.a);
            setColor(next);
            debouncedCommit({ kind: "Text", color: next });
          }}
        />
      </Field>
      <Field label={t("property_panel.x")}>
        <input
          type="number"
          value={x}
          onChange={(e) => setX(parseFloat(e.target.value) || 0)}
          onBlur={() => commit({ kind: "Text", x })}
        />
      </Field>
      <Field label={t("property_panel.y")}>
        <input
          type="number"
          value={y}
          onChange={(e) => setY(parseFloat(e.target.value) || 0)}
          onBlur={() => commit({ kind: "Text", y })}
        />
      </Field>
      <Field label={t("property_panel.opacity")}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={opacity}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            setOpacity(v);
            debouncedCommit({ kind: "Text", opacity: v });
          }}
        />
        <span className="prop-range-value">{opacity.toFixed(2)}</span>
      </Field>
    </section>
  );
}

function VideoClipFields({
  layer,
  v,
  commit,
  fpsNum,
  fpsDen,
}: {
  layer: LayerSummary;
  v: Extract<LayerSummary["params"], { kind: "VideoClip" }>;
  commit: Commit;
  fpsNum: number;
  fpsDen: number;
}) {
  const { t } = useTranslation();
  const [opacity, setOpacity] = useState(v.opacity);
  const [scaleX, setScaleX] = useState(v.scale_x);
  const [scaleY, setScaleY] = useState(v.scale_y);
  const [x, setX] = useState(v.x);
  const [y, setY] = useState(v.y);
  const [speed, setSpeed] = useState(v.speed);
  const [fadeInTc, setFadeInTc] = useState(formatTimecode(v.fade_in_us, fpsNum, fpsDen));
  const [fadeOutTc, setFadeOutTc] = useState(formatTimecode(v.fade_out_us, fpsNum, fpsDen));
  useEffect(() => {
    setOpacity(v.opacity);
    setScaleX(v.scale_x);
    setScaleY(v.scale_y);
    setX(v.x);
    setY(v.y);
    setSpeed(v.speed);
    setFadeInTc(formatTimecode(v.fade_in_us, fpsNum, fpsDen));
    setFadeOutTc(formatTimecode(v.fade_out_us, fpsNum, fpsDen));
  }, [layer.id, v, fpsNum, fpsDen]);

  const debouncedCommit = useDebouncedCommit<LayerParamsPatch>(commit);

  return (
    <section className="prop-section">
      <h3>
        {t("property_panel.media")}: {v.media_label}
      </h3>
      <Field label={t("property_panel.opacity")}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={opacity}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            setOpacity(v);
            debouncedCommit({ kind: "VideoClip", opacity: v });
          }}
        />
        <span className="prop-range-value">{opacity.toFixed(2)}</span>
      </Field>
      <Field label={t("property_panel.scale_x")}>
        <input
          type="number"
          step={0.05}
          value={scaleX}
          onChange={(e) => setScaleX(parseFloat(e.target.value) || 1)}
          onBlur={() => commit({ kind: "VideoClip", scale_x: scaleX })}
        />
      </Field>
      <Field label={t("property_panel.scale_y")}>
        <input
          type="number"
          step={0.05}
          value={scaleY}
          onChange={(e) => setScaleY(parseFloat(e.target.value) || 1)}
          onBlur={() => commit({ kind: "VideoClip", scale_y: scaleY })}
        />
      </Field>
      <Field label={t("property_panel.x")}>
        <input
          type="number"
          value={x}
          onChange={(e) => setX(parseFloat(e.target.value) || 0)}
          onBlur={() => commit({ kind: "VideoClip", x })}
        />
      </Field>
      <Field label={t("property_panel.y")}>
        <input
          type="number"
          value={y}
          onChange={(e) => setY(parseFloat(e.target.value) || 0)}
          onBlur={() => commit({ kind: "VideoClip", y })}
        />
      </Field>
      <Field label={t("property_panel.speed")}>
        <input
          type="number"
          step={0.05}
          min={0.1}
          max={4}
          value={speed}
          onChange={(e) => setSpeed(parseFloat(e.target.value) || 1)}
          onBlur={() => commit({ kind: "VideoClip", speed })}
        />
      </Field>
      <Field label={t("property_panel.fade_in")}>
        <input
          type="text"
          value={fadeInTc}
          onChange={(e) => setFadeInTc(e.target.value)}
          onBlur={() => {
            const us = parseTimecode(fadeInTc, fpsNum, fpsDen);
            if (us !== null) {
              commit({ kind: "VideoClip", fade_in_us: us });
            } else {
              setFadeInTc(formatTimecode(v.fade_in_us, fpsNum, fpsDen));
            }
          }}
        />
      </Field>
      <Field label={t("property_panel.fade_out")}>
        <input
          type="text"
          value={fadeOutTc}
          onChange={(e) => setFadeOutTc(e.target.value)}
          onBlur={() => {
            const us = parseTimecode(fadeOutTc, fpsNum, fpsDen);
            if (us !== null) {
              commit({ kind: "VideoClip", fade_out_us: us });
            } else {
              setFadeOutTc(formatTimecode(v.fade_out_us, fpsNum, fpsDen));
            }
          }}
        />
      </Field>
      <Field label={t("property_panel.flip_h")}>
        <input
          type="checkbox"
          checked={v.flip_h}
          onChange={(e) => commit({ kind: "VideoClip", flip_h: e.target.checked })}
        />
      </Field>
      <Field label={t("property_panel.flip_v")}>
        <input
          type="checkbox"
          checked={v.flip_v}
          onChange={(e) => commit({ kind: "VideoClip", flip_v: e.target.checked })}
        />
      </Field>
    </section>
  );
}

function ImageOverlayFields({
  layer,
  v,
  commit,
  fpsNum,
  fpsDen,
}: {
  layer: LayerSummary;
  v: Extract<LayerSummary["params"], { kind: "ImageOverlay" }>;
  commit: Commit;
  fpsNum: number;
  fpsDen: number;
}) {
  const { t } = useTranslation();
  const [opacity, setOpacity] = useState(v.opacity);
  const [x, setX] = useState(v.x);
  const [y, setY] = useState(v.y);
  const [fadeInTc, setFadeInTc] = useState(formatTimecode(v.fade_in_us, fpsNum, fpsDen));
  const [fadeOutTc, setFadeOutTc] = useState(formatTimecode(v.fade_out_us, fpsNum, fpsDen));
  useEffect(() => {
    setOpacity(v.opacity);
    setX(v.x);
    setY(v.y);
    setFadeInTc(formatTimecode(v.fade_in_us, fpsNum, fpsDen));
    setFadeOutTc(formatTimecode(v.fade_out_us, fpsNum, fpsDen));
  }, [layer.id, v, fpsNum, fpsDen]);
  const debouncedCommit = useDebouncedCommit<LayerParamsPatch>(commit);
  return (
    <section className="prop-section">
      <h3>
        {t("property_panel.media")}: {v.media_label}
      </h3>
      <Field label={t("property_panel.opacity")}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={opacity}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            setOpacity(v);
            debouncedCommit({ kind: "ImageOverlay", opacity: v });
          }}
        />
        <span className="prop-range-value">{opacity.toFixed(2)}</span>
      </Field>
      <Field label={t("property_panel.x")}>
        <input
          type="number"
          value={x}
          onChange={(e) => setX(parseFloat(e.target.value) || 0)}
          onBlur={() => commit({ kind: "ImageOverlay", x })}
        />
      </Field>
      <Field label={t("property_panel.y")}>
        <input
          type="number"
          value={y}
          onChange={(e) => setY(parseFloat(e.target.value) || 0)}
          onBlur={() => commit({ kind: "ImageOverlay", y })}
        />
      </Field>
      <Field label={t("property_panel.fade_in")}>
        <input
          type="text"
          value={fadeInTc}
          onChange={(e) => setFadeInTc(e.target.value)}
          onBlur={() => {
            const us = parseTimecode(fadeInTc, fpsNum, fpsDen);
            if (us !== null) {
              commit({ kind: "ImageOverlay", fade_in_us: us });
            } else {
              setFadeInTc(formatTimecode(v.fade_in_us, fpsNum, fpsDen));
            }
          }}
        />
      </Field>
      <Field label={t("property_panel.fade_out")}>
        <input
          type="text"
          value={fadeOutTc}
          onChange={(e) => setFadeOutTc(e.target.value)}
          onBlur={() => {
            const us = parseTimecode(fadeOutTc, fpsNum, fpsDen);
            if (us !== null) {
              commit({ kind: "ImageOverlay", fade_out_us: us });
            } else {
              setFadeOutTc(formatTimecode(v.fade_out_us, fpsNum, fpsDen));
            }
          }}
        />
      </Field>
    </section>
  );
}

function BakeStatusLine({ layerId }: { layerId: string }) {
  const { t } = useTranslation();
  const status = useLayerBakeStatus(layerId);
  const text = !status
    ? t("property_panel.bake_idle")
    : status.phase === "warming"
      ? t("property_panel.bake_warming", { done: status.done, total: status.total })
      : status.phase === "baking"
        ? t("property_panel.bake_baking", { done: status.done, total: status.total })
        : status.phase === "ready"
          ? t("property_panel.bake_ready", { total: status.total })
          : t("property_panel.bake_error");
  const cls = `prop-bake-status is-${status?.phase ?? "idle"}`;
  return <p className={cls}>{text}</p>;
}

function MotifFields({
  layer,
  v,
  commit,
  onMutated,
}: {
  layer: LayerSummary;
  v: Extract<LayerSummary["params"], { kind: "Motif" }>;
  commit: Commit;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [x, setX] = useState(v.x);
  const [y, setY] = useState(v.y);
  const [scaleX, setScaleX] = useState(v.scale_x);
  const [scaleY, setScaleY] = useState(v.scale_y);
  const [opacity, setOpacity] = useState(v.opacity);
  useEffect(() => {
    setX(v.x);
    setY(v.y);
    setScaleX(v.scale_x);
    setScaleY(v.scale_y);
    setOpacity(v.opacity);
  }, [layer.id, v]);

  const debouncedCommit = useDebouncedCommit<LayerParamsPatch>(commit);

  // Re-resolve the motif when the runtime catalog changes (e.g. deleting this
  // motif from the lifecycle row below) so the props schema / unknown-note stay
  // in sync with `merged`, not a stale snapshot from mount. Same notifier the
  // lifecycle row rides.
  useSyncExternalStore(subscribeMotifCatalog, motifCatalogRevision);
  // The template's prop schema drives the props section. A null lookup means
  // the placed template_id isn't in the catalog (e.g. a removed built-in) — we
  // can still edit transform/opacity, but render a note instead of guessing
  // prop inputs.
  const template = getMotif(v.motif_id);
  const propEntries = template
    ? Object.entries(template.manifest.props_schema)
    : [];

  // Partial props patch: send ONLY the changed key so the backend's field-wise
  // merge (imbl::HashMap insert — keeps all other keys untouched) applies it
  // correctly. Sending the full spread risks a stale v.props racing against a
  // concurrent field edit and silently dropping the earlier write.
  const commitProp = (key: string, next: unknown) =>
    commit({ kind: "Motif", props: { [key]: next } });

  return (
    <section className="prop-section">
      <h3>{t("property_panel.template")}</h3>
      <BakeStatusLine layerId={layer.id} />
      <MotifLifecycleRow motifId={v.motif_id} layerId={layer.id} onMutated={onMutated} />
      <MotifSourcePanel motifId={v.motif_id} />
      <h4>{t("property_panel.transform")}</h4>
      <Field label={t("property_panel.x")}>
        <input
          type="number"
          value={x}
          onChange={(e) => setX(parseFloat(e.target.value) || 0)}
          onBlur={() => commit({ kind: "Motif", x })}
        />
      </Field>
      <Field label={t("property_panel.y")}>
        <input
          type="number"
          value={y}
          onChange={(e) => setY(parseFloat(e.target.value) || 0)}
          onBlur={() => commit({ kind: "Motif", y })}
        />
      </Field>
      <Field label={t("property_panel.scale_x")}>
        <input
          type="number"
          step={0.05}
          value={scaleX}
          onChange={(e) => setScaleX(parseFloat(e.target.value) || 1)}
          onBlur={() => commit({ kind: "Motif", scale_x: scaleX })}
        />
      </Field>
      <Field label={t("property_panel.scale_y")}>
        <input
          type="number"
          step={0.05}
          value={scaleY}
          onChange={(e) => setScaleY(parseFloat(e.target.value) || 1)}
          onBlur={() => commit({ kind: "Motif", scale_y: scaleY })}
        />
      </Field>
      <Field label={t("property_panel.opacity")}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={opacity}
          onChange={(e) => {
            const next = parseFloat(e.target.value);
            setOpacity(next);
            debouncedCommit({ kind: "Motif", opacity: next });
          }}
        />
        <span className="prop-range-value">{opacity.toFixed(2)}</span>
      </Field>
      {template === null ? (
        <p className="meta">{t("property_panel.unknown_template")}</p>
      ) : propEntries.length > 0 ? (
        <>
          <h4>{t("property_panel.props")}</h4>
          {propEntries.map(([key, spec]) => (
            <MotifPropField
              key={key}
              propKey={key}
              spec={spec}
              value={v.props[key]}
              onCommit={(next) => commitProp(key, next)}
              onCommitDebounced={(next) =>
                debouncedCommit({ kind: "Motif", props: { [key]: next } })
              }
            />
          ))}
        </>
      ) : null}
    </section>
  );
}

/// Full Motif edit lifecycle for the placed layer. State machine on the resolved
/// Motif's `status` (+ `target_id` for drafts):
///   - builtin   → "Duplicate & edit" (Edit forks an untargeted draft).
///   - installed → "Edit" (seeds a targeted draft) + Delete.
///   - draft, no target → Install(new) + Delete  (from-scratch authoring).
///   - draft, target=X  → "Update X" (blast-radius confirm) + "Save as new" + Discard.
/// "Edit" creates a working draft via `createEditDraft`, then swaps THIS layer
/// onto it (`updateLayerParams … motif_id: draftId, motif_version: 1`) so the
/// source panel below previews the editable copy. "Discard" swaps the layer back
/// to the target + deletes the draft. The backend emits `motifs:changed`, which
/// resyncs the catalog so the layer keeps rendering.
function MotifLifecycleRow({
  motifId,
  layerId,
  onMutated,
}: {
  motifId: string;
  layerId: string;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Inline confirm (replaces native window.confirm): a pending destructive action
  // + its prompt. While set, the row shows the prompt + Confirm/Cancel instead of
  // firing the action immediately.
  const [pending, setPending] = useState<{ message: string; action: () => Promise<unknown> } | null>(null);
  // Re-render when the runtime catalog changes (install/delete/edit →
  // motifs:changed → syncUserMotifsFromBackend → setUserMotifs → this fires),
  // so status + target stay fresh. Hook runs before any early return.
  useSyncExternalStore(subscribeMotifCatalog, motifCatalogRevision);
  const manifest = getMotif(motifId)?.manifest;
  const status = manifest?.status;
  if (!status) return null; // unknown motif

  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  // A destructive action is awaiting inline confirmation — show the prompt +
  // Confirm/Cancel instead of the normal buttons. Runs AFTER all hooks (rules-of-
  // hooks-safe). On action error, `err` shows and the prompt stays so the failure
  // is visible; `setPending(null)` only fires after the action resolves.
  if (pending) {
    return (
      <div className="prop-motif-lifecycle">
        <p className="meta">{pending.message}</p>
        <button disabled={busy} onClick={run(async () => { await pending.action(); setPending(null); })}>
          {t("property_panel.motif_confirm")}
        </button>
        <button disabled={busy} onClick={() => setPending(null)}>
          {t("property_panel.motif_cancel")}
        </button>
        {err && <p className="settings-error">{err}</p>}
      </div>
    );
  }

  // Edit: fork a working draft and swap this layer onto it (forced version 1 —
  // a fresh draft always starts at v1). The source panel then previews it.
  const edit = run(async () => {
    const draftId = await createEditDraft(motifId);
    await updateLayerParams(layerId, { kind: "Motif", motif_id: draftId, motif_version: 1 });
    await onMutated();
  });

  if (status === "builtin") {
    return (
      <div className="prop-motif-lifecycle">
        <span className="template-card-status status-builtin">
          {t("property_panel.motif_status.builtin", { defaultValue: "builtin" })}
        </span>
        <button disabled={busy} onClick={edit}>{t("property_panel.motif_edit_fork")}</button>
        {err && <p className="settings-error">{err}</p>}
      </div>
    );
  }

  if (status === "installed") {
    return (
      <div className="prop-motif-lifecycle">
        <span className="template-card-status status-installed">
          {t("property_panel.motif_status.installed")}
        </span>
        <button disabled={busy} onClick={edit}>{t("property_panel.motif_edit")}</button>
        <button
          disabled={busy}
          onClick={() => setPending({
            message: t("property_panel.motif_delete_confirm", { id: motifId }),
            action: async () => { await deleteMotif(motifId); await onMutated(); },
          })}
        >
          {t("property_panel.motif_delete")}
        </button>
        {err && <p className="settings-error">{err}</p>}
      </div>
    );
  }

  // status === "draft"
  const target = manifest?.target_id;
  // Non-hook read inside the click handler (NOT a top-level hook). Blast radius
  // of an Update = every layer in THIS project that will change: those still on
  // the target id PLUS those swapped onto this working draft (they rebind to the
  // target on Update). Counting both fixes the common single-edit case (the one
  // edited layer is on the draft, so a target-only count would read "0 layers").
  const updateBlastRadius = (targetId: string) =>
    (useProjectStore.getState().summary?.tracks ?? [])
      .flatMap((tr) => tr.layers)
      .filter((l) => {
        if (l.kind !== "Motif") return false;
        const mid = (l.params as { motif_id?: string }).motif_id;
        return mid === targetId || mid === motifId;
      }).length;

  return (
    <div className="prop-motif-lifecycle">
      <span className="template-card-status status-draft">
        {t("property_panel.motif_status.draft")}
      </span>
      {target ? (
        <>
          <button
            disabled={busy}
            onClick={() => {
              const n = updateBlastRadius(target);
              const message = n === 1
                ? t("property_panel.motif_update_confirm_one")
                : t("property_panel.motif_update_confirm_many", { count: n });
              setPending({
                message,
                action: async () => {
                  await installMotif(motifId, { kind: "update", target_id: target });
                  await onMutated();
                },
              });
            }}
          >
            {t("property_panel.motif_update")}
          </button>
          <button
            disabled={busy}
            onClick={run(async () => {
              await installMotif(motifId, { kind: "new" });
              await onMutated();
            })}
          >
            {t("property_panel.motif_save_as_new")}
          </button>
          <button
            disabled={busy}
            onClick={run(async () => {
              await updateLayerParams(layerId, { kind: "Motif", motif_id: target });
              await deleteMotif(motifId);
              await onMutated();
            })}
          >
            {t("property_panel.motif_discard")}
          </button>
        </>
      ) : (
        <>
          <button
            disabled={busy}
            onClick={run(async () => {
              await installMotif(motifId, { kind: "new" });
              await onMutated();
            })}
          >
            {t("property_panel.motif_install")}
          </button>
          <button
            disabled={busy}
            onClick={run(async () => {
              await deleteMotif(motifId);
              await onMutated();
            })}
          >
            {t("property_panel.motif_delete")}
          </button>
        </>
      )}
      {err && <p className="settings-error">{err}</p>}
    </div>
  );
}

/// In-app source editor for a selected DRAFT Motif layer (upload-design §6).
/// Deliberately minimal: a plain textarea of the draft's full composed source
/// (manifest island + body). "Apply" funnels through `amendMotifDraft`, which
/// re-parses the island, forces the stable id, re-composes, and emits
/// `motifs:changed` → the catalog resyncs (new content_hash) → the canvas
/// preview re-captures. Only shown for drafts; editing an installed Motif (which
/// seeds a fresh draft) is a later stage.
function MotifSourcePanel({ motifId }: { motifId: string }) {
  const { t } = useTranslation();
  // Re-resolve status reactively (same notifier the lifecycle row uses) so this
  // unmounts the instant the draft is installed/deleted.
  useSyncExternalStore(subscribeMotifCatalog, motifCatalogRevision);
  const status = getMotif(motifId)?.manifest.status;
  const [source, setSource] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Seed the textarea from disk whenever the selected draft changes.
  useEffect(() => {
    let alive = true;
    setErr(null);
    setSource(null);
    getMotifSource(motifId)
      .then((s) => { if (alive) setSource(s.html); })
      .catch((e) => { if (alive) setErr(String(e)); });
    return () => { alive = false; };
  }, [motifId]);

  if (status !== "draft") return null;

  const apply = async () => {
    if (source == null) return;
    setBusy(true);
    setErr(null);
    try {
      await amendMotifDraft(motifId, source);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="prop-motif-source">
      <h4>{t("property_panel.motif_source")}</h4>
      <p className="meta">{t("property_panel.motif_source_hint")}</p>
      <textarea
        className="prop-motif-source-text"
        spellCheck={false}
        value={source ?? ""}
        disabled={source == null || busy}
        onChange={(e) => setSource(e.target.value)}
      />
      <button disabled={busy || source == null} onClick={apply}>
        {busy ? t("property_panel.motif_source_applying") : t("property_panel.motif_source_apply")}
      </button>
      {err && <p className="settings-error">{err}</p>}
    </div>
  );
}

/// One editable template prop, switched on `PropSpec.type`. Mirrors the
/// template picker's `PropField` (string / color / number), but commits each
/// change field-wise via `onCommit`. The string/number variants delegate to
/// dedicated sub-components so each can hold the local-state hooks at the top
/// of its body (rules-of-hooks; the color variant needs no local state).
/// Props colors are plain hex strings (e.g. `#ff3366`), NOT `Rgba` — handled
/// as strings, not via the `rgbaToHex` / `hexToRgba` helpers.
function MotifPropField({
  propKey,
  spec,
  value,
  onCommit,
  onCommitDebounced,
}: {
  propKey: string;
  spec: PropSpec;
  value: unknown;
  /// Immediate commit — used by string/number which fire once, on blur.
  onCommit: (next: unknown) => void;
  /// Debounced commit — used by the color field, whose `<input type="color">`
  /// fires `onChange` continuously while the OS color dialog is dragged. Each
  /// commit triggers a CDP re-capture (~80-100ms, serialized), so an undebounced
  /// drag floods the capture queue and stutters the preview.
  onCommitDebounced: (next: unknown) => void;
}) {
  const { t } = useTranslation();
  const label = t(`property_panel.props.${propKey}`, { defaultValue: propKey });

  switch (spec.type) {
    case "string":
      return (
        <StringPropField label={label} spec={spec} value={value} onCommit={onCommit} />
      );
    case "color":
      return (
        <ColorPropField
          label={label}
          spec={spec}
          value={value}
          onCommit={onCommitDebounced}
        />
      );
    case "number":
      return (
        <NumberPropField label={label} spec={spec} value={value} onCommit={onCommit} />
      );
  }
}

function ColorPropField({
  label,
  spec,
  value,
  onCommit,
}: {
  label: string;
  spec: Extract<PropSpec, { type: "color" }>;
  value: unknown;
  /// Debounced commit (see MotifPropField).
  onCommit: (next: unknown) => void;
}) {
  // Local state drives the swatch so it tracks the drag live; the actual commit
  // (and the CDP re-capture it triggers) is debounced by the caller. `<input
  // type="color">` only edits the 6-char RGB triplet — show the leading 7 chars
  // but commit the raw value it returns. (Trailing alpha in a default like
  // `#000000cc` is dropped on first pick — same tradeoff as the picker.)
  const toRgb = (s: string) => (s.length >= 7 ? s.slice(0, 7) : s);
  const [color, setColor] = useState(
    toRgb(typeof value === "string" ? value : spec.default),
  );
  useEffect(() => {
    setColor(toRgb(typeof value === "string" ? value : spec.default));
  }, [value, spec.default]);
  return (
    <Field label={label}>
      <input
        type="color"
        value={color}
        onChange={(e) => {
          setColor(e.target.value);
          onCommit(e.target.value);
        }}
      />
    </Field>
  );
}

function StringPropField({
  label,
  spec,
  value,
  onCommit,
}: {
  label: string;
  spec: Extract<PropSpec, { type: "string" }>;
  value: unknown;
  onCommit: (next: unknown) => void;
}) {
  const [text, setText] = useState(
    typeof value === "string" ? value : spec.default,
  );
  useEffect(() => {
    setText(typeof value === "string" ? value : spec.default);
  }, [value, spec.default]);
  return (
    <Field label={label}>
      <input
        type="text"
        value={text}
        maxLength={spec.max_length}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onCommit(text)}
      />
    </Field>
  );
}

function NumberPropField({
  label,
  spec,
  value,
  onCommit,
}: {
  label: string;
  spec: Extract<PropSpec, { type: "number" }>;
  value: unknown;
  onCommit: (next: unknown) => void;
}) {
  const [num, setNum] = useState<number>(
    typeof value === "number" ? value : spec.default,
  );
  useEffect(() => {
    setNum(typeof value === "number" ? value : spec.default);
  }, [value, spec.default]);
  return (
    <Field label={label}>
      <input
        type="number"
        value={num}
        min={spec.min}
        max={spec.max}
        // Step heuristic copied from the template picker: small ranges
        // (≤10 wide) get a 0.1 step, everything else 1.
        step={
          spec.max !== undefined && spec.max - (spec.min ?? 0) <= 10 ? 0.1 : 1
        }
        onChange={(e) => {
          setNum(Number(e.target.value));
        }}
        onBlur={() => onCommit(num)}
      />
    </Field>
  );
}

function ColorFields({
  v,
  commit,
}: {
  v: Extract<LayerSummary["params"], { kind: "Color" }>;
  commit: Commit;
}) {
  const { t } = useTranslation();
  return (
    <section className="prop-section">
      <h3>{t("property_panel.color")}</h3>
      <Field label={t("property_panel.color")}>
        <input
          type="color"
          value={rgbaToHex(v.color)}
          onChange={(e) =>
            commit({ kind: "Color", color: hexToRgba(e.target.value, v.color.a) })
          }
        />
      </Field>
      <Field label={t("property_panel.width")}>
        <input
          type="number"
          value={v.width}
          onChange={(e) =>
            commit({ kind: "Color", width: parseInt(e.target.value, 10) || v.width })
          }
        />
      </Field>
      <Field label={t("property_panel.height")}>
        <input
          type="number"
          value={v.height}
          onChange={(e) =>
            commit({ kind: "Color", height: parseInt(e.target.value, 10) || v.height })
          }
        />
      </Field>
    </section>
  );
}

function AudioFields({
  v,
  commit,
}: {
  v: Extract<LayerSummary["params"], { kind: "Audio" }>;
  commit: Commit;
}) {
  const { t } = useTranslation();
  return (
    <section className="prop-section">
      <h3>
        {t("property_panel.media")}: {v.media_label}
      </h3>
      <Field label={t("property_panel.gain_db")}>
        <input
          type="number"
          step={0.5}
          min={-30}
          max={20}
          value={v.gain_db}
          onChange={(e) =>
            commit({
              kind: "Audio",
              gain_db: parseFloat(e.target.value) || 0,
            })
          }
        />
      </Field>
      <Field label={t("property_panel.pan")}>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={v.pan}
          onChange={(e) =>
            commit({ kind: "Audio", pan: parseFloat(e.target.value) || 0 })
          }
        />
      </Field>
      <Field label={t("property_panel.mute")}>
        <input
          type="checkbox"
          checked={v.mute}
          onChange={(e) => commit({ kind: "Audio", mute: e.target.checked })}
        />
      </Field>
    </section>
  );
}

function SubtitlesFields({
  v,
}: {
  v: Extract<LayerSummary["params"], { kind: "Subtitles" }>;
}) {
  const { t } = useTranslation();
  return (
    <section className="prop-section">
      <h3>{t("property_panel.subtitles")}</h3>
      <p className="meta">
        {t("property_panel.subtitles_source")}: {v.source_kind}
      </p>
      <p className="meta truncate" title={v.source_value}>
        {v.source_value}
      </p>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  /// Optional explanatory text. Rendered as a `?` icon next to the
  /// label; hovering / keyboard-focusing the icon shows the hint in
  /// a popover. Use for non-obvious field semantics — e.g. half-open
  /// interval boundaries — where the label alone doesn't tell the
  /// whole story.
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="prop-field">
      <span className="prop-field-label">
        {label}
        {hint ? (
          <span
            className="prop-field-hint"
            tabIndex={0}
            role="tooltip"
            aria-label={hint}
            // Stop clicks on the icon from also focusing the label's
            // input — the user clicked the hint, not the value.
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            ?
            <span className="prop-field-hint-bubble">{hint}</span>
          </span>
        ) : null}
      </span>
      <div className="prop-field-control">{children}</div>
    </label>
  );
}

const FONT_FAMILIES = [
  "Arial",
  "Times New Roman",
  "Courier New",
  "Verdana",
  "Tahoma",
];

function rgbaToHex(c: Rgba): string {
  return `#${[c.r, c.g, c.b]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")}`;
}

function hexToRgba(hex: string, a: number): Rgba {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || !m[1]) return { r: 255, g: 255, b: 255, a };
  const n = parseInt(m[1], 16);
  return {
    r: (n >> 16) & 0xff,
    g: (n >> 8) & 0xff,
    b: n & 0xff,
    a,
  };
}

/**
 * Hook: returns a debounced commit function. Continuous-input controls
 * (sliders, color pickers) call this so we don't fire a Tauri command on
 * every pixel of slider movement; the actor would queue up and the UI
 * would feel laggy.
 */
function useDebouncedCommit<P>(commit: (p: P) => Promise<void>) {
  // useRef without import — closure-stable timer slot.
  const slot: { current: ReturnType<typeof setTimeout> | null } = useMemo(
    () => ({ current: null }),
    [],
  );
  return (patch: P) => {
    if (slot.current) clearTimeout(slot.current);
    slot.current = setTimeout(() => {
      commit(patch).catch((e) => console.warn(e));
    }, COMMIT_DEBOUNCE_MS);
  };
}
