import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  updateLayer,
  updateLayerParams,
  type GroupSummary,
  type LayerParamsPatch,
  type LayerSummary,
  type Rgba,
  type TrackSummary,
} from "../ipc";
// EffectsSection + effects-related ipc calls removed in P12-a.

interface Props {
  tracks: TrackSummary[];
  groups: GroupSummary[];
  selectedLayerId: string | null;
  onMutated: () => Promise<void>;
}

const COMMIT_DEBOUNCE_MS = 250;

export function PropertyPanel({
  tracks,
  groups,
  selectedLayerId,
  onMutated,
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
      <EnvelopeFields layer={layer} onMutated={onMutated} />
      <hr />
      <KindFields layer={layer} onMutated={onMutated} />
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
}: {
  layer: LayerSummary;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState<string>(layer.label ?? "");
  const [enabled, setEnabled] = useState(layer.enabled);
  const [tStartSec, setTStartSec] = useState(layer.t_start_us / 1_000_000);
  const [tEndSec, setTEndSec] = useState(layer.t_end_us / 1_000_000);

  // Reset form state when the user selects a different layer.
  useEffect(() => {
    setLabel(layer.label ?? "");
    setEnabled(layer.enabled);
    setTStartSec(layer.t_start_us / 1_000_000);
    setTEndSec(layer.t_end_us / 1_000_000);
  }, [layer.id, layer.label, layer.enabled, layer.t_start_us, layer.t_end_us]);

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
      <Field label={t("property_panel.t_start_s")}>
        <input
          type="number"
          step="0.01"
          value={tStartSec}
          onChange={(e) => setTStartSec(parseFloat(e.target.value) || 0)}
          onBlur={() => commit({ t_start_us: Math.round(tStartSec * 1_000_000) })}
        />
      </Field>
      <Field label={t("property_panel.t_end_s")}>
        <input
          type="number"
          step="0.01"
          value={tEndSec}
          onChange={(e) => setTEndSec(parseFloat(e.target.value) || 0)}
          onBlur={() => commit({ t_end_us: Math.round(tEndSec * 1_000_000) })}
        />
      </Field>
    </section>
  );
}

function KindFields({
  layer,
  onMutated,
}: {
  layer: LayerSummary;
  onMutated: () => Promise<void>;
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
      return <VideoClipFields layer={layer} v={layer.params} commit={commit} />;
    case "ImageOverlay":
      return (
        <ImageOverlayFields layer={layer} v={layer.params} commit={commit} />
      );
    case "Color":
      return <ColorFields v={layer.params} commit={commit} />;
    case "Audio":
      return <AudioFields v={layer.params} commit={commit} />;
    case "Subtitles":
      return <SubtitlesFields v={layer.params} />;
    case "Template":
      return null;
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
}: {
  layer: LayerSummary;
  v: Extract<LayerSummary["params"], { kind: "VideoClip" }>;
  commit: Commit;
}) {
  const { t } = useTranslation();
  const [opacity, setOpacity] = useState(v.opacity);
  const [scaleX, setScaleX] = useState(v.scale_x);
  const [scaleY, setScaleY] = useState(v.scale_y);
  const [x, setX] = useState(v.x);
  const [y, setY] = useState(v.y);
  const [speed, setSpeed] = useState(v.speed);
  const [fadeIn, setFadeIn] = useState(v.fade_in_us / 1_000_000);
  const [fadeOut, setFadeOut] = useState(v.fade_out_us / 1_000_000);
  useEffect(() => {
    setOpacity(v.opacity);
    setScaleX(v.scale_x);
    setScaleY(v.scale_y);
    setX(v.x);
    setY(v.y);
    setSpeed(v.speed);
    setFadeIn(v.fade_in_us / 1_000_000);
    setFadeOut(v.fade_out_us / 1_000_000);
  }, [layer.id, v]);

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
      <Field label={t("property_panel.fade_in_s")}>
        <input
          type="number"
          step={0.05}
          min={0}
          value={fadeIn}
          onChange={(e) => setFadeIn(Math.max(0, parseFloat(e.target.value) || 0))}
          onBlur={() =>
            commit({
              kind: "VideoClip",
              fade_in_us: Math.round(fadeIn * 1_000_000),
            })
          }
        />
      </Field>
      <Field label={t("property_panel.fade_out_s")}>
        <input
          type="number"
          step={0.05}
          min={0}
          value={fadeOut}
          onChange={(e) =>
            setFadeOut(Math.max(0, parseFloat(e.target.value) || 0))
          }
          onBlur={() =>
            commit({
              kind: "VideoClip",
              fade_out_us: Math.round(fadeOut * 1_000_000),
            })
          }
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
}: {
  layer: LayerSummary;
  v: Extract<LayerSummary["params"], { kind: "ImageOverlay" }>;
  commit: Commit;
}) {
  const { t } = useTranslation();
  const [opacity, setOpacity] = useState(v.opacity);
  const [x, setX] = useState(v.x);
  const [y, setY] = useState(v.y);
  const [fadeIn, setFadeIn] = useState(v.fade_in_us / 1_000_000);
  const [fadeOut, setFadeOut] = useState(v.fade_out_us / 1_000_000);
  useEffect(() => {
    setOpacity(v.opacity);
    setX(v.x);
    setY(v.y);
    setFadeIn(v.fade_in_us / 1_000_000);
    setFadeOut(v.fade_out_us / 1_000_000);
  }, [layer.id, v]);
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
      <Field label={t("property_panel.fade_in_s")}>
        <input
          type="number"
          step={0.05}
          min={0}
          value={fadeIn}
          onChange={(e) => setFadeIn(Math.max(0, parseFloat(e.target.value) || 0))}
          onBlur={() =>
            commit({
              kind: "ImageOverlay",
              fade_in_us: Math.round(fadeIn * 1_000_000),
            })
          }
        />
      </Field>
      <Field label={t("property_panel.fade_out_s")}>
        <input
          type="number"
          step={0.05}
          min={0}
          value={fadeOut}
          onChange={(e) =>
            setFadeOut(Math.max(0, parseFloat(e.target.value) || 0))
          }
          onBlur={() =>
            commit({
              kind: "ImageOverlay",
              fade_out_us: Math.round(fadeOut * 1_000_000),
            })
          }
        />
      </Field>
    </section>
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
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="prop-field">
      <span className="prop-field-label">{label}</span>
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
