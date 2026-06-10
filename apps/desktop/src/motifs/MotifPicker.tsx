import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { formatTimecode, parseTimecode } from "../frames";
import { AppDialog } from "../components/AppDialog";
import {
  addMotif,
  importMotif,
  listMotifs,
  MOTIFS_CHANGED_EVENT,
  writeMotifDraft,
  type PropSpec,
  type MotifSummary,
  type TrackSummary,
} from "../ipc";
import { captureMotifFramePngBlob } from "../render/motifs/host";
import { setUserMotifs, type MotifManifest } from "../render/motifs/catalog";
import { newDraftSource } from "../render/motifs/newDraftSource";

interface Props {
  onClose: () => void;
  onAdded: () => Promise<void>;
  /// Fired after "New Motif" auto-places the fresh draft at the playhead.
  /// The App selects the layer and reveals its (role-null, AB-hidden)
  /// auto-created Overlay track, landing the user straight in the property
  /// panel's source editor — the draft's real editing home (docs/motifs.md
  /// canvas-context editing).
  onDraftPlaced: (layerId: string) => void;
  /// Current playhead position in microseconds. Used as the default
  /// "insert at" time so the motif lands wherever the user is
  /// actively looking, matching AE/Premiere behavior.
  currentTimeUs: number;
  /// Project's current tracks. The picker filters to Video tracks for the
  /// target dropdown — motifs lower to PngSeq overlay nodes and would
  /// silently render nothing on an Audio/Subtitle lane.
  tracks: TrackSummary[];
  fpsNum: number;
  fpsDen: number;
  /// Composition canvas size in pixels. The form's large preview draws the
  /// canvas as its backdrop so the motif's true relative size and default
  /// placement (top-left at (0,0), natural pixels) are visible before adding.
  compWidth: number;
  compHeight: number;
}

/// `<select>` value when the user wants the picker to find-or-create the
/// shared "Overlay" track. Sent over IPC as `trackId: undefined` so the
/// backend's `ensure_overlay_track` path runs.
const AUTO_OVERLAY_SENTINEL = "__auto_overlay__";

export function MotifPicker({
  onClose,
  onAdded,
  onDraftPlaced,
  currentTimeUs,
  tracks,
  fpsNum,
  fpsDen,
  compWidth,
  compHeight,
}: Props) {
  const { t } = useTranslation();
  const [motifs, setMotifs] = useState<MotifSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const aliveRef = useRef(true);
  const reload = () => {
    listMotifs().then(
      (list) => {
        if (!aliveRef.current) return;
        setMotifs(list);
        // Refresh the runtime frame-math catalog from the SAME fetch the picker
        // shows. The boot-time sync (main.tsx) is one-shot; without this, a Motif
        // the picker can add (it lists via this IPC) but the runtime catalog
        // doesn't know (stale since boot / boot-sync failed) would resolve to
        // null in the compositor/export and render blank until restart. Opening
        // the picker is a prerequisite for adding, so this keeps the two in sync.
        setUserMotifs(list as MotifManifest[]);
        setSelectedId((prev) => prev ?? list[0]?.id ?? null);
      },
      (e) => {
        if (aliveRef.current) setError(String(e));
      },
    );
  };
  useEffect(() => {
    aliveRef.current = true;
    reload();
    let un: (() => void) | undefined;
    let cleaned = false;
    void listen(MOTIFS_CHANGED_EVENT, reload).then((u) => {
      // If the effect already cleaned up before listen() resolved, unlisten now
      // (otherwise the listener leaks for the webview's lifetime).
      if (cleaned) u();
      else un = u;
    });
    return () => {
      aliveRef.current = false;
      cleaned = true;
      un?.();
    };
    // reload is stable: it only closes over useState setters (referentially
    // stable) + aliveRef, so omitting it from deps is intentional and safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo(
    () => motifs?.find((tpl) => tpl.id === selectedId) ?? null,
    [motifs, selectedId],
  );

  const videoTracks = useMemo(
    () => tracks.filter((tr) => tr.kind === "Video"),
    [tracks],
  );

  const createDraft = async () => {
    const name = newName.trim();
    if (name === "") return;
    try {
      const { manifest, html } = newDraftSource(name);
      const draftId = await writeMotifDraft(manifest, html);
      // Keeps the picker useful if the auto-place below fails: the draft's
      // card is already selected and the error shows in place.
      setSelectedId(draftId); // motifs:changed → reload() surfaces the card
      // Straight into the editing surface: place the draft at the playhead
      // (default props/duration, fresh Overlay track), hand the new layer to
      // the App for select + reveal, and close the picker.
      const layerId = await addMotif({
        motifId: draftId,
        tStartUs: currentTimeUs,
      });
      await onAdded();
      onDraftPlaced(layerId);
      onClose();
    } catch (e) {
      setError(String(e));
    }
  };

  const importFile = async () => {
    try {
      const path = await openDialog({
        multiple: false,
        filters: [{ name: "Motif HTML", extensions: ["html"] }],
      });
      if (typeof path !== "string") return; // cancelled / multiple
      const draftId = await importMotif(path);
      setSelectedId(draftId); // motifs:changed → reload() surfaces the card
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <AppDialog
      title={t("motif_picker.heading")}
      onClose={onClose}
      closeLabel={t("motif_picker.close")}
      panelClassName="motif-picker"
      headerExtra={
        <>
          {newOpen ? (
            <form
              className="motif-picker-new-form"
              onSubmit={(e) => { e.preventDefault(); void createDraft(); }}
            >
              <input
                type="text"
                autoFocus
                value={newName}
                placeholder={t("motif_picker.new_name_placeholder")}
                aria-label={t("motif_picker.new_prompt")}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    // Consume: this Escape collapses the inline form only;
                    // without stopPropagation the dialog would close too.
                    e.stopPropagation();
                    setNewOpen(false);
                    setNewName("");
                  }
                }}
              />
              <button type="submit" disabled={newName.trim() === ""}>
                {t("motif_picker.new_create")}
              </button>
              <button type="button" onClick={() => { setNewOpen(false); setNewName(""); }}>
                {t("motif_picker.new_cancel")}
              </button>
            </form>
          ) : (
            <button className="motif-picker-new" onClick={() => setNewOpen(true)}>
              {t("motif_picker.new_button")}
            </button>
          )}
          {!newOpen && (
            <button className="motif-picker-new" onClick={importFile}>
              {t("motif_picker.import_button")}
            </button>
          )}
        </>
      }
    >
        {error && <p className="settings-error">{error}</p>}

        {motifs === null ? (
          <p className="settings-status">{t("motif_picker.loading")}</p>
        ) : (
          <div className="motif-picker-body">
            <div className="motif-picker-list">
              {motifs.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  className={
                    tpl.id === selectedId
                      ? "motif-card motif-card-selected"
                      : "motif-card"
                  }
                  onClick={() => setSelectedId(tpl.id)}
                >
                  <MotifCardThumbnail motif={tpl} />
                  <span className="motif-card-name">{tpl.name}</span>
                  <span className="motif-card-meta">
                    {tpl.size[0]}×{tpl.size[1]} · {formatTimecode(Math.round(tpl.default_duration_s * 1_000_000), fpsNum, fpsDen)}
                  </span>
                  <span className="motif-card-id">{tpl.id}</span>
                  <span className={`motif-card-status status-${tpl.status ?? "builtin"}`}>
                    {t(`motif_picker.status.${tpl.status ?? "builtin"}`)}
                  </span>
                </button>
              ))}
            </div>

            <div className="motif-picker-form">
              {selected ? (
                <MotifForm
                  key={selected.id}
                  motif={selected}
                  currentTimeUs={currentTimeUs}
                  tracks={videoTracks}
                  fpsNum={fpsNum}
                  fpsDen={fpsDen}
                  compWidth={compWidth}
                  compHeight={compHeight}
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
                <p className="settings-status">{t("motif_picker.empty")}</p>
              )}
            </div>
          </div>
        )}
    </AppDialog>
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

function defaultPropsFor(motif: MotifSummary): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(motif.props_schema)) {
    out[key] = defaultPropValue(spec);
  }
  return out;
}

function MotifForm({
  motif,
  currentTimeUs,
  tracks,
  fpsNum,
  fpsDen,
  compWidth,
  compHeight,
  onSubmit,
}: {
  motif: MotifSummary;
  currentTimeUs: number;
  tracks: TrackSummary[];
  fpsNum: number;
  fpsDen: number;
  compWidth: number;
  compHeight: number;
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
    defaultPropsFor(motif),
  );
  const [insertAtTc, setInsertAtTc] = useState<string>(
    formatTimecode(currentTimeUs, fpsNum, fpsDen),
  );
  // Default to auto-create. The backend spawns a fresh Overlay track
  // on every auto insert so consecutive motifs never collide on
  // the same track — picking an existing Overlay as the default would
  // walk straight back into the overlap invariant.
  const [trackChoice, setTrackChoice] = useState<string>(AUTO_OVERLAY_SENTINEL);
  const [busy, setBusy] = useState(false);

  const setProp = (key: string, value: unknown) =>
    setPropValues((prev) => ({ ...prev, [key]: value }));

  // Re-mounting the preview iframe on every keystroke would reset the
  // motif's RAF-driven animations. Debounce until the user pauses typing.
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

  const propKeys = Object.keys(motif.props_schema);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h3>
        {t("motif_picker.preview_heading")}
        <span className="motif-preview-canvas-size">
          {t("motif_picker.preview_canvas_size", {
            w: compWidth,
            h: compHeight,
          })}
        </span>
      </h3>
      <MotifPreview
        motif={motif}
        props={debouncedProps}
        maxWidth={480}
        large
        canvas={[compWidth, compHeight]}
      />

      <h3>{t("motif_picker.props_heading")}</h3>
      {propKeys.length === 0 ? (
        <p className="settings-status">{t("motif_picker.no_props")}</p>
      ) : (
        propKeys.map((key) => (
          <PropField
            key={key}
            propKey={key}
            spec={motif.props_schema[key]!}
            value={propValues[key]}
            onChange={(v) => setProp(key, v)}
          />
        ))
      )}

      <h3>{t("motif_picker.timing_heading")}</h3>
      <label className="motif-picker-field">
        <span>{t("motif_picker.insert_at")}</span>
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
      <label className="motif-picker-field">
        <span>{t("motif_picker.track_label")}</span>
        <select
          value={trackChoice}
          onChange={(e) => setTrackChoice(e.target.value)}
        >
          <option value={AUTO_OVERLAY_SENTINEL}>
            {t("motif_picker.track_overlay_auto")}
          </option>
          {tracks.map((tr) => (
            <option key={tr.id} value={tr.id}>
              {tr.label ?? `track ${tr.id.slice(0, 8)}`}
            </option>
          ))}
        </select>
      </label>
      <p className="motif-picker-hint">
        {t("motif_picker.duration_hint", {
          value: formatTimecode(Math.round(motif.default_duration_s * 1_000_000), fpsNum, fpsDen),
        })}
      </p>

      <div className="motif-picker-actions">
        <button type="submit" disabled={busy}>
          {busy
            ? t("motif_picker.adding")
            : t("motif_picker.add")}
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
function posterTSec(motif: MotifSummary): number {
  const cds = motif.content_duration_s;
  return typeof cds === "number" && cds > 0 ? cds : 0;
}

/// Static still of a Motif's first frame, captured via a single CDP screenshot
/// (`captureMotifFramePngBlob`). Replaces the old SVG-harness + rAF loop —
/// CDP cost (~80ms) makes continuous animation impractical here, and the
/// picker's job is "show what this Motif looks like", not animate it.
function MotifPreview({
  motif,
  props,
  maxWidth,
  large,
  canvas,
}: {
  motif: MotifSummary;
  props: Record<string, unknown>;
  maxWidth: number;
  large?: boolean;
  /// Composition `[width, height]`. When set, the box becomes the canvas
  /// (comp aspect-ratio) and the motif renders at the compositor's default
  /// placement — top-left at (0,0), natural pixels relative to the canvas —
  /// instead of being contain-zoomed to fill the box.
  canvas?: [number, number];
}) {
  const [w, h] = motif.size;
  const tSec = posterTSec(motif);
  const [compW, compH] = canvas ?? [0, 0];
  const canvasMode = compW > 0 && compH > 0;
  const { t } = useTranslation();

  const urlRef = useRef<string | null>(null);
  const [pngUrl, setPngUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Capture a single still frame via CDP whenever the Motif identity, props,
  // or dimensions change. Cancellable to handle rapid prop edits.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    captureMotifFramePngBlob(motif.id, tSec, props, w, h, undefined, motif.content_hash)
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
    // `content_hash` is in the deps so a same-id draft edit (new content, same id)
    // re-captures — the host reloads off the `?v=` cache-buster threaded above.
  }, [motif.id, motif.content_hash, tSec, props, w, h]);

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
          ? "motif-preview-host motif-preview-large"
          : "motif-preview-host"
      }
      // The host is a 16:9 box (CSS aspect-ratio) filling the parent's width,
      // capped here — so a large or oddly-shaped motif can't blow up the
      // display area, and the box can never overflow a narrower parent (the
      // card column, or the form pane in a narrow window). Canvas mode swaps
      // the aspect for the composition's, making the box the canvas itself.
      style={
        canvasMode
          ? { maxWidth, aspectRatio: `${compW} / ${compH}` }
          : { maxWidth }
      }
    >
      {pngUrl && (
        // Default: contain-scaled + centered by `.motif-preview-host img`
        // (object-fit); the checkerboard shows through the letterbox margins.
        // Canvas mode: inline percentages override that to the motif's true
        // size relative to the canvas, anchored top-left — mirroring the
        // compositor's default placement (Transform::default → x:0, y:0,
        // scale:1, Pixi top-left anchor). Oversized motifs clip at the box
        // edge exactly as the real canvas would.
        <img
          src={pngUrl}
          alt={`preview-${motif.id}`}
          width={w}
          height={h}
          style={
            canvasMode
              ? {
                  width: `${(w / compW) * 100}%`,
                  height: `${(h / compH) * 100}%`,
                }
              : undefined
          }
        />
      )}
      {!pngUrl && !error && (
        <span
          className="motif-preview-loading"
          role="status"
          aria-label={t("motif_picker.preview_loading")}
        />
      )}
      {error && <span className="settings-error">{error}</span>}
    </div>
  );
}

/// Card-grid thumbnail. Renders the live preview at default props — same
/// component the form's large preview uses, so card and form stay visually
/// consistent.
function MotifCardThumbnail({ motif }: { motif: MotifSummary }) {
  const defaults = useMemo(() => defaultPropsFor(motif), [motif.id]);
  return <MotifPreview motif={motif} props={defaults} maxWidth={240} />;
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
        <label className="motif-picker-field">
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
        <label className="motif-picker-field">
          <span>{propKey}</span>
          <ColorInput
            value={typeof value === "string" ? value : spec.default}
            onChange={onChange}
          />
        </label>
      );
    case "number":
      return (
        <label className="motif-picker-field">
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
    <span className="motif-picker-color">
      <input
        type="color"
        value={rgb}
        onChange={(e) => onChange(e.target.value)}
      />
      <code>{value}</code>
    </span>
  );
}
