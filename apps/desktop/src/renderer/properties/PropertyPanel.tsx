import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { formatTimecode, parseTimecode } from "../frames";
import {
  AUDIO_UNITS_ORDER,
  formatAudioTime,
  parseAudioTime,
  setAudioUnits,
  useAudioUnits,
  type AudioUnits,
} from "../state/audioUnitsStore";
import { AppColorField } from "../components/AppColorField";
import { AppInput } from "../components/AppInput";
import { AppNumberField } from "../components/AppNumberField";
import { AppSelect } from "../components/AppSelect";
import { AppSwitch } from "../components/AppSwitch";
import { Button } from "@/components/ui/button";
import {
  updateLayer,
  updateLayerParams,
  moveLayer,
  trimLayer,
  installMotif,
  deleteMotif,
  getMotifSource,
  amendMotifDraft,
  createEditDraft,
  AUDIO_ROLES,
  type AudioRole,
  type LayerParamsPatch,
  type LayerSummary,
  type Rgba,
  type TrackSummary,
  trackStatic,
} from "../ipc";
import { X, Y, ROTATION, ANCHOR_X, ANCHOR_Y, OPACITY, GAIN_DB, PAN } from "../keyframe/descriptors";
import { layerDisplayName } from "../lib/layerName";
import { trackDisplayName } from "../lib/trackName";
import { refusalText, tryMutate } from "../errors/tryMutate";
import { InspectorAnimField } from "./InspectorAnimField";
import { ScaleFields } from "./ScaleFields";

// Animatable rows (transform/opacity for visual kinds, gain_db/pan for audio)
// render via `InspectorAnimField`; every other row (fades/flip/mute/content/
// font, Text color, Motif props) commits scalars through `updateLayerParams`.
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 };
import { getMotif, subscribeMotifCatalog, motifCatalogRevision } from "../render/motifs/catalog";
import { useProjectStore, useProjectSummary } from "../state/projectStore";
import { useSelectedLayerIds, useSelectedTransitionId } from "../state/selectionStore";
import { TransitionFields } from "./TransitionFields";
import { Field } from "./Field";
import { MotifParamsFrame } from "./MotifParamsFrame";
import { MotifPropField } from "./MotifPropFields";
import { PropSection } from "./PropSection";
import { useLayerBakeStatus } from "../timeline/motifBakeStatusStore";
import { findPanelLayer } from "../panels/panelLayer";

export { isVisualKind } from "../panels/panelLayer";

export interface AttributePanelProps {
  tracks: TrackSummary[];
  selectedLayerId: string | null;
  onMutated: () => Promise<void>;
  fpsNum: number;
  fpsDen: number;
  currentTimeUs: number;
}

const COMMIT_DEBOUNCE_MS = 250;

export function AttributePanel({
  tracks,
  selectedLayerId,
  onMutated,
  fpsNum,
  fpsDen,
  currentTimeUs,
}: AttributePanelProps) {
  const { t } = useTranslation();
  const layer = useMemo(
    () => findPanelLayer(tracks, selectedLayerId),
    [tracks, selectedLayerId],
  );
  const track = useMemo(
    () => (layer ? tracks.find((tr) => tr.layers.some((l) => l.id === layer.id)) : undefined),
    [tracks, layer],
  );
  // Selected transition chip — mutually exclusive with layer selection
  // (selectionStore invariant), so this branch and the layer branch never
  // compete. Resolved from the project store; the summary is the same
  // snapshot the timeline chips render from.
  const selectedTransitionId = useSelectedTransitionId();
  const summaryForTransition = useProjectSummary();
  const transition = useMemo(
    () =>
      selectedTransitionId === null
        ? null
        : (summaryForTransition?.transitions ?? []).find(
            (tr) => tr.id === selectedTransitionId,
          ) ?? null,
    [selectedTransitionId, summaryForTransition],
  );

  if (transition) {
    return (
      <aside
        className="property-panel attribute-panel"
        aria-label={t("property_panel.heading")}
      >
        <TransitionFields
          transition={transition}
          fpsNum={fpsNum}
          fpsDen={fpsDen}
          onMutated={onMutated}
        />
      </aside>
    );
  }

  if (!layer) {
    return (
      <aside
        className="property-panel attribute-panel"
        aria-label={t("property_panel.heading")}
      >
        <p className="placeholder">{t("property_panel.empty")}</p>
      </aside>
    );
  }

  return (
    <aside
      className="property-panel attribute-panel"
      aria-label={t("property_panel.heading")}
    >
      <LayerPanel layer={layer} track={track} onMutated={onMutated} fpsNum={fpsNum} fpsDen={fpsDen} currentTimeUs={currentTimeUs} />
    </aside>
  );
}

/// The layer branch of the panel: two quiet meta lines (identity, then media
/// label for media kinds), the core envelope Section, the kind's core
/// Section(s), and ONE advanced bucket — always last, default collapsed —
/// holding Locked, Start, audio units (audio only), then the kind-specific
/// advanced rows. Collapse state is session-scoped per (kind, section); see
/// PropSection.
function LayerPanel({
  layer,
  track,
  onMutated,
  fpsNum,
  fpsDen,
  currentTimeUs,
}: {
  layer: LayerSummary;
  track: TrackSummary | undefined;
  onMutated: () => Promise<void>;
  fpsNum: number;
  fpsDen: number;
  currentTimeUs: number;
}) {
  const { t } = useTranslation();
  const summary = useProjectSummary();
  const selectionCount = useSelectedLayerIds().size;
  const group = summary?.groups.find((g) => g.layer_ids.includes(layer.id)) ?? null;
  const env = useEnvelope({ layer, track, onMutated, fpsNum, fpsDen });

  const kindLabel = t(`kinds.${layer.kind.toLowerCase()}`, { defaultValue: layer.kind });
  const trackLabel = track
    ? trackDisplayName(track, summary?.tracks ?? [], t)
    : "—";
  const mediaLabel =
    layer.params.kind === "VideoClip" ||
    layer.params.kind === "ImageOverlay" ||
    layer.params.kind === "Audio"
      ? layer.params.media_label
      : null;
  // Groups created from the UI carry no label (Timeline passes `label: null`),
  // so a `group.id` fallback rendered a raw uuid on every grouped layer. Member
  // count is the part a user can act on; a real name only arrives via MCP
  // `groups_rename`.
  const groupLabel = group
    ? group.label?.trim() ||
      t("property_panel.group_of", { count: group.layer_ids.length })
    : t("property_panel.group_none");

  const tInLayerUs = currentTimeUs - layer.t_start_us;
  const playheadInSpan = currentTimeUs >= layer.t_start_us && currentTimeUs < layer.t_end_us;

  return (
    <>
      <div className="prop-identity">
        {mediaLabel ? <p className="prop-identity-title">{mediaLabel}</p> : null}
        <p className="prop-identity-meta">
          {kindLabel} · {trackLabel} · {groupLabel}
        </p>
      </div>
      {selectionCount > 1 ? (
        <p className="prop-primary-note">
          {t("property_panel.multi_primary", { label: layerDisplayName(layer, t), count: selectionCount })}
        </p>
      ) : null}
      <PropSection layerKind={layer.kind} sectionId="envelope" title={t("property_panel.envelope")}>
        <Field label={t("property_panel.label")}>
          <AppInput
            value={env.label}
            ariaLabel={t("property_panel.label")}
            onValueChange={env.setLabel}
            onBlur={env.commitLabel}
          />
        </Field>
        <Field label={t("property_panel.enabled")}>
          <AppSwitch
            checked={layer.enabled}
            ariaLabel={t("property_panel.enabled")}
            onCheckedChange={(next) => env.commitFlag({ enabled: next })}
          />
        </Field>
        <Field label={t("property_panel.duration")}>
          <AppInput
            value={env.durTc}
            mono
            disabled={env.timingDisabled}
            ariaLabel={t("property_panel.duration")}
            onValueChange={env.setDurTc}
            onBlur={env.commitDuration}
          />
        </Field>
      </PropSection>
      <KindFields layer={layer} onMutated={onMutated} fpsNum={fpsNum} fpsDen={fpsDen} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} />
      <PropSection layerKind={layer.kind} sectionId="advanced" title={t("property_panel.advanced")} defaultCollapsed>
        <Field label={t("property_panel.locked")}>
          <AppSwitch
            checked={layer.locked}
            ariaLabel={t("property_panel.locked")}
            onCheckedChange={(next) => env.commitFlag({ locked: next })}
          />
        </Field>
        <Field label={t("property_panel.t_start")} hint={t("property_panel.t_start_hint")}>
          <AppInput
            value={env.startTc}
            mono
            disabled={env.timingDisabled}
            ariaLabel={t("property_panel.t_start")}
            onValueChange={env.setStartTc}
            onBlur={env.commitStart}
          />
        </Field>
        {env.isAudio ? (
          // Premiere's "audio units" equivalent, placed with the readouts it governs.
          // Scoped to audio times only: the ruler stays frame-based, because there is no
          // zoom at which a sample ruler is legible and it would put a second grid on
          // screen (ADR 0038).
          <Field label={t("timeline.audio_units")} hint={t("property_panel.audio_units_hint")}>
            <AppSelect
              value={env.units}
              ariaLabel={t("timeline.audio_units")}
              onValueChange={(v) => setAudioUnits(v as AudioUnits)}
              options={AUDIO_UNITS_ORDER.map((u) => ({
                value: u,
                label: t(`timeline.audio_units_${u}`),
              }))}
            />
          </Field>
        ) : null}
        <KindAdvancedFields layer={layer} onMutated={onMutated} fpsNum={fpsNum} fpsDen={fpsDen} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} />
      </PropSection>
    </>
  );
}

/// State + commit routing for the Layer envelope: identity (label), flags
/// (enabled/locked), and timing (Start/duration). Shared between the core
/// envelope Section and the advanced bucket, which split the rows between
/// them. Timing edits route through the SAME group-aware commands as Timeline
/// gestures — Start through `move_layer`, duration through `trim_layer` — so
/// snapping, group fan-out, lock checks, and composition autofit behave
/// identically no matter where the edit comes from (spec: the inspector
/// must not create a different editing model; raw `update_layer` envelope
/// patching is deliberately NOT used for time edits because it neither
/// snaps nor autofits).
function useEnvelope({
  layer,
  track,
  onMutated,
  fpsNum,
  fpsDen,
}: {
  layer: LayerSummary;
  track: TrackSummary | undefined;
  onMutated: () => Promise<void>;
  fpsNum: number;
  fpsDen: number;
}) {
  // ── Audio-layer timing reads and writes on the SAMPLE lattice (ADR 0038) ────
  // Sample precision is unreachable by dragging (0.042 px per sample at the zoom
  // ceiling), so these fields — together with the nudge commands — ARE the
  // fine-authoring surface. The unit is a reading preference scoped to audio
  // readouts; the ruler, the playhead and every visual layer stay frame-based.
  const units = useAudioUnits();
  const isAudio = layer.kind === "Audio";
  const fmtTime = (us: number): string =>
    isAudio ? formatAudioTime(us, units, fpsNum, fpsDen) : formatTimecode(us, fpsNum, fpsDen);
  const parseTime = (s: string): number | null =>
    isAudio ? parseAudioTime(s, units, fpsNum, fpsDen) : parseTimecode(s, fpsNum, fpsDen);

  const [label, setLabel] = useState(layer.label ?? "");
  const [startTc, setStartTc] = useState(() => fmtTime(layer.t_start_us));
  const [durTc, setDurTc] = useState(() => fmtTime(layer.t_end_us - layer.t_start_us));
  // Resync from the authoritative snapshot whenever the committed envelope
  // changes (own commit round-trip, group fan-out, undo) — or when the audio unit
  // flips, which re-renders the same times in the new unit. Primitive deps —
  // not the layer object — so unrelated project refreshes can't clobber a
  // field mid-typing.
  useEffect(() => {
    setLabel(layer.label ?? "");
    setStartTc(fmtTime(layer.t_start_us));
    setDurTc(fmtTime(layer.t_end_us - layer.t_start_us));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fmtTime is derived from
    // exactly the primitives listed here; including it would re-run every render.
  }, [layer.id, layer.label, layer.t_start_us, layer.t_end_us, fpsNum, fpsDen, isAudio, units]);

  // Timeline gesture suppression parity: a locked Layer (or a Layer on a
  // locked Track) can't be moved/trimmed from the Timeline, so the
  // inspector's timing fields read but don't edit.
  const timingDisabled = layer.locked || (track?.locked ?? false);

  // Every edit below records exactly one undo entry per committed gesture.
  // Guards skip the command entirely when the field still holds the current
  // (grid-aligned) value, so re-committing an unchanged value can't record
  // a no-op undo.
  const commitLabel = async (): Promise<void> => {
    const next = label.trim();
    if (next === (layer.label ?? "")) return;
    if (next === "") {
      // `LayerPatch.label` can't express null — an empty field reverts
      // rather than clearing the label.
      setLabel(layer.label ?? "");
      return;
    }
    if (await tryMutate(() => updateLayer(layer.id, { label: next }), "Rename layer")) {
      await onMutated();
    } else {
      setLabel(layer.label ?? "");
    }
  };

  const commitFlag = async (patch: { enabled: boolean } | { locked: boolean }): Promise<void> => {
    if (await tryMutate(() => updateLayer(layer.id, patch), "Update layer flag")) {
      await onMutated();
    }
  };

  // Start edits move the whole Layer (group-aware); the command snaps to
  // the comp frame grid and autofits the composition.
  const commitStart = async (): Promise<void> => {
    const us = parseTime(startTc);
    if (us === null) {
      setStartTc(fmtTime(layer.t_start_us));
      return;
    }
    if (us === layer.t_start_us || !track) return;
    // `escapeGroup` on an audio layer: a sub-frame start edit is a SLIP, so it must
    // move this member alone. Dragging the whole group to a sample boundary would
    // put the video member off its own grid (ADR 0038 / R2-D7).
    if (await tryMutate(() => moveLayer(layer.id, track.id, us, isAudio), "Move layer")) {
      await onMutated();
    } else {
      setStartTc(fmtTime(layer.t_start_us));
    }
  };

  // Duration edits are an out-edge trim to t_start + duration; the command
  // clamps against the minimum Layer duration and media bounds.
  const commitDuration = async (): Promise<void> => {
    const us = parseTime(durTc);
    if (us === null || us <= 0) {
      setDurTc(fmtTime(layer.t_end_us - layer.t_start_us));
      return;
    }
    const newEnd = layer.t_start_us + us;
    if (newEnd === layer.t_end_us) return;
    if (await tryMutate(() => trimLayer(layer.id, "out", newEnd), "Trim layer")) {
      await onMutated();
    } else {
      setDurTc(fmtTime(layer.t_end_us - layer.t_start_us));
    }
  };

  return {
    label,
    setLabel,
    startTc,
    setStartTc,
    durTc,
    setDurTc,
    units,
    isAudio,
    timingDisabled,
    commitLabel,
    commitFlag,
    commitStart,
    commitDuration,
  };
}

function KindFields({
  layer,
  onMutated,
  fpsNum,
  fpsDen,
  tInLayerUs,
  playheadInSpan,
}: {
  layer: LayerSummary;
  onMutated: () => Promise<void>;
  fpsNum: number;
  fpsDen: number;
  tInLayerUs: number;
  playheadInSpan: boolean;
}) {
  const commit = commitLayerParams(layer.id, onMutated);

  switch (layer.params.kind) {
    case "Text":
      return (
        <>
          <TextFields layer={layer} v={layer.params} commit={commit} />
          <TransformSection layer={layer} scaleLinked={layer.params.scale_linked} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
        </>
      );
    case "VideoClip":
      return (
        <>
          <VideoClipFields layer={layer} v={layer.params} commit={commit} />
          <TransformSection layer={layer} scaleLinked={layer.params.scale_linked} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
        </>
      );
    case "ImageOverlay":
      // Core is just the transform section; fades wait in the advanced bucket.
      return <TransformSection layer={layer} scaleLinked={layer.params.scale_linked} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />;
    case "Color":
      return <ColorFields layer={layer} v={layer.params} commit={commit} />;
    case "Audio":
      return <AudioFields layer={layer} v={layer.params} commit={commit} fpsNum={fpsNum} fpsDen={fpsDen} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />;
    case "Motif":
      return <MotifFields layer={layer} v={layer.params} commit={commit} onMutated={onMutated} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} />;
  }
}

/// The kind-specific tail of the advanced bucket: video fades/flips, image
/// fades, audio pan/role/mute, and the Motif lifecycle row, in that order.
/// Text and Color contribute nothing beyond Locked + Start.
function KindAdvancedFields({
  layer,
  onMutated,
  fpsNum,
  fpsDen,
  tInLayerUs,
  playheadInSpan,
}: {
  layer: LayerSummary;
  onMutated: () => Promise<void>;
  fpsNum: number;
  fpsDen: number;
  tInLayerUs: number;
  playheadInSpan: boolean;
}) {
  const commit = commitLayerParams(layer.id, onMutated);

  switch (layer.params.kind) {
    case "VideoClip":
      return <VideoClipAdvancedFields layer={layer} v={layer.params} commit={commit} fpsNum={fpsNum} fpsDen={fpsDen} />;
    case "ImageOverlay":
      return <ImageOverlayAdvancedFields layer={layer} v={layer.params} commit={commit} fpsNum={fpsNum} fpsDen={fpsDen} />;
    case "Audio":
      return <AudioAdvancedFields layer={layer} v={layer.params} commit={commit} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />;
    case "Motif":
      return <MotifLifecycleRow motifId={layer.params.motif_id} layerId={layer.id} onMutated={onMutated} />;
    default:
      return null;
  }
}

type Commit = (patch: LayerParamsPatch) => Promise<void>;

/// The field-wise params commit shared by the core and advanced kind
/// dispatchers: one backend command + one refresh per gesture; a refusal
/// becomes a status-bar line (errors/tryMutate.ts).
function commitLayerParams(layerId: string, onMutated: () => Promise<void>): Commit {
  return async (patch) => {
    if (await tryMutate(() => updateLayerParams(layerId, patch), "Edit layer property")) {
      await onMutated();
    }
  };
}

/// Unified transform Section for the visual kinds (Text, VideoClip,
/// ImageOverlay, Motif): opacity, position, scale, rotation, anchor. Position,
/// scale and anchor pair their two axes into one row each (`.prop-field-pair`);
/// opacity and rotation stay full-width.
///
/// Anchor sits AFTER rotation because it is read as "what that rotation turns
/// around" — and it stays in the core section rather than the advanced bucket
/// because the on-canvas target makes it a routine gesture, not a rare setting.
function TransformSection({
  layer,
  scaleLinked,
  tInLayerUs,
  playheadInSpan,
  onMutated,
}: {
  layer: LayerSummary;
  scaleLinked: boolean;
  tInLayerUs: number;
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <PropSection layerKind={layer.kind} sectionId="transform" title={t("property_panel.transform")}>
      <InspectorAnimField layer={layer} desc={OPACITY} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
      <div className="prop-field-pair">
        <InspectorAnimField layer={layer} desc={X} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
        <InspectorAnimField layer={layer} desc={Y} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
      </div>
      {/* Scale keeps the axis-pair row, but `ScaleFields` owns what fills it:
          one collapsed "Scale" + closed chain while linked, Scale X / Scale Y
          + open chain while not. `.prop-field-pair > .scale-link-row` gives the
          chain-bearing row the same flex basis as a bare `.anim-field`, so the
          linked form spans the row and the unlinked form pairs off. */}
      <div className="prop-field-pair">
        <ScaleFields layer={layer} scaleLinked={scaleLinked} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
      </div>
      <InspectorAnimField layer={layer} desc={ROTATION} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
      <div className="prop-field-pair">
        <InspectorAnimField layer={layer} desc={ANCHOR_X} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
        <InspectorAnimField layer={layer} desc={ANCHOR_Y} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
      </div>
    </PropSection>
  );
}

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
  const [color, setColor] = useState(() => trackStatic(v.color, WHITE));
  // While the size field is being edited, suppress the prop→local resync so a
  // mid-typing debounced commit's round-trip can't clobber the in-progress edit.
  const editingSize = useRef(false);
  useEffect(() => {
    if (editingSize.current) return;
    setContent(v.content);
    setFamily(v.font_family);
    setSize(v.font_size_px);
    setColor(trackStatic(v.color, WHITE));
  }, [layer.id, v]);

  const debouncedCommit = useDebouncedCommit<LayerParamsPatch>(commit);

  return (
    <PropSection layerKind={layer.kind} sectionId="text" title={t("property_panel.text")}>
      <Field label={t("property_panel.content")}>
        <textarea
          className="app-input"
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
          onFocus={() => { editingSize.current = true; }}
          onBlur={() => { editingSize.current = false; }}
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
    </PropSection>
  );
}

function VideoClipFields({
  layer,
  v,
  commit,
}: {
  layer: LayerSummary;
  v: Extract<LayerSummary["params"], { kind: "VideoClip" }>;
  commit: Commit;
}) {
  const { t } = useTranslation();
  const [speed, setSpeed] = useState(v.speed);
  // While the speed field is being edited, suppress the prop→local resync so a
  // mid-typing debounced commit's round-trip can't clobber the in-progress edit.
  const editingSpeed = useRef(false);
  useEffect(() => {
    if (editingSpeed.current) return;
    setSpeed(v.speed);
  }, [layer.id, v]);

  return (
    <PropSection layerKind={layer.kind} sectionId="media" title={t("property_panel.media")}>
      <Field label={t("property_panel.speed")}>
        <AppNumberField
          step={0.05}
          min={0.1}
          max={4}
          value={speed}
          ariaLabel={t("property_panel.speed")}
          onValueChange={setSpeed}
          onCommit={(v) => commit({ kind: "VideoClip", speed: v })}
          onFocus={() => { editingSpeed.current = true; }}
          onBlur={() => { editingSpeed.current = false; }}
        />
      </Field>
    </PropSection>
  );
}

function VideoClipAdvancedFields({
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
  const [fadeInTc, setFadeInTc] = useState(() => formatTimecode(v.fade_in_us, fpsNum, fpsDen));
  const [fadeOutTc, setFadeOutTc] = useState(() => formatTimecode(v.fade_out_us, fpsNum, fpsDen));
  useEffect(() => {
    setFadeInTc(formatTimecode(v.fade_in_us, fpsNum, fpsDen));
    setFadeOutTc(formatTimecode(v.fade_out_us, fpsNum, fpsDen));
  }, [layer.id, v, fpsNum, fpsDen]);

  return (
    <>
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
    </>
  );
}

function ImageOverlayAdvancedFields({
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
  const [fadeInTc, setFadeInTc] = useState(() => formatTimecode(v.fade_in_us, fpsNum, fpsDen));
  const [fadeOutTc, setFadeOutTc] = useState(() => formatTimecode(v.fade_out_us, fpsNum, fpsDen));
  useEffect(() => {
    setFadeInTc(formatTimecode(v.fade_in_us, fpsNum, fpsDen));
    setFadeOutTc(formatTimecode(v.fade_out_us, fpsNum, fpsDen));
  }, [layer.id, v, fpsNum, fpsDen]);

  return (
    <>
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
    </>
  );
}

function BakeStatusLine({ layerId }: { layerId: string }) {
  const { t } = useTranslation();
  const status = useLayerBakeStatus(layerId);
  // A standing row only while a bake is in flight or failed — idle and ready
  // stay quiet (ready is the steady state; the timeline dot carries it).
  if (!status || status.phase === "ready") return null;
  const text =
    status.phase === "warming"
      ? t("property_panel.bake_warming", { done: status.done, total: status.total })
      : status.phase === "baking"
        ? t("property_panel.bake_baking", { done: status.done, total: status.total })
        : t("property_panel.bake_error");
  const cls = `prop-bake-status is-${status.phase}`;
  return <p className={cls}>{text}</p>;
}

function MotifFields({
  layer,
  v,
  commit,
  onMutated,
  tInLayerUs,
  playheadInSpan,
}: {
  layer: LayerSummary;
  v: Extract<LayerSummary["params"], { kind: "Motif" }>;
  commit: Commit;
  onMutated: () => Promise<void>;
  tInLayerUs: number;
  playheadInSpan: boolean;
}) {
  const { t } = useTranslation();

  const debouncedCommit = useDebouncedCommit<LayerParamsPatch>(commit);

  // Re-resolve the motif when the runtime catalog changes (e.g. deleting this
  // motif from the lifecycle row in the advanced bucket) so the props schema /
  // unknown-note stay in sync with `merged`, not a stale snapshot from mount.
  // Same notifier the lifecycle row rides.
  useSyncExternalStore(subscribeMotifCatalog, motifCatalogRevision);
  // The motif's prop schema drives the props section. A null lookup means
  // the placed motif_id isn't in the catalog (e.g. a removed built-in) — we
  // can still edit transform/opacity, but render a note instead of guessing
  // prop inputs.
  const motif = getMotif(v.motif_id);
  const propEntries = motif
    ? Object.entries(motif.manifest.props_schema)
    : [];

  // Partial props patch: send ONLY the changed key so the state actor's
  // key-wise props merge keeps all other keys untouched. Sending the full
  // spread risks a stale v.props racing against a concurrent field edit and
  // silently dropping the earlier write.
  const commitProp = (key: string, next: unknown) =>
    commit({ kind: "Motif", props: { [key]: next } });

  return (
    <>
      <BakeStatusLine layerId={layer.id} />
      <TransformSection layer={layer} scaleLinked={v.scale_linked} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
      {motif === null ? (
        <p className="meta">{t("property_panel.unknown_motif")}</p>
      ) : motif.hasParamsUi ? (
        // The Motif ships its own page — it owns the whole props surface,
        // including labels, grouping and order. The fallback form below stays
        // the default for every Motif that doesn't.
        <PropSection layerKind={layer.kind} sectionId="props" title={t("property_panel.props")}>
          <MotifParamsFrame
            layerId={layer.id}
            motifId={v.motif_id}
            manifest={motif.manifest}
            props={v.props}
            commit={(patch) => commit({ kind: "Motif", props: patch })}
          />
        </PropSection>
      ) : propEntries.length > 0 ? (
        <PropSection layerKind={layer.kind} sectionId="props" title={t("property_panel.props")}>
          {propEntries.map(([key, spec]) => (
            <MotifPropField
              key={key}
              propKey={key}
              spec={spec}
              value={v.props[key]}
              commit={{
                mode: "commit",
                onCommit: (next) => commitProp(key, next),
                onCommitDebounced: (next) =>
                  debouncedCommit({ kind: "Motif", props: { [key]: next } }),
              }}
            />
          ))}
        </PropSection>
      ) : null}
      {motif?.manifest.status === "draft" ? (
        // Entering a draft is intent to edit, so the source Section defaults
        // expanded (unlike the advanced bucket).
        <PropSection layerKind={layer.kind} sectionId="motif_source" title={t("property_panel.motif_source")}>
          <MotifSourcePanel motifId={v.motif_id} />
        </PropSection>
      ) : null}
    </>
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
/// source panel previews the editable copy. "Discard" swaps the layer back
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
      setErr(refusalText(e));
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
          {t("property_panel.motif_status.builtin")}
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
  const updateBlastRadius = (targetId: string) => {
    let count = 0;
    for (const track of useProjectStore.getState().summary?.tracks ?? []) {
      for (const l of track.layers) {
        if (l.kind !== "Motif") continue;
        const mid = (l.params as { motif_id?: string }).motif_id;
        if (mid === targetId || mid === motifId) count++;
      }
    }
    return count;
  };

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

/// In-app source editor for a selected DRAFT Motif layer. See docs/motifs.md.
/// Deliberately minimal: a plain textarea of the draft's full composed source
/// (manifest island + body). "Apply" funnels through `amendMotifDraft`, which
/// re-parses the island, forces the stable id, re-composes, and emits
/// `motifs:changed` → the catalog resyncs (new content_hash) → the canvas
/// preview re-captures. Only shown for drafts — editing an installed Motif goes
/// through `MotifLifecycleRow`, which seeds a draft and swaps the layer onto it.
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
      setErr(refusalText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="prop-motif-source">
      <p className="meta">{t("property_panel.motif_source_hint")}</p>
      <textarea
        className="prop-motif-source-text"
        aria-label={t("property_panel.motif_source")}
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

function ColorFields({
  layer,
  v,
  commit,
}: {
  layer: LayerSummary;
  v: Extract<LayerSummary["params"], { kind: "Color" }>;
  commit: Commit;
}) {
  const { t } = useTranslation();
  return (
    <PropSection layerKind={layer.kind} sectionId="color" title={t("property_panel.color")}>
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
          min={1}
          step={1}
          // width/height are u32 on the Rust side — min/round keep them positive
          // integers. Commit on debounce/Enter/blur (not every keystroke) — Base
          // UI self-buffers the typed text; onCommit avoids flooding the actor.
          onValueChange={() => {}}
          onCommit={(n) => commit({ kind: "Color", width: Math.round(n) })}
        />
      </Field>
      <Field label={t("property_panel.height")}>
        <AppNumberField
          value={v.height}
          ariaLabel={t("property_panel.height")}
          min={1}
          step={1}
          onValueChange={() => {}}
          onCommit={(n) => commit({ kind: "Color", height: Math.round(n) })}
        />
      </Field>
    </PropSection>
  );
}

function AudioFields({
  layer,
  v,
  commit,
  fpsNum,
  fpsDen,
  tInLayerUs,
  playheadInSpan,
  onMutated,
}: {
  layer: LayerSummary;
  v: Extract<LayerSummary["params"], { kind: "Audio" }>;
  commit: Commit;
  fpsNum: number;
  fpsDen: number;
  tInLayerUs: number;
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [fadeInTc, setFadeInTc] = useState(() => formatTimecode(v.fade_in_us, fpsNum, fpsDen));
  const [fadeOutTc, setFadeOutTc] = useState(() => formatTimecode(v.fade_out_us, fpsNum, fpsDen));
  // Primitive deps — a whole-params dep (`v`) would resync on EVERY project
  // refresh (fresh identity per summary) and clobber a fade field mid-typing.
  useEffect(() => {
    setFadeInTc(formatTimecode(v.fade_in_us, fpsNum, fpsDen));
    setFadeOutTc(formatTimecode(v.fade_out_us, fpsNum, fpsDen));
  }, [layer.id, v.fade_in_us, v.fade_out_us, fpsNum, fpsDen]);

  return (
    <PropSection layerKind={layer.kind} sectionId="audio" title={t("property_panel.audio")}>
      <InspectorAnimField layer={layer} desc={GAIN_DB} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
      <Field label={t("property_panel.fade_in")}>
        <AppInput
          value={fadeInTc}
          ariaLabel={t("property_panel.fade_in")}
          onValueChange={setFadeInTc}
          onBlur={() => {
            const us = parseTimecode(fadeInTc, fpsNum, fpsDen);
            if (us !== null && us !== v.fade_in_us) {
              commit({ kind: "Audio", fade_in_us: us });
            } else if (us === null) {
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
            if (us !== null && us !== v.fade_out_us) {
              commit({ kind: "Audio", fade_out_us: us });
            } else if (us === null) {
              setFadeOutTc(formatTimecode(v.fade_out_us, fpsNum, fpsDen));
            }
          }}
        />
      </Field>
    </PropSection>
  );
}

function AudioAdvancedFields({
  layer,
  v,
  commit,
  tInLayerUs,
  playheadInSpan,
  onMutated,
}: {
  layer: LayerSummary;
  v: Extract<LayerSummary["params"], { kind: "Audio" }>;
  commit: Commit;
  tInLayerUs: number;
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <>
      <InspectorAnimField layer={layer} desc={PAN} tInLayerUs={tInLayerUs} playheadInSpan={playheadInSpan} onMutated={onMutated} />
      <Field label={t("property_panel.role")}>
        <AppSelect
          value={v.role}
          ariaLabel={t("property_panel.role")}
          onValueChange={(next) => commit({ kind: "Audio", role: next as AudioRole })}
          options={AUDIO_ROLES.map((r) => ({ value: r, label: t(`audio_roles.${r}`) }))}
        />
      </Field>
      <Field label={t("property_panel.mute")}>
        <AppSwitch
          checked={v.mute}
          ariaLabel={t("property_panel.mute")}
          onCheckedChange={(next) => commit({ kind: "Audio", mute: next })}
        />
      </Field>
    </>
  );
}

const FONT_FAMILIES = [
  "Noto Sans SC",
  "Liberation Sans",
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
 * (sliders, color pickers) call this so we don't fire a backend command on
 * every pixel of slider movement; the actor would queue up and the UI
 * would feel laggy.
 */
function useDebouncedCommit<P>(commit: (p: P) => Promise<void>) {
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
