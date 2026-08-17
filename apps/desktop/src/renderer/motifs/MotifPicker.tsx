import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderInputIcon, PlusIcon } from "lucide-react";
import { listen } from "@/bridge/events";
import { open as openDialog } from "@/bridge/dialog";
import { formatTimecode } from "../frames";
import { AppTimecodeField } from "../components/AppTimecodeField";
import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { AppSelect } from "../components/AppSelect";
import { Button } from "@/components/ui/button";
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
import { trackDisplayName } from "../lib/trackName";
import { MotifPropField } from "../properties/MotifPropFields";
import { captureMotifFramePngBlob } from "../render/motifs/host";
import { setUserMotifs, type MotifManifest } from "../render/motifs/catalog";
import { newDraftSource } from "../render/motifs/newDraftSource";

interface Props {
  onClose: () => void;
  onAdded: () => Promise<void>;
  /// Fired after "New Motif" auto-places the fresh draft at the playhead.
  /// The App selects the layer and reveals its (role-null, AB-hidden)
  /// auto-created overlay track, landing the user straight in the property
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

/// `<select>` value for "auto track". Sent over IPC as `trackId: undefined`,
/// which makes the `add_motif` handler spawn a fresh unnamed track for the
/// layer — its name is derived from its position (`lib/trackName.ts`).
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
  const [query, setQuery] = useState("");

  const aliveRef = useRef(true);
  const reload = () => {
    listMotifs().then(
      (list) => {
        if (!aliveRef.current) return;
        setMotifs(list);
        // Refresh the runtime frame-math catalog from the SAME fetch the picker
        // shows, so every Motif the picker can add also resolves in the
        // compositor/export. Startup seeds that catalog and a `motifs:changed`
        // listener keeps it fresh (both in `startup/initializeRenderer.ts`);
        // this covers a boot sync that failed or an event that was missed.
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
      // (otherwise the listener leaks for the renderer's lifetime).
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

  // Catalog search. Matches the id too: it's off the card (tooltip-only),
  // but agents quote ids in logs/chats and pasting one here should work.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "" || motifs === null) return motifs;
    return motifs.filter(
      (tpl) =>
        tpl.name.toLowerCase().includes(q) || tpl.id.toLowerCase().includes(q),
    );
  }, [motifs, query]);

  const createDraft = async () => {
    try {
      const name = untitledName(motifs ?? [], t("motif_picker.untitled_name"));
      const { manifest, html } = newDraftSource(name);
      const draftId = await writeMotifDraft(manifest, html);
      // Keeps the picker useful if the auto-place below fails: the draft's
      // card is already selected and the error shows in place.
      setSelectedId(draftId); // motifs:changed → reload() surfaces the card
      // Straight into the editing surface: place the draft at the playhead
      // (default props/duration, fresh overlay track), hand the new layer to
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
    >
        {error && <p className="settings-error">{error}</p>}

        {motifs === null || filtered === null ? (
          <p className="settings-status">{t("motif_picker.loading")}</p>
        ) : (
          <div className="motif-picker-body">
            <div className="motif-picker-catalog">
              {/* Media-pool-style management bar: search claims the free
                  width, the catalog actions (new draft / import) sit at the
                  trailing edge. Fixed sibling above the scrolling list. */}
              <div className="motif-picker-bar">
                <AppInput
                  type="search"
                  clearable
                  clearAriaLabel={t("motif_picker.search_clear")}
                  placeholder={t("motif_picker.search_placeholder")}
                  ariaLabel={t("motif_picker.search_placeholder")}
                  value={query}
                  onValueChange={setQuery}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && query !== "") {
                      // Consume: this Escape clears the search only; without
                      // stopPropagation the dialog would close too.
                      e.preventDefault();
                      e.stopPropagation();
                      setQuery("");
                    }
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={t("motif_picker.new_button")}
                  aria-label={t("motif_picker.new_button")}
                  onClick={() => void createDraft()}
                >
                  <PlusIcon size={14} aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={t("motif_picker.import_button")}
                  aria-label={t("motif_picker.import_button")}
                  onClick={() => void importFile()}
                >
                  <FolderInputIcon size={14} aria-hidden />
                </Button>
              </div>
              <div className="motif-picker-list">
                {filtered.length === 0 && (
                  <p className="settings-status">
                    {motifs.length === 0
                      ? t("motif_picker.empty")
                      : t("motif_picker.no_matches", { query: query.trim() })}
                  </p>
                )}
                {filtered.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    // The id matters to agents (MCP `add_motif`) and bug
                    // reports, not to picking — tooltip, not card real estate.
                    title={tpl.id}
                    className={
                      tpl.id === selectedId
                        ? "motif-card motif-card-selected"
                        : "motif-card"
                    }
                    onClick={() => setSelectedId(tpl.id)}
                  >
                    <MotifCardThumbnail motif={tpl} />
                    <span className="motif-card-title">
                      <span className="motif-card-name">{tpl.name}</span>
                      <span className={`motif-card-status status-${tpl.status ?? "builtin"}`}>
                        {t(`motif_picker.status.${tpl.status ?? "builtin"}`)}
                      </span>
                    </span>
                    <span className="motif-card-meta">
                      {tpl.size[0]}×{tpl.size[1]} · {formatTimecode(Math.round(tpl.default_duration_s * 1_000_000), fpsNum, fpsDen)}
                    </span>
                  </button>
                ))}
              </div>
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

/// Default name for a one-click draft: the localized base, or "base N" when
/// taken. Names aren't a uniqueness key anywhere (drafts get fresh ids), so
/// this is purely to keep the catalog legible until the user renames the
/// draft in its manifest island (the source editor they land in).
function untitledName(existing: MotifSummary[], base: string): string {
  const names = new Set(existing.map((m) => m.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!names.has(candidate)) return candidate;
  }
}

function defaultPropValue(spec: PropSpec): unknown {
  switch (spec.type) {
    case "string":
    case "color":
    case "enum":
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
  const [insertAtUs, setInsertAtUs] = useState<number>(currentTimeUs);
  // Default to auto-create. The backend spawns a fresh track on every
  // auto insert so consecutive motifs never collide on the same track —
  // picking an existing overlay track as the default would walk straight
  // back into the overlap invariant.
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
      const tStartUs = Math.max(0, insertAtUs);
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
          <MotifPropField
            key={key}
            propKey={key}
            spec={motif.props_schema[key]!}
            value={propValues[key]}
            commit={{ mode: "buffer", onChange: (v) => setProp(key, v) }}
          />
        ))
      )}

      <h3>{t("motif_picker.timing_heading")}</h3>
      <div className="motif-picker-field">
        <span>{t("motif_picker.insert_at")}</span>
        <AppTimecodeField
          valueUs={insertAtUs}
          fpsNum={fpsNum}
          fpsDen={fpsDen}
          ariaLabel={t("motif_picker.insert_at")}
          onCommit={setInsertAtUs}
        />
      </div>
      <div className="motif-picker-field">
        <span>{t("motif_picker.track_label")}</span>
        <AppSelect
          value={trackChoice}
          onValueChange={setTrackChoice}
          ariaLabel={t("motif_picker.track_label")}
          options={[
            {
              value: AUTO_OVERLAY_SENTINEL,
              label: t("motif_picker.track_overlay_auto"),
            },
            ...tracks.map((tr) => ({
              value: tr.id,
              label: trackDisplayName(tr, tracks, t),
            })),
          ]}
        />
      </div>
      <p className="motif-picker-hint">
        {t("motif_picker.duration_hint", {
          value: formatTimecode(Math.round(motif.default_duration_s * 1_000_000), fpsNum, fpsDen),
        })}
      </p>

      <div className="motif-picker-actions">
        <Button type="submit" variant="default" size="lg" disabled={busy}>
          {busy
            ? t("motif_picker.adding")
            : t("motif_picker.add")}
        </Button>
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

/// Static still of a Motif's poster frame (see `posterTSec`), captured via a
/// single CDP screenshot (`captureMotifFramePngBlob`).
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

/// Card-grid thumbnail. Renders the same still preview at default props that
/// the form's large preview uses, so card and form stay visually consistent.
function MotifCardThumbnail({ motif }: { motif: MotifSummary }) {
  const defaults = useMemo(() => defaultPropsFor(motif), [motif]);
  return <MotifPreview motif={motif} props={defaults} maxWidth={240} />;
}

