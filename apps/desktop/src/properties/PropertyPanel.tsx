import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip } from "@base-ui/react/tooltip";
import { formatTimecode, parseTimecode } from "../frames";
import { AppColorField } from "../components/AppColorField";
import { AppInput } from "../components/AppInput";
import { AppNumberField } from "../components/AppNumberField";
import { AppSelect } from "../components/AppSelect";
import { AppSlider } from "../components/AppSlider";
import { AppSwitch } from "../components/AppSwitch";
import { Button } from "@/components/ui/button";
import {
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
  trackStatic,
} from "../ipc";

// Panel edits operate on the track's STATIC reading (the same flatten the
// Rust IPC boundary used to apply); commits write scalars and the actor
// wraps them `Animated::Static`. Keyframe-aware editing arrives with the
// keyframe authoring UI, not here.
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 };
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
  const [color, setColor] = useState(trackStatic(v.color, WHITE));
  const [x, setX] = useState(trackStatic(v.x, 0));
  const [y, setY] = useState(trackStatic(v.y, 0));
  const [opacity, setOpacity] = useState(trackStatic(v.opacity, 1));
  useEffect(() => {
    setContent(v.content);
    setFamily(v.font_family);
    setSize(v.font_size_px);
    setColor(trackStatic(v.color, WHITE));
    setX(trackStatic(v.x, 0));
    setY(trackStatic(v.y, 0));
    setOpacity(trackStatic(v.opacity, 1));
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
        <AppSelect
          value={family}
          onValueChange={(v) => {
            setFamily(v);
            commit({ kind: "Text", font_family: v });
          }}
          options={FONT_FAMILIES.map((f) => ({ value: f, label: f }))}
        />
      </Field>
      <Field label={t("property_panel.font_size_px")}>
        <AppNumberField
          value={size}
          step={1}
          min={6}
          max={400}
          ariaLabel={t("property_panel.font_size_px")}
          onValueChange={setSize}
          onCommit={(v) => commit({ kind: "Text", font_size_px: v })}
        />
      </Field>
      <Field label={t("property_panel.color")}>
        <AppColorField
          value={rgbaToHex(color)}
          ariaLabel={t("property_panel.color")}
          onValueChange={(v) => {
            const next = hexToRgba(v, color.a);
            setColor(next);
            debouncedCommit({ kind: "Text", color: next });
          }}
        />
      </Field>
      <Field label={t("property_panel.x")}>
        <AppNumberField
          value={x}
          ariaLabel={t("property_panel.x")}
          onValueChange={setX}
          onCommit={(v) => commit({ kind: "Text", x: v })}
        />
      </Field>
      <Field label={t("property_panel.y")}>
        <AppNumberField
          value={y}
          ariaLabel={t("property_panel.y")}
          onValueChange={setY}
          onCommit={(v) => commit({ kind: "Text", y: v })}
        />
      </Field>
      <Field label={t("property_panel.opacity")}>
        <AppSlider
          min={0}
          max={1}
          step={0.01}
          value={opacity}
          onValueChange={(v) => {
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
  const [opacity, setOpacity] = useState(trackStatic(v.opacity, 1));
  const [scaleX, setScaleX] = useState(trackStatic(v.scale_x, 1));
  const [scaleY, setScaleY] = useState(trackStatic(v.scale_y, 1));
  const [x, setX] = useState(trackStatic(v.x, 0));
  const [y, setY] = useState(trackStatic(v.y, 0));
  const [speed, setSpeed] = useState(v.speed);
  const [fadeInTc, setFadeInTc] = useState(formatTimecode(v.fade_in_us, fpsNum, fpsDen));
  const [fadeOutTc, setFadeOutTc] = useState(formatTimecode(v.fade_out_us, fpsNum, fpsDen));
  useEffect(() => {
    setOpacity(trackStatic(v.opacity, 1));
    setScaleX(trackStatic(v.scale_x, 1));
    setScaleY(trackStatic(v.scale_y, 1));
    setX(trackStatic(v.x, 0));
    setY(trackStatic(v.y, 0));
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
        <AppSlider
          min={0}
          max={1}
          step={0.01}
          value={opacity}
          onValueChange={(v) => {
            setOpacity(v);
            debouncedCommit({ kind: "VideoClip", opacity: v });
          }}
        />
        <span className="prop-range-value">{opacity.toFixed(2)}</span>
      </Field>
      <Field label={t("property_panel.scale_x")}>
        <AppNumberField
          step={0.05}
          value={scaleX}
          ariaLabel={t("property_panel.scale_x")}
          onValueChange={setScaleX}
          onCommit={(v) => commit({ kind: "VideoClip", scale_x: v })}
        />
      </Field>
      <Field label={t("property_panel.scale_y")}>
        <AppNumberField
          step={0.05}
          value={scaleY}
          ariaLabel={t("property_panel.scale_y")}
          onValueChange={setScaleY}
          onCommit={(v) => commit({ kind: "VideoClip", scale_y: v })}
        />
      </Field>
      <Field label={t("property_panel.x")}>
        <AppNumberField
          value={x}
          ariaLabel={t("property_panel.x")}
          onValueChange={setX}
          onCommit={(v) => commit({ kind: "VideoClip", x: v })}
        />
      </Field>
      <Field label={t("property_panel.y")}>
        <AppNumberField
          value={y}
          ariaLabel={t("property_panel.y")}
          onValueChange={setY}
          onCommit={(v) => commit({ kind: "VideoClip", y: v })}
        />
      </Field>
      <Field label={t("property_panel.speed")}>
        <AppNumberField
          step={0.05}
          min={0.1}
          max={4}
          value={speed}
          ariaLabel={t("property_panel.speed")}
          onValueChange={setSpeed}
          onCommit={(v) => commit({ kind: "VideoClip", speed: v })}
        />
      </Field>
      <Field label={t("property_panel.fade_in")}>
        <AppInput
          value={fadeInTc}
          ariaLabel={t("property_panel.fade_in")}
          onValueChange={setFadeInTc}
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
        <AppInput
          value={fadeOutTc}
          ariaLabel={t("property_panel.fade_out")}
          onValueChange={setFadeOutTc}
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
        <AppSwitch
          checked={v.flip_h}
          ariaLabel={t("property_panel.flip_h")}
          onCheckedChange={(next) => commit({ kind: "VideoClip", flip_h: next })}
        />
      </Field>
      <Field label={t("property_panel.flip_v")}>
        <AppSwitch
          checked={v.flip_v}
          ariaLabel={t("property_panel.flip_v")}
          onCheckedChange={(next) => commit({ kind: "VideoClip", flip_v: next })}
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
  const [opacity, setOpacity] = useState(trackStatic(v.opacity, 1));
  const [x, setX] = useState(trackStatic(v.x, 0));
  const [y, setY] = useState(trackStatic(v.y, 0));
  const [fadeInTc, setFadeInTc] = useState(formatTimecode(v.fade_in_us, fpsNum, fpsDen));
  const [fadeOutTc, setFadeOutTc] = useState(formatTimecode(v.fade_out_us, fpsNum, fpsDen));
  useEffect(() => {
    setOpacity(trackStatic(v.opacity, 1));
    setX(trackStatic(v.x, 0));
    setY(trackStatic(v.y, 0));
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
        <AppSlider
          min={0}
          max={1}
          step={0.01}
          value={opacity}
          onValueChange={(v) => {
            setOpacity(v);
            debouncedCommit({ kind: "ImageOverlay", opacity: v });
          }}
        />
        <span className="prop-range-value">{opacity.toFixed(2)}</span>
      </Field>
      <Field label={t("property_panel.x")}>
        <AppNumberField
          value={x}
          ariaLabel={t("property_panel.x")}
          onValueChange={setX}
          onCommit={(v) => commit({ kind: "ImageOverlay", x: v })}
        />
      </Field>
      <Field label={t("property_panel.y")}>
        <AppNumberField
          value={y}
          ariaLabel={t("property_panel.y")}
          onValueChange={setY}
          onCommit={(v) => commit({ kind: "ImageOverlay", y: v })}
        />
      </Field>
      <Field label={t("property_panel.fade_in")}>
        <AppInput
          value={fadeInTc}
          ariaLabel={t("property_panel.fade_in")}
          onValueChange={setFadeInTc}
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
        <AppInput
          value={fadeOutTc}
          ariaLabel={t("property_panel.fade_out")}
          onValueChange={setFadeOutTc}
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
  const [x, setX] = useState(trackStatic(v.x, 0));
  const [y, setY] = useState(trackStatic(v.y, 0));
  const [scaleX, setScaleX] = useState(trackStatic(v.scale_x, 1));
  const [scaleY, setScaleY] = useState(trackStatic(v.scale_y, 1));
  const [opacity, setOpacity] = useState(trackStatic(v.opacity, 1));
  useEffect(() => {
    setX(trackStatic(v.x, 0));
    setY(trackStatic(v.y, 0));
    setScaleX(trackStatic(v.scale_x, 1));
    setScaleY(trackStatic(v.scale_y, 1));
    setOpacity(trackStatic(v.opacity, 1));
  }, [layer.id, v]);

  const debouncedCommit = useDebouncedCommit<LayerParamsPatch>(commit);

  // Re-resolve the motif when the runtime catalog changes (e.g. deleting this
  // motif from the lifecycle row below) so the props schema / unknown-note stay
  // in sync with `merged`, not a stale snapshot from mount. Same notifier the
  // lifecycle row rides.
  useSyncExternalStore(subscribeMotifCatalog, motifCatalogRevision);
  // The motif's prop schema drives the props section. A null lookup means
  // the placed motif_id isn't in the catalog (e.g. a removed built-in) — we
  // can still edit transform/opacity, but render a note instead of guessing
  // prop inputs.
  const motif = getMotif(v.motif_id);
  const propEntries = motif
    ? Object.entries(motif.manifest.props_schema)
    : [];

  // Partial props patch: send ONLY the changed key so the backend's field-wise
  // merge (imbl::HashMap insert — keeps all other keys untouched) applies it
  // correctly. Sending the full spread risks a stale v.props racing against a
  // concurrent field edit and silently dropping the earlier write.
  const commitProp = (key: string, next: unknown) =>
    commit({ kind: "Motif", props: { [key]: next } });

  return (
    <section className="prop-section">
      <h3>{t("property_panel.motif")}</h3>
      <BakeStatusLine layerId={layer.id} />
      <MotifLifecycleRow motifId={v.motif_id} layerId={layer.id} onMutated={onMutated} />
      <MotifSourcePanel motifId={v.motif_id} />
      <h4>{t("property_panel.transform")}</h4>
      <Field label={t("property_panel.x")}>
        <AppNumberField
          value={x}
          ariaLabel={t("property_panel.x")}
          onValueChange={setX}
          onCommit={(v) => commit({ kind: "Motif", x: v })}
        />
      </Field>
      <Field label={t("property_panel.y")}>
        <AppNumberField
          value={y}
          ariaLabel={t("property_panel.y")}
          onValueChange={setY}
          onCommit={(v) => commit({ kind: "Motif", y: v })}
        />
      </Field>
      <Field label={t("property_panel.scale_x")}>
        <AppNumberField
          step={0.05}
          value={scaleX}
          ariaLabel={t("property_panel.scale_x")}
          onValueChange={setScaleX}
          onCommit={(v) => commit({ kind: "Motif", scale_x: v })}
        />
      </Field>
      <Field label={t("property_panel.scale_y")}>
        <AppNumberField
          step={0.05}
          value={scaleY}
          ariaLabel={t("property_panel.scale_y")}
          onValueChange={setScaleY}
          onCommit={(v) => commit({ kind: "Motif", scale_y: v })}
        />
      </Field>
      <Field label={t("property_panel.opacity")}>
        <AppSlider
          min={0}
          max={1}
          step={0.01}
          value={opacity}
          onValueChange={(next) => {
            setOpacity(next);
            debouncedCommit({ kind: "Motif", opacity: next });
          }}
        />
        <span className="prop-range-value">{opacity.toFixed(2)}</span>
      </Field>
      {motif === null ? (
        <p className="meta">{t("property_panel.unknown_motif")}</p>
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
        <Button size="sm" disabled={busy} onClick={run(async () => { await pending.action(); setPending(null); })}>
          {t("property_panel.motif_confirm")}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => setPending(null)}>
          {t("property_panel.motif_cancel")}
        </Button>
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
        <span className="motif-card-status status-builtin">
          {t("property_panel.motif_status.builtin", { defaultValue: "builtin" })}
        </span>
        <Button size="sm" disabled={busy} onClick={edit}>{t("property_panel.motif_edit_fork")}</Button>
        {err && <p className="settings-error">{err}</p>}
      </div>
    );
  }

  if (status === "installed") {
    return (
      <div className="prop-motif-lifecycle">
        <span className="motif-card-status status-installed">
          {t("property_panel.motif_status.installed")}
        </span>
        <Button size="sm" disabled={busy} onClick={edit}>{t("property_panel.motif_edit")}</Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => setPending({
            message: t("property_panel.motif_delete_confirm", { id: motifId }),
            action: async () => { await deleteMotif(motifId); await onMutated(); },
          })}
        >
          {t("property_panel.motif_delete")}
        </Button>
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
      <span className="motif-card-status status-draft">
        {t("property_panel.motif_status.draft")}
      </span>
      {target ? (
        <>
          <Button
            size="sm"
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
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={run(async () => {
              await installMotif(motifId, { kind: "new" });
              await onMutated();
            })}
          >
            {t("property_panel.motif_save_as_new")}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={run(async () => {
              await updateLayerParams(layerId, { kind: "Motif", motif_id: target });
              await deleteMotif(motifId);
              await onMutated();
            })}
          >
            {t("property_panel.motif_discard")}
          </Button>
        </>
      ) : (
        <>
          <Button
            size="sm"
            disabled={busy}
            onClick={run(async () => {
              await installMotif(motifId, { kind: "new" });
              await onMutated();
            })}
          >
            {t("property_panel.motif_install")}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={run(async () => {
              await deleteMotif(motifId);
              await onMutated();
            })}
          >
            {t("property_panel.motif_delete")}
          </Button>
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
      <Button size="sm" disabled={busy || source == null} onClick={apply}>
        {busy ? t("property_panel.motif_source_applying") : t("property_panel.motif_source_apply")}
      </Button>
      {err && <p className="settings-error">{err}</p>}
    </div>
  );
}

/// One editable motif prop, switched on `PropSpec.type`. Mirrors the
/// motif picker's `PropField` (string / color / number), but commits each
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
      <AppColorField
        value={color}
        ariaLabel={label}
        onValueChange={(v) => {
          setColor(v);
          onCommit(v);
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
      <AppInput
        value={text}
        ariaLabel={label}
        maxLength={spec.max_length}
        onValueChange={setText}
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
      <AppNumberField
        value={num}
        ariaLabel={label}
        {...(spec.min !== undefined ? { min: spec.min } : {})}
        {...(spec.max !== undefined ? { max: spec.max } : {})}
        // Step heuristic copied from the motif picker: small ranges
        // (≤10 wide) get a 0.1 step, everything else 1.
        step={
          spec.max !== undefined && spec.max - (spec.min ?? 0) <= 10 ? 0.1 : 1
        }
        onValueChange={setNum}
        onCommit={(v) => onCommit(v)}
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
        <AppColorField
          value={rgbaToHex(trackStatic(v.color, BLACK))}
          ariaLabel={t("property_panel.color")}
          onValueChange={(hex) =>
            commit({ kind: "Color", color: hexToRgba(hex, trackStatic(v.color, BLACK).a) })
          }
        />
      </Field>
      <Field label={t("property_panel.width")}>
        <AppNumberField
          value={v.width}
          ariaLabel={t("property_panel.width")}
          step={1}
          // width is u32 on the Rust side — round so a manually-typed
          // fraction can't fail serde (the old parseInt truncated likewise).
          onValueChange={(n) => commit({ kind: "Color", width: Math.round(n) })}
        />
      </Field>
      <Field label={t("property_panel.height")}>
        <AppNumberField
          value={v.height}
          ariaLabel={t("property_panel.height")}
          step={1}
          // height is u32 on the Rust side — round so a manually-typed
          // fraction can't fail serde (the old parseInt truncated likewise).
          onValueChange={(n) => commit({ kind: "Color", height: Math.round(n) })}
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
        <AppNumberField
          step={0.5}
          min={-30}
          max={20}
          value={trackStatic(v.gain_db, 0)}
          ariaLabel={t("property_panel.gain_db")}
          onValueChange={(n) => commit({ kind: "Audio", gain_db: n })}
        />
      </Field>
      <Field label={t("property_panel.pan")}>
        <AppSlider
          min={-1}
          max={1}
          step={0.05}
          value={trackStatic(v.pan, 0)}
          onValueChange={(v2) => commit({ kind: "Audio", pan: v2 })}
        />
      </Field>
      <Field label={t("property_panel.mute")}>
        <AppSwitch
          checked={v.mute}
          ariaLabel={t("property_panel.mute")}
          onCheckedChange={(next) => commit({ kind: "Audio", mute: next })}
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
          <Tooltip.Root>
            <Tooltip.Trigger
              className="prop-field-hint"
              // Keep a span (not the default button): a button inside
              // this <label> would steal the label's input activation.
              render={<span tabIndex={0} />}
              aria-label={hint}
              // Stop clicks on the icon from also focusing the label's
              // input — the user clicked the hint, not the value.
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              ?
            </Tooltip.Trigger>
            <Tooltip.Portal>
              {/* end-aligned below the icon ≈ the old right-anchored
                  bubble; the Positioner flips on collisions, which the
                  hand-rolled CSS bubble never could. */}
              <Tooltip.Positioner
                side="bottom"
                align="end"
                sideOffset={4}
                className="z-50"
              >
                <Tooltip.Popup className="prop-field-hint-bubble">
                  {hint}
                </Tooltip.Popup>
              </Tooltip.Positioner>
            </Tooltip.Portal>
          </Tooltip.Root>
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
