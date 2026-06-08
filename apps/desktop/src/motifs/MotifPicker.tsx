import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { formatTimecode, parseTimecode } from "../frames";
import {
  addMotif,
  listMotifs,
  MOTIFS_CHANGED_EVENT,
  writeMotifDraft,
  type PropSpec,
  type MotifSummary,
  type TrackSummary,
} from "../ipc";
import { captureMotifFramePngBlob } from "../render/motifs/host";
import { setUserMotifs, type MotifManifest } from "../render/motifs/catalog";
import { newDraftSource } from "../render/motifs/starterTemplate";

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

export function MotifPicker({
  onClose,
  onAdded,
  currentTimeUs,
  tracks,
  fpsNum,
  fpsDen,
}: Props) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<MotifSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reload = () => {
    listMotifs().then(
      (list) => {
        setTemplates(list);
        // Refresh the runtime frame-math catalog from the SAME fetch the picker
        // shows. The boot-time sync (main.tsx) is one-shot; without this, a Motif
        // the picker can add (it lists via this IPC) but the runtime catalog
        // doesn't know (stale since boot / boot-sync failed) would resolve to
        // null in the compositor/export and render blank until restart. Opening
        // the picker is a prerequisite for adding, so this keeps the two in sync.
        setUserMotifs(list as MotifManifest[]);
        setSelectedId((prev) => prev ?? list[0]?.id ?? null);
      },
      (e) => setError(String(e)),
    );
  };
  useEffect(() => {
    reload();
    let un: (() => void) | undefined;
    void listen(MOTIFS_CHANGED_EVENT, reload).then((u) => { un = u; });
    return () => { un?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            className="template-picker-new"
            onClick={async () => {
              const name = window.prompt(t("template_picker.new_prompt"), "My Motif");
              if (name == null || name.trim() === "") return;
              try {
                const { manifest, html } = newDraftSource(name.trim());
                const draftId = await writeMotifDraft(manifest, html);
                setSelectedId(draftId); // motifs:changed → reload() surfaces the card
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            {t("template_picker.new_button")}
          </button>
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
                  <MotifCardThumbnail template={tpl} />
                  <span className="template-card-name">{tpl.name}</span>
                  <span className="template-card-meta">
                    {tpl.size[0]}×{tpl.size[1]} · {formatTimecode(Math.round(tpl.default_duration_s * 1_000_000), fpsNum, fpsDen)}
                  </span>
                  <span className="template-card-id">{tpl.id}</span>
                  <span className={`template-card-status status-${tpl.status ?? "builtin"}`}>
                    {t(`template_picker.status.${tpl.status ?? "builtin"}`)}
                  </span>
                </button>
              ))}
            </div>

            <div className="template-picker-form">
              {selected ? (
                <MotifForm
                  key={selected.id}
                  template={selected}
                  currentTimeUs={currentTimeUs}
                  tracks={videoTracks}
                  fpsNum={fpsNum}
                  fpsDen={fpsDen}
                  onSubmit={async ({ tStartUs, props, trackId }) => {
                    setError(null);
                    try {
                      await addMotif({
                        motifId: selected.id,
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

function defaultPropsFor(template: MotifSummary): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(template.props_schema)) {
    out[key] = defaultPropValue(spec);
  }
  return out;
}

function MotifForm({
  template,
  currentTimeUs,
  tracks,
  fpsNum,
  fpsDen,
  onSubmit,
}: {
  template: MotifSummary;
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
      <MotifPreview
        template={template}
        props={debouncedProps}
        width={480}
        large
      />

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

/// Time (seconds) of the static preview frame. The picker shows a still, not an
/// animation — so capture the Motif's SETTLED state, not content-frame 0. An
/// animate-in Motif (a fade/slide-in with `fill: both` from opacity 0 — e.g. the
/// lower third) is invisible at t=0, which would render a blank card.
/// `content_duration_s` marks the end of the in-animation (the held poster
/// state), so it's the right still; a Motif without it (e.g. countdown, which
/// shows its starting number at t=0) captures at 0.
function posterTSec(template: MotifSummary): number {
  const cds = template.content_duration_s;
  return typeof cds === "number" && cds > 0 ? cds : 0;
}

/// Static still of a Motif's first frame, captured via a single CDP screenshot
/// (`captureMotifFramePngBlob`). Replaces the old SVG-harness + rAF loop —
/// CDP cost (~80ms) makes continuous animation impractical here, and the
/// picker's job is "show what this Motif looks like", not animate it.
function MotifPreview({
  template,
  props,
  width,
  large,
}: {
  template: MotifSummary;
  props: Record<string, unknown>;
  width: number;
  large?: boolean;
}) {
  const [w, h] = template.size;
  // Fixed 16:9 preview box of the given `width`, so a large or oddly-shaped
  // template can't blow up the display area. The template is scaled to CONTAIN
  // (whole thing visible, never cropped) and centered; the host's checkerboard
  // shows through the letterbox margins.
  const boxW = width;
  const boxH = Math.round((width * 9) / 16);
  const scale = Math.min(boxW / w, boxH / h);
  const tSec = posterTSec(template);
  const { t } = useTranslation();

  const urlRef = useRef<string | null>(null);
  const [pngUrl, setPngUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Capture a single still frame via CDP whenever the Motif identity, props,
  // or dimensions change. Cancellable to handle rapid prop edits.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    captureMotifFramePngBlob(template.id, tSec, props, w, h)
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setPngUrl(url);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
    // `props` identity: MotifForm debounces it (300ms) and MotifCardThumbnail
    // memoizes it, so a re-capture fires per settled edit — not per render. No storm.
  }, [template.id, tSec, props, w, h]);

  // Revoke the last blob URL on unmount.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    },
    [],
  );

  return (
    <div
      className={
        large
          ? "template-preview-host template-preview-large"
          : "template-preview-host"
      }
      style={{ width: boxW, height: boxH }}
    >
      {pngUrl && (
        <img
          src={pngUrl}
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
      {!pngUrl && !error && (
        <span
          className="template-preview-loading"
          role="status"
          aria-label={t("template_picker.preview_loading")}
        />
      )}
      {error && <span className="settings-error">{error}</span>}
    </div>
  );
}

/// Card-grid thumbnail. Renders the live preview at default props — same
/// component the form's large preview uses, so card and form stay visually
/// consistent.
function MotifCardThumbnail({ template }: { template: MotifSummary }) {
  const defaults = useMemo(() => defaultPropsFor(template), [template.id]);
  return <MotifPreview template={template} props={defaults} width={240} />;
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
