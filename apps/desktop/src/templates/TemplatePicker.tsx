import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  addTemplate,
  listTemplates,
  templatePreview,
  type PropSpec,
  type TemplateSummary,
  type TrackSummary,
} from "../ipc";
import { useHideMpvHost } from "../mpv/useHideMpvHost";

interface Props {
  onClose: () => void;
  onAdded: () => Promise<void>;
  /// Composition duration in microseconds, used as the default "insert at"
  /// time so the template appends after existing content instead of
  /// colliding at t=0.
  compositionDurationUs: number;
  /// Project's current tracks. The picker filters to Video tracks for the
  /// target dropdown — templates lower to PngSeq overlay nodes and would
  /// silently render nothing on an Audio/Subtitle lane.
  tracks: TrackSummary[];
}

/// `<select>` value when the user wants the picker to find-or-create the
/// shared "Overlay" track. Sent over IPC as `trackId: undefined` so the
/// backend's `ensure_overlay_track` path runs.
const AUTO_OVERLAY_SENTINEL = "__auto_overlay__";

export function TemplatePicker({
  onClose,
  onAdded,
  compositionDurationUs,
  tracks,
}: Props) {
  useHideMpvHost();
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Keyed by template id. `undefined` = not yet requested; string = data URL
  // ready to drop into <img src>; `null` = render failed and we fall back
  // to the iframe preview. Renders run serially against the shared
  // offscreen webview, so kicking off all 10 in parallel from JS still
  // queues at the Rust layer — that's fine, the card grid stays
  // responsive because each thumbnail's loading state is independent.
  const [thumbnails, setThumbnails] = useState<
    Record<string, string | null>
  >({});

  useEffect(() => {
    let cancelled = false;
    listTemplates().then(
      (list) => {
        if (cancelled) return;
        setTemplates(list);
        if (list.length > 0) setSelectedId(list[0].id);
        // Fire all renders concurrently. allSettled because one bad
        // template shouldn't poison the whole grid — the others still
        // get static thumbnails and the broken one falls back to iframe.
        for (const tpl of list) {
          templatePreview(tpl.id).then(
            (dataUrl) => {
              if (cancelled) return;
              setThumbnails((prev) => ({ ...prev, [tpl.id]: dataUrl }));
            },
            (e) => {
              if (cancelled) return;
              console.warn(`template preview for ${tpl.id} failed:`, e);
              setThumbnails((prev) => ({ ...prev, [tpl.id]: null }));
            },
          );
        }
      },
      (e) => setError(String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(
    () => templates?.find((tpl) => tpl.id === selectedId) ?? null,
    [templates, selectedId],
  );

  const videoTracks = useMemo(
    () => tracks.filter((tr) => tr.kind === "Video"),
    [tracks],
  );

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true">
      <div className="template-picker">
        <header>
          <h2>{t("template_picker.heading")}</h2>
          <button
            className="settings-close"
            onClick={onClose}
            aria-label={t("template_picker.close")}
          >
            ✕
          </button>
        </header>

        {error && <p className="settings-error">{error}</p>}

        {templates === null ? (
          <p className="settings-status">{t("template_picker.loading")}</p>
        ) : (
          <div className="template-picker-body">
            <div className="template-picker-list">
              {templates.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  className={
                    tpl.id === selectedId
                      ? "template-card template-card-selected"
                      : "template-card"
                  }
                  onClick={() => setSelectedId(tpl.id)}
                >
                  <TemplateCardThumbnail
                    template={tpl}
                    staticUrl={thumbnails[tpl.id]}
                  />
                  <span className="template-card-name">{tpl.name}</span>
                  <span className="template-card-meta">
                    {tpl.size[0]}×{tpl.size[1]} · {tpl.default_duration_s}s
                  </span>
                  <span className="template-card-id">{tpl.id}</span>
                </button>
              ))}
            </div>

            <div className="template-picker-form">
              {selected ? (
                <TemplateForm
                  key={selected.id}
                  template={selected}
                  compositionDurationUs={compositionDurationUs}
                  tracks={videoTracks}
                  onSubmit={async ({ tStartUs, props, trackId }) => {
                    setError(null);
                    try {
                      await addTemplate({
                        templateId: selected.id,
                        tStartUs,
                        props,
                        trackId,
                      });
                      await onAdded();
                      onClose();
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                />
              ) : (
                <p className="settings-status">{t("template_picker.empty")}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function defaultPropValue(spec: PropSpec): unknown {
  switch (spec.type) {
    case "string":
    case "color":
      return spec.default;
    case "number":
      return spec.default;
  }
}

function defaultPropsFor(template: TemplateSummary): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(template.props_schema)) {
    out[key] = defaultPropValue(spec);
  }
  return out;
}

function TemplateForm({
  template,
  compositionDurationUs,
  tracks,
  onSubmit,
}: {
  template: TemplateSummary;
  compositionDurationUs: number;
  tracks: TrackSummary[];
  onSubmit: (args: {
    tStartUs: number;
    props: Record<string, unknown>;
    trackId?: string;
  }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [propValues, setPropValues] = useState<Record<string, unknown>>(() =>
    defaultPropsFor(template),
  );
  const [insertAtSec, setInsertAtSec] = useState<number>(
    compositionDurationUs / 1_000_000,
  );
  // If an "Overlay" video track already exists, prefer it as the default
  // dropdown choice — the label is more honest than "(auto-create)" when
  // no creation will actually happen. Backend resolves either path to the
  // same outcome.
  const [trackChoice, setTrackChoice] = useState<string>(() => {
    const existingOverlay = tracks.find((tr) => tr.label === "Overlay");
    return existingOverlay?.id ?? AUTO_OVERLAY_SENTINEL;
  });
  const [busy, setBusy] = useState(false);

  const setProp = (key: string, value: unknown) =>
    setPropValues((prev) => ({ ...prev, [key]: value }));

  // Re-mounting the preview iframe on every keystroke would reset the
  // template's RAF-driven animations. Debounce until the user pauses typing.
  const debouncedProps = useDebounced(propValues, 300);

  const submit = async () => {
    setBusy(true);
    try {
      const tStartUs = Math.max(0, Math.round(insertAtSec * 1_000_000));
      const trackId =
        trackChoice === AUTO_OVERLAY_SENTINEL ? undefined : trackChoice;
      await onSubmit({ tStartUs, props: propValues, trackId });
    } finally {
      setBusy(false);
    }
  };

  const propKeys = Object.keys(template.props_schema);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h3>{t("template_picker.preview_heading")}</h3>
      <TemplatePreview template={template} props={debouncedProps} width={480} large />

      <h3>{t("template_picker.props_heading")}</h3>
      {propKeys.length === 0 ? (
        <p className="settings-status">{t("template_picker.no_props")}</p>
      ) : (
        propKeys.map((key) => (
          <PropField
            key={key}
            propKey={key}
            spec={template.props_schema[key]}
            value={propValues[key]}
            onChange={(v) => setProp(key, v)}
          />
        ))
      )}

      <h3>{t("template_picker.timing_heading")}</h3>
      <label className="template-picker-field">
        <span>{t("template_picker.insert_at")}</span>
        <input
          type="number"
          min={0}
          step={0.1}
          value={insertAtSec}
          onChange={(e) => setInsertAtSec(Number(e.target.value))}
        />
      </label>
      <label className="template-picker-field">
        <span>{t("template_picker.track_label")}</span>
        <select
          value={trackChoice}
          onChange={(e) => setTrackChoice(e.target.value)}
        >
          <option value={AUTO_OVERLAY_SENTINEL}>
            {t("template_picker.track_overlay_auto")}
          </option>
          {tracks.map((tr) => (
            <option key={tr.id} value={tr.id}>
              {tr.label ?? `track ${tr.id.slice(0, 8)}`}
            </option>
          ))}
        </select>
      </label>
      <p className="template-picker-hint">
        {t("template_picker.duration_hint", {
          seconds: template.default_duration_s,
        })}
      </p>

      <div className="template-picker-actions">
        <button type="submit" disabled={busy}>
          {busy
            ? t("template_picker.adding")
            : t("template_picker.add")}
        </button>
      </div>
    </form>
  );
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

function buildPreviewSrcDoc(
  template: TemplateSummary,
  props: Record<string, unknown>,
): string {
  // Mirrors the production raster path's __STYLE__ substitution so what the
  // picker shows matches what render-time emits.
  const styled = template.html.replace("__STYLE__", template.style);
  const propsJson = JSON.stringify(props ?? {});
  // Inject before </head> so window.__props__ is set before the body's
  // start() loop polls for it. Every shipped template has a <head>; the
  // <body> fallback is defensive in case a future template omits it.
  const inject = `<script>window.__props__ = ${propsJson};</script>`;
  if (styled.includes("</head>")) {
    return styled.replace("</head>", `${inject}</head>`);
  }
  return styled.replace("<body", `${inject}<body`);
}

/// Live preview of a template, rendered at its manifest-declared natural
/// size and CSS-scaled to `width`. Natural-size + transform-scale beats
/// shrinking the iframe directly because viewport units (vw/vh) are
/// relative to the iframe's logical size — shrinking would break layouts
/// designed at 1920×1080. Sandboxed to `allow-scripts` only so template
/// JS can animate without reaching Tauri APIs or this app's DOM.
function TemplatePreview({
  template,
  props,
  width,
  large,
}: {
  template: TemplateSummary;
  props: Record<string, unknown>;
  width: number;
  large?: boolean;
}) {
  const [w, h] = template.size;
  const scale = width / w;
  const scaledHeight = h * scale;
  const html = useMemo(
    () => buildPreviewSrcDoc(template, props),
    [template.id, template.html, template.style, JSON.stringify(props)],
  );
  return (
    <div
      className={
        large
          ? "template-preview-host template-preview-large"
          : "template-preview-host"
      }
      style={{ width, height: scaledHeight }}
    >
      <iframe
        srcDoc={html}
        sandbox="allow-scripts"
        title={`preview-${template.id}`}
        style={{
          width: w,
          height: h,
          transformOrigin: "top left",
          transform: `scale(${scale})`,
        }}
      />
    </div>
  );
}

/// Card-grid thumbnail. Prefers the statically-rendered PNG (pixel-accurate
/// to ffmpeg-emit output, cached after the first session), falling back to
/// the live iframe preview at default props while the render is in flight
/// or if it failed. The iframe path is the same component the form's large
/// preview uses, so a fallback render looks like before; it just animates
/// instead of being a static still.
function TemplateCardThumbnail({
  template,
  staticUrl,
}: {
  template: TemplateSummary;
  staticUrl: string | null | undefined;
}) {
  const [w, h] = template.size;
  const width = 240;
  const scale = width / w;
  const scaledHeight = h * scale;
  if (typeof staticUrl === "string") {
    return (
      <div
        className="template-preview-host"
        style={{ width, height: scaledHeight }}
      >
        <img
          src={staticUrl}
          alt={template.name}
          style={{ width, height: scaledHeight, display: "block" }}
        />
      </div>
    );
  }
  return (
    <TemplatePreview
      template={template}
      props={defaultPropsFor(template)}
      width={width}
    />
  );
}

function PropField({
  propKey,
  spec,
  value,
  onChange,
}: {
  propKey: string;
  spec: PropSpec;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  switch (spec.type) {
    case "string":
      return (
        <label className="template-picker-field">
          <span>{propKey}</span>
          <input
            type="text"
            value={typeof value === "string" ? value : ""}
            maxLength={spec.max_length}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      );
    case "color":
      return (
        <label className="template-picker-field">
          <span>{propKey}</span>
          <ColorInput
            value={typeof value === "string" ? value : spec.default}
            onChange={onChange}
          />
        </label>
      );
    case "number":
      return (
        <label className="template-picker-field">
          <span>{propKey}</span>
          <input
            type="number"
            value={typeof value === "number" ? value : spec.default}
            min={spec.min}
            max={spec.max}
            step={
              // Step heuristic: percent-style 0..100 → 1; small ranges (0..4) → 0.1
              spec.max !== undefined && spec.max - (spec.min ?? 0) <= 10
                ? 0.1
                : 1
            }
            onChange={(e) => onChange(Number(e.target.value))}
          />
        </label>
      );
  }
}

/// Color input that preserves any trailing alpha bits in the original default
/// even though `<input type="color">` only edits the RGB triplet. This keeps
/// captions-strip's translucent default (#000000cc) intact unless the user
/// changes the color — at which point alpha is lost. See the CSS comment in
/// `captions_strip/style.css` for the long version.
function ColorInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  // `<input type="color">` returns 6-char hex. Show 6 chars to the picker;
  // the form value carries whatever the original default had.
  const rgb = value.length >= 7 ? value.slice(0, 7) : value;
  return (
    <span className="template-picker-color">
      <input
        type="color"
        value={rgb}
        onChange={(e) => onChange(e.target.value)}
      />
      <code>{value}</code>
    </span>
  );
}
