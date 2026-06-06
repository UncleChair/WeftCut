import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatTimecode, parseTimecode } from "../frames";
import {
  addTemplate,
  listTemplates,
  type PropSpec,
  type TemplateSummary,
  type TrackSummary,
} from "../ipc";
import { getTemplate } from "../render/templates/catalog";
import { TemplateHarness } from "../render/templates/harness";
import { previewLoopTimeSec } from "./previewLoop";

interface Props {
  onClose: () => void;
  onAdded: () => Promise<void>;
  /// Current playhead position in microseconds. Used as the default
  /// "insert at" time so the template lands wherever the user is
  /// actively looking, matching AE/Premiere behavior.
  currentTimeUs: number;
  /// Project's current tracks. The picker filters to Video tracks for the
  /// target dropdown — templates lower to PngSeq overlay nodes and would
  /// silently render nothing on an Audio/Subtitle lane.
  tracks: TrackSummary[];
  fpsNum: number;
  fpsDen: number;
}

/// `<select>` value when the user wants the picker to find-or-create the
/// shared "Overlay" track. Sent over IPC as `trackId: undefined` so the
/// backend's `ensure_overlay_track` path runs.
const AUTO_OVERLAY_SENTINEL = "__auto_overlay__";

export function TemplatePicker({
  onClose,
  onAdded,
  currentTimeUs,
  tracks,
  fpsNum,
  fpsDen,
}: Props) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listTemplates().then(
      (list) => {
        if (cancelled) return;
        setTemplates(list);
        const first = list[0];
        if (first) setSelectedId(first.id);
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
                  <TemplateCardThumbnail template={tpl} />
                  <span className="template-card-name">{tpl.name}</span>
                  <span className="template-card-meta">
                    {tpl.size[0]}×{tpl.size[1]} · {formatTimecode(Math.round(tpl.default_duration_s * 1_000_000), fpsNum, fpsDen)}
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
                  currentTimeUs={currentTimeUs}
                  tracks={videoTracks}
                  fpsNum={fpsNum}
                  fpsDen={fpsDen}
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
  currentTimeUs,
  tracks,
  fpsNum,
  fpsDen,
  onSubmit,
}: {
  template: TemplateSummary;
  currentTimeUs: number;
  tracks: TrackSummary[];
  fpsNum: number;
  fpsDen: number;
  onSubmit: (args: {
    tStartUs: number;
    props: Record<string, unknown>;
    // Explicit `| undefined` so the "auto track" sentinel (→ undefined) passes
    // straight through under `exactOptionalPropertyTypes`.
    trackId?: string | undefined;
  }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [propValues, setPropValues] = useState<Record<string, unknown>>(() =>
    defaultPropsFor(template),
  );
  const [insertAtTc, setInsertAtTc] = useState<string>(
    formatTimecode(currentTimeUs, fpsNum, fpsDen),
  );
  // Default to auto-create. The backend spawns a fresh Overlay track
  // on every auto insert so consecutive templates never collide on
  // the same track — picking an existing Overlay as the default would
  // walk straight back into the overlap invariant.
  const [trackChoice, setTrackChoice] = useState<string>(AUTO_OVERLAY_SENTINEL);
  const [busy, setBusy] = useState(false);

  const setProp = (key: string, value: unknown) =>
    setPropValues((prev) => ({ ...prev, [key]: value }));

  // Re-mounting the preview iframe on every keystroke would reset the
  // template's RAF-driven animations. Debounce until the user pauses typing.
  const debouncedProps = useDebounced(propValues, 300);

  const submit = async () => {
    setBusy(true);
    try {
      const tStartUs = Math.max(0, parseTimecode(insertAtTc, fpsNum, fpsDen) ?? 0);
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
      <TemplatePreview template={template} props={debouncedProps} width={480} large animate />

      <h3>{t("template_picker.props_heading")}</h3>
      {propKeys.length === 0 ? (
        <p className="settings-status">{t("template_picker.no_props")}</p>
      ) : (
        propKeys.map((key) => (
          <PropField
            key={key}
            propKey={key}
            spec={template.props_schema[key]!}
            value={propValues[key]}
            onChange={(v) => setProp(key, v)}
          />
        ))
      )}

      <h3>{t("template_picker.timing_heading")}</h3>
      <label className="template-picker-field">
        <span>{t("template_picker.insert_at")}</span>
        <input
          type="text"
          value={insertAtTc}
          onChange={(e) => setInsertAtTc(e.target.value)}
          onBlur={() => {
            const us = parseTimecode(insertAtTc, fpsNum, fpsDen);
            if (us !== null) {
              setInsertAtTc(formatTimecode(us, fpsNum, fpsDen));
            } else {
              setInsertAtTc(formatTimecode(currentTimeUs, fpsNum, fpsDen));
            }
          }}
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
          value: formatTimecode(Math.round(template.default_duration_s * 1_000_000), fpsNum, fpsDen),
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

/// Time (seconds) of the static preview frame. t=0 shows the template's first
/// frame — adequate for the picker, which only needs a representative still.
/// FOLLOW-UP: a scrub slider could let the user preview any t.
const PREVIEW_T_SEC = 0;
/// DEFAULT frame rate for the looping picker preview (the selected template's
/// large preview); the user can change it via the preview's fps input. ~20 fps
/// is smooth enough for the arc sweep while keeping the live re-render loop cheap
/// (one preview animates at a time). Bounds clamp absurd input.
const PREVIEW_FPS = 20;
const PREVIEW_FPS_MIN = 1;
const PREVIEW_FPS_MAX = 60;

/// Live preview of a template's CURRENT frame, captured through the SAME
/// `TemplateHarness` the timeline/export use — so picker, timeline, and export
/// agree pixel-for-pixel. The harness runs the template's `render(t)` inside a
/// sandboxed offscreen iframe and serializes the post-render `<svg>`; we then
/// display that SVG string in an `<img>` (the same plain-SVG path the
/// rasterizer relies on; foreignObject would taint).
///
/// One harness per preview instance. v1 ships a single built-in (countdown) so
/// the card grid has one card — a per-preview harness is fine. FOLLOW-UP: pool
/// or share a harness if the grid grows to many templates.
function TemplatePreview({
  template,
  props,
  width,
  large,
  animate,
}: {
  template: TemplateSummary;
  props: Record<string, unknown>;
  width: number;
  large?: boolean;
  animate?: boolean;
}) {
  const [w, h] = template.size;
  // Fixed 16:9 preview box of the given `width`, so a large or oddly-shaped
  // template can't blow up the display area. The template is scaled to CONTAIN
  // (whole thing visible, never cropped) and centered; the host's checkerboard
  // shows through the letterbox margins.
  const boxW = width;
  const boxH = Math.round((width * 9) / 16);
  const scale = Math.min(boxW / w, boxH / h);
  const { t } = useTranslation();

  const harnessRef = useRef<TemplateHarness | null>(null);
  const loadedRef = useRef<Promise<void> | null>(null);
  const urlRef = useRef<string | null>(null);
  const [svgUrl, setSvgUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Hover gates the animated preview: it plays only while the pointer is over
  // the preview (from t=0), and reverts to the static first frame on leave.
  // Only meaningful when `animate` (the large preview); cards never set it.
  const [hovered, setHovered] = useState(false);
  // User-adjustable playback frame rate for the hover loop (frames per second);
  // higher = smoother but more renders. Only surfaced on the animated preview.
  const [previewFps, setPreviewFps] = useState(PREVIEW_FPS);

  // (Re)load the harness whenever the template identity changes. The catalog's
  // `getTemplate` is a synchronous in-memory lookup returning the full
  // `Template` (with real font BYTES — the IPC summary only carries font
  // declarations, which the harness can't embed).
  useEffect(() => {
    const full = getTemplate(template.id);
    if (!full) {
      setError(`template not found in catalog: ${template.id}`);
      return;
    }
    const harness = new TemplateHarness();
    harnessRef.current = harness;
    setError(null);
    loadedRef.current = harness.load(full).catch((e) => {
      setError(String(e));
      throw e;
    });
    return () => {
      harness.dispose();
      harnessRef.current = null;
      loadedRef.current = null;
    };
  }, [template.id]);

  // Bind one frame's SVG (string) to the <img> as an object URL, revoking the
  // previous URL. Shared by the static and animated paths.
  // Stable (deps: []) — only touches the ref + React setters, all stable. Kept
  // stable so the render effect's async callbacks never capture a stale variant.
  const bindSvg = useCallback((svg: string) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = url;
    setSvgUrl(url);
    setError(null);
  }, []);

  // Render the current frame. When `animate` is true (the selected large
  // preview), the user is HOVERING the preview, and reduced motion isn't
  // requested, run a real-time loop: advance t over [0, duration) at
  // ~PREVIEW_FPS via rAF, re-rendering each frame through the same harness.
  // Otherwise render a single static frame at t=0 (cards, not-hovered,
  // reduced-motion). Awaits the in-flight load so the first render after a
  // template switch doesn't race the iframe mount.
  useEffect(() => {
    const harness = harnessRef.current;
    const loaded = loadedRef.current;
    if (!harness || !loaded) return;
    const durSec = template.default_duration_s;

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Static path: one frame at t=0 (cards, not hovered, or reduced-motion).
    if (!animate || !hovered || prefersReducedMotion) {
      let cancelled = false;
      loaded
        .then(() => harness.renderFrameSvg(PREVIEW_T_SEC, durSec, props))
        .then((svg) => {
          if (!cancelled) bindSvg(svg);
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        });
      return () => {
        cancelled = true;
      };
    }

    // Animated path: real-time loop.
    let cancelled = false;
    let rafId = 0;
    let rendering = false;
    let lastRenderMs = Number.NEGATIVE_INFINITY;
    const startMs = performance.now();
    const durMs = Math.max(1, durSec * 1000);
    const frameInterval = 1000 / previewFps;

    const tick = (now: number) => {
      if (cancelled) return;
      if (!rendering && now - lastRenderMs >= frameInterval) {
        lastRenderMs = now;
        rendering = true;
        const tSec = previewLoopTimeSec(now - startMs, durMs);
        loaded
          .then(() => harness.renderFrameSvg(tSec, durSec, props))
          .then((svg) => {
            rendering = false;
            if (!cancelled) bindSvg(svg);
          })
          .catch((e) => {
            rendering = false;
            if (!cancelled) setError(String(e));
          });
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
    // `props` identity changes on each edit; the parent debounces it. Including
    // it here restarts the loop (from t=0) with the new props on each debounced
    // edit — acceptable and keeps the preview truthful to the current props.
    // `hovered` starts/stops the loop: entering plays from t=0, leaving falls
    // back to the static branch above (resets to the first frame).
    // `previewFps` re-arms the loop with the new frame interval when changed.
  }, [template.id, template.default_duration_s, props, animate, hovered, previewFps]);

  // Revoke the last blob URL on unmount.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    },
    [],
  );

  return (
    <>
      <div
        className={
          large
            ? "template-preview-host template-preview-large"
            : "template-preview-host"
        }
        // `.template-preview-host` is `pointer-events: none` (so card clicks pass
        // through to the card button). The animated large preview needs to RECEIVE
        // hover, so re-enable pointer events on it; cards keep the default.
        style={{
          width: boxW,
          height: boxH,
          ...(animate ? { pointerEvents: "auto" as const } : null),
        }}
        onMouseEnter={animate ? () => setHovered(true) : undefined}
        onMouseLeave={animate ? () => setHovered(false) : undefined}
      >
        {svgUrl && (
          <img
            src={svgUrl}
            alt={`preview-${template.id}`}
            width={w}
            height={h}
            // Centered + contain-scaled inside the fixed 16:9 box. The host is
            // position:relative + overflow:hidden, so absolute centering with a
            // center transform-origin keeps the scaled template middle-anchored.
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              transformOrigin: "center",
              transform: `translate(-50%, -50%) scale(${scale})`,
            }}
          />
        )}
        {error && <span className="settings-error">{error}</span>}
      </div>
      {animate && (
        <label className="template-preview-fps">
          <span>{t("template_picker.preview_fps")}</span>
          <input
            type="number"
            min={PREVIEW_FPS_MIN}
            max={PREVIEW_FPS_MAX}
            step={1}
            value={previewFps}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n)) {
                setPreviewFps(
                  Math.min(PREVIEW_FPS_MAX, Math.max(PREVIEW_FPS_MIN, n)),
                );
              }
            }}
          />
        </label>
      )}
    </>
  );
}

/// Card-grid thumbnail. Renders the live preview at default props — same
/// component the form's large preview uses, so card and form stay visually
/// consistent.
function TemplateCardThumbnail({ template }: { template: TemplateSummary }) {
  const defaults = useMemo(() => defaultPropsFor(template), [template.id]);
  return <TemplatePreview template={template} props={defaults} width={240} />;
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
