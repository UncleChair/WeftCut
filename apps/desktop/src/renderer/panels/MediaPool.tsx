import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  FolderInputIcon,
  LayoutGridIcon,
  ListIcon,
  RectangleHorizontalIcon,
} from "lucide-react";

import {
  MediaContextMenu,
  type MediaProxyMode,
} from "./MediaContextMenu";
import { MediaThumbnail } from "./MediaThumbnail";
import { mediaReadiness, type ProxyState } from "./mediaReadiness";
import { isOptimizing, type OptimizeInfo } from "./importOptimize";
import {
  MEDIA_DRAG_TYPE,
  mediaDragPayload,
  useMediaDragStore,
} from "../timeline/mediaDrag";
import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { Button } from "../components/ui/button";
import {
  type MediaPoolLayout,
  type MediaSummary,
  type TrackSummary,
  generateQuickProxy,
  analyzeShots,
  removeMedia,
} from "../ipc";
import { formatTimecode } from "../frames";
import { parseCommandError } from "../errors/parseCommandError";
import { registerRevealMedia } from "../state/navigation";
import { useProxyPrefStore, setProxyOverride } from "../state/proxyPreferenceStore";
import { setAppSettings, useMediaPoolLayout } from "../settings/appSettingsStore";
import { quickProxyPath } from "../render/decodeRoute";

function isFileDrag(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

const MAX_DRAG_PREVIEW_WIDTH_PX = 220;

/// Card arrangement options for the pool, persisted app-wide as
/// app_settings.media_pool_layout. `large` is the legacy one-card-per-row
/// layout; `grid` packs fixed-size cards into as many columns as fit;
/// `list` renders compact file-manager-style rows.
const LAYOUT_MODES: ReadonlyArray<{
  mode: MediaPoolLayout;
  Icon: typeof ListIcon;
}> = [
  { mode: "large", Icon: RectangleHorizontalIcon },
  { mode: "grid", Icon: LayoutGridIcon },
  { mode: "list", Icon: ListIcon },
];

interface MediaReference {
  layerId: string;
  layerLabel: string | null;
  layerKind: string | null;
  trackLabel: string | null;
  trackNumber: number | null;
  tStartUs: number | null;
}

interface MediaRemovalTarget {
  media: MediaSummary;
  references: MediaReference[];
}

interface MediaContextTarget {
  x: number;
  y: number;
  mediaId: string;
}

function layerMediaId(
  layer: TrackSummary["layers"][number],
): string | null {
  switch (layer.params.kind) {
    case "VideoClip":
    case "ImageOverlay":
    case "Audio":
      return layer.params.media_id;
    default:
      return null;
  }
}

/// Resolve backend layer ids to human-facing timeline context. With no
/// `onlyLayerIds`, this derives the live references for a media item before
/// opening the confirmation. With ids, it presents the authoritative
/// `MediaInUse.referenced_by` result returned by the guarded remove call.
function mediaReferencesFor(
  mediaId: string,
  tracks: readonly TrackSummary[],
  onlyLayerIds?: readonly string[],
): MediaReference[] {
  const requested = onlyLayerIds ? new Set(onlyLayerIds) : null;
  const found = new Set<string>();
  const references: MediaReference[] = [];

  tracks.forEach((track, trackIndex) => {
    track.layers.forEach((layer) => {
      const matches = requested
        ? requested.has(layer.id)
        : layerMediaId(layer) === mediaId;
      if (!matches || found.has(layer.id)) return;
      found.add(layer.id);
      references.push({
        layerId: layer.id,
        layerLabel: layer.label,
        layerKind: layer.params.kind,
        trackLabel: track.label,
        trackNumber: trackIndex + 1,
        tStartUs: layer.t_start_us,
      });
    });
  });

  // A project-change notification can race the command rejection. Keep every
  // authoritative id visible even when the stale renderer snapshot cannot yet
  // resolve its label/track.
  for (const layerId of onlyLayerIds ?? []) {
    if (found.has(layerId)) continue;
    references.push({
      layerId,
      layerLabel: null,
      layerKind: null,
      trackLabel: null,
      trackNumber: null,
      tStartUs: null,
    });
  }
  return references;
}

/// `MediaInUse` refusal → the authoritative referencing-layer ids, via the
/// shared IPC-rejection parser. Null when the failure is anything else.
function parseMediaInUseLayerIds(error: unknown): string[] | null {
  const parsed = parseCommandError(error);
  if (parsed?.error !== "MediaInUse") return null;
  return Array.isArray(parsed.referenced_by)
    ? parsed.referenced_by.filter((id): id is string => typeof id === "string")
    : [];
}

function mediaDragVisual(
  element: HTMLElement,
  clientX: number,
  clientY: number,
) {
  const rect = element.getBoundingClientRect();
  const scale = Math.min(1, MAX_DRAG_PREVIEW_WIDTH_PX / rect.width);
  return {
    clientX,
    clientY,
    width: rect.width * scale,
    height: rect.height * scale,
    pointerOffsetX: (clientX - rect.left) * scale,
    pointerOffsetY: (clientY - rect.top) * scale,
  };
}

/// Chromium's native drag image is a frozen translucent snapshot and cannot
/// animate into the timeline ghost. Replace it with a transparent pixel; the
/// app-owned MediaDragPreview below provides the visible, animatable surface.
function hideNativeDragPreview(dataTransfer: DataTransfer) {
  if (typeof dataTransfer.setDragImage !== "function") return;
  const pixel = document.createElement("div");
  pixel.style.cssText =
    "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(pixel);
  dataTransfer.setDragImage(pixel, 0, 0);
  window.setTimeout(() => pixel.remove(), 0);
}

function MediaDragPreview() {
  const active = useMediaDragStore((s) => s.active);
  const visual = useMediaDragStore((s) => s.visual);
  const absorptionTarget = useMediaDragStore((s) => s.absorptionTarget);
  const moveVisual = useMediaDragStore((s) => s.moveVisual);

  useEffect(() => {
    const followPointer = (e: DragEvent) => {
      // Chromium uses (0, 0) as an unavailable-coordinate sentinel for some
      // drag events. Keeping the last real point avoids a jump to the corner.
      if (e.clientX === 0 && e.clientY === 0) return;
      moveVisual(e.clientX, e.clientY);
    };
    window.addEventListener("drag", followPointer, true);
    window.addEventListener("dragover", followPointer, true);
    return () => {
      window.removeEventListener("drag", followPointer, true);
      window.removeEventListener("dragover", followPointer, true);
    };
  }, [moveVisual]);

  if (active === null || visual === null) return null;

  const absorbing = absorptionTarget !== null;
  const left = absorbing
    ? absorptionTarget.left
    : visual.clientX - visual.pointerOffsetX;
  const top = absorbing
    ? absorptionTarget.top
    : visual.clientY - visual.pointerOffsetY;
  const width = absorbing ? absorptionTarget.width : visual.width;
  const height = absorbing ? absorptionTarget.height : visual.height;

  return createPortal(
    <div
      data-testid="media-drag-preview"
      className={`media-drag-preview${absorbing ? " is-absorbing" : ""}`}
      style={{
        width,
        height,
        transform: `translate3d(${left}px, ${top}px, 0)`,
      }}
      aria-hidden="true"
    >
      <div className="media-drag-preview-thumb">
        <MediaThumbnail mediaId={active.mediaId} mediaKind={active.kind} />
      </div>
      <span className="media-drag-preview-name">{active.label}</span>
    </div>,
    document.body,
  );
}

/// The media-pool column doubles as the drop target for Explorer file
/// drags. HTML5 drag events fire because the OS-level drop interception is
/// off so the timeline's internal HTML5 drag-and-drop remains available;
/// the dropped Files' real filesystem paths are resolved by the preload's
/// `wireFileDrop` listener, not here (see `onDrop` below).
/// Internal media-item drags carry a custom MIME type, not "Files", and are
/// ignored here.
export function MediaDropZone({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [active, setActive] = useState(false);
  // dragenter/leave fire per descendant; track depth so the highlight
  // doesn't flicker while moving across children.
  const depth = useRef(0);
  return (
    <section
      className="media-pool"
      onDragEnter={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        depth.current += 1;
        setActive(true);
      }}
      onDragOver={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!isFileDrag(e)) return;
        depth.current -= 1;
        if (depth.current <= 0) {
          depth.current = 0;
          setActive(false);
        }
      }}
      onDrop={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        depth.current = 0;
        setActive(false);
        // Path resolution + import are handled in the preload's own `wireFileDrop`
        // window-level drop listener: there the dropped File objects are still
        // native-backed so `webUtils.getPathForFile` returns the real path (across
        // the contextBridge it returns '' — electron#44600). This handler only
        // clears the drop-highlight; it intentionally does no path work.
      }}
    >
      {children}
      {active && (
        <div className="media-pool-drop-overlay" aria-hidden="true">
          {t("media_pool.drop_to_import")}
        </div>
      )}
    </section>
  );
}

export function MediaPool({
  media,
  tracks,
  importing,
  proxyState,
  previewDecodable,
  optimizeById,
  fpsNum,
  fpsDen,
  onCancelImport,
  onMutated,
  onImportMedia,
}: {
  media: MediaSummary[];
  tracks: TrackSummary[];
  importing: ReadonlySet<string>;
  proxyState: ReadonlyMap<string, ProxyState>;
  previewDecodable: ReadonlySet<string>;
  /// Pool-wide optimization verdicts from useImportReadiness. Drives the
  /// background-optimizing dot and the codec-named reason in badge tooltips.
  optimizeById?: ReadonlyMap<string, OptimizeInfo>;
  fpsNum: number;
  fpsDen: number;
  onCancelImport: (mediaId: string) => Promise<void>;
  onMutated: () => Promise<void>;
  onImportMedia: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const layout = useMediaPoolLayout();
  const beginMediaDrag = useMediaDragStore((s) => s.begin);
  const endMediaDrag = useMediaDragStore((s) => s.end);
  const proxyOverrides = useProxyPrefStore((s) => s.overrides);

  // Palette "reveal in media pool": clear any filter (the target must be
  // in the filtered list), then flash + scroll the row into view.
  const [flashId, setFlashId] = useState<string | null>(null);
  // The media id whose shot analysis is currently running. One at a time is
  // enough for a pool action; reopening its menu shows the pending label and
  // disables a second kick.
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<MediaContextTarget | null>(
    null,
  );
  const [removalTarget, setRemovalTarget] =
    useState<MediaRemovalTarget | null>(null);
  useEffect(
    () =>
      registerRevealMedia((id) => {
        setQuery("");
        setFlashId(id);
      }),
    [],
  );
  useEffect(() => {
    if (flashId === null) return;
    // Reveal can reopen or activate this dock Panel. Defer until Dockview has
    // settled the new group geometry so scrollIntoView uses the final bounds.
    const scrollTimer = setTimeout(() => {
      document
        .querySelector(`[data-media-id="${CSS.escape(flashId)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }, 200);
    const timer = setTimeout(() => setFlashId(null), 1600);
    return () => {
      clearTimeout(scrollTimer);
      clearTimeout(timer);
    };
  }, [flashId]);
  // Coordinates are viewport-fixed. Close when any ancestor scrolls so the
  // menu never floats detached from the card it belongs to.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [contextMenu]);

  if (media.length === 0) {
    return (
      <div className="media-pool-inner media-pool-inner--empty">
        <p className="placeholder">{t("media_pool.empty")}</p>
        {/* Empty-state CTA: the same import action as the menu, made the
            obvious next step when the pool has nothing yet. */}
        <Button
          variant="default"
          size="lg"
          onClick={() => void onImportMedia()}
        >
          <FolderInputIcon size={14} aria-hidden />
          {t("actions.import_media")}
        </Button>
      </div>
    );
  }

  // Case-insensitive substring match on the human-facing label. Trim
  // so trailing whitespace from a paste doesn't kill all matches.
  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const filtered = needle
    ? media.filter((m) => m.label.toLowerCase().includes(needle))
    : media;
  const contextMedia = contextMenu
    ? (media.find((candidate) => candidate.id === contextMenu.mediaId) ?? null)
    : null;
  const contextReadiness = contextMedia
    ? mediaReadiness(contextMedia, importing, proxyState, {
        previewDecodable: previewDecodable.has(contextMedia.id),
      })
    : null;
  const contextReason =
    contextReadiness && !contextReadiness.ready
      ? contextReadiness.reason
      : null;
  const contextOverride = contextMedia
    ? proxyOverrides[contextMedia.id]
    : undefined;
  const contextProxyMode: MediaProxyMode | null =
    !contextMedia || contextMedia.decode_route.route === "bypass"
      ? null
      : contextOverride === undefined
        ? "auto"
        : contextOverride
          ? "proxy"
          : "original";

  return (
    <>
      <MediaDragPreview />
      {contextMenu && contextMedia && contextReadiness && (
        <MediaContextMenu
          key={`${contextMedia.id}:${contextMenu.x}:${contextMenu.y}`}
          x={contextMenu.x}
          y={contextMenu.y}
          media={contextMedia}
          proxyMode={contextProxyMode}
          canSetProxy={contextReason !== "importing"}
          canAnalyze={contextReadiness.ready}
          analyzing={analyzingId === contextMedia.id}
          canRemove={contextReason !== "importing"}
          onClose={() => setContextMenu(null)}
          onProxyModeChange={(mode) => {
            setContextMenu(null);
            const next =
              mode === "auto" ? null : mode === "proxy" ? true : false;
            if (next === true && quickProxyPath(contextMedia) === null) {
              void generateQuickProxy(contextMedia.id);
            }
            void setProxyOverride(contextMedia.id, next);
          }}
          onAnalyze={() => {
            setContextMenu(null);
            setAnalyzingId(contextMedia.id);
            void analyzeShots(contextMedia.id)
              .catch((error) => {
                console.warn("analyze shots failed:", error);
              })
              .finally(() =>
                setAnalyzingId((current) =>
                  current === contextMedia.id ? null : current,
                ),
              );
          }}
          onRemove={() => {
            setContextMenu(null);
            setRemovalTarget({
              media: contextMedia,
              references: mediaReferencesFor(contextMedia.id, tracks),
            });
          }}
        />
      )}
      {removalTarget && (
        <RemoveMediaDialog
          key={removalTarget.media.id}
          target={removalTarget}
          tracks={tracks}
          fpsNum={fpsNum}
          fpsDen={fpsDen}
          onReferencesChanged={(references) =>
            setRemovalTarget((current) =>
              current ? { ...current, references } : null,
            )
          }
          onClose={() => setRemovalTarget(null)}
          onRemoved={onMutated}
        />
      )}
      <div className="media-pool-search">
        {/* Same import action as the menu bar's Import (Mod+I), surfaced at
            the pool's leading edge so it's reachable without the menu. */}
        <button
          type="button"
          className="media-import-button"
          title={t("actions.import_media")}
          aria-label={t("actions.import_media")}
          onClick={() => void onImportMedia()}
        >
          <FolderInputIcon size={14} aria-hidden />
        </button>
        <AppInput
          type="search"
          clearable
          clearAriaLabel={t("media_pool.clear_search")}
          placeholder={t("media_pool.search_placeholder")}
          ariaLabel={t("media_pool.search_placeholder")}
          value={query}
          onValueChange={setQuery}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query !== "") {
              e.preventDefault();
              setQuery("");
            }
          }}
        />
        <div
          className="media-layout-switch"
          role="group"
          aria-label={t("media_pool.layout_label")}
        >
          {LAYOUT_MODES.map(({ mode, Icon }) => (
            <button
              key={mode}
              type="button"
              className={`media-layout-button${layout === mode ? " is-active" : ""}`}
              aria-pressed={layout === mode}
              title={t(`media_pool.layout_${mode}`)}
              onClick={() => void setAppSettings({ media_pool_layout: mode })}
            >
              <Icon size={14} aria-hidden />
            </button>
          ))}
        </div>
      </div>
      <div className="media-pool-inner">
        {filtered.length === 0 ? (
          <p className="placeholder">
            {t("media_pool.no_matches", { query: trimmed })}
          </p>
        ) : (
          <ul
            className={`media-list${layout !== "large" ? ` is-layout-${layout}` : ""}`}
          >
            {filtered.map((m) => {
              const readiness = mediaReadiness(m, importing, proxyState, {
                previewDecodable: previewDecodable.has(m.id),
              });
              const interactive = readiness.ready;
              const reason = readiness.ready ? null : readiness.reason;
              // Optimization is the second, orthogonal axis: `readiness`
              // answers "may the user drag this?", `optimize` answers "is a
              // background job still working on it?". The dot renders only on
              // the ready branch, so it can never stack on a blocking badge.
              const optimize = optimizeById?.get(m.id);
              const optimizeReasonText = optimize
                ? optimize.status === "checking"
                  ? t("import_proxy.checking_one")
                  : t(`import_proxy.${optimize.reason.key}`, {
                      codec: optimize.reason.codec,
                    })
                : null;
              const withReason = (hint: string) =>
                optimizeReasonText ? `${hint}\n${optimizeReasonText}` : hint;
              const showOptimizingDot =
                interactive && optimize != null && isOptimizing(optimize.status);
              return (
                <li
                  key={m.id}
                  data-media-id={m.id}
                  className={[
                    "media-item",
                    reason === "importing" ? "is-importing" : "",
                    reason === "missing" ? "is-missing" : "",
                    reason === "proxy_pending" ? "is-proxy-pending" : "",
                    reason === "proxy_failed" ? "is-proxy-failed" : "",
                    flashId === m.id ? "is-search-flash" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  draggable={interactive}
                  tabIndex={0}
                  aria-haspopup="menu"
                  aria-keyshortcuts="Shift+F10"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      mediaId: m.id,
                    });
                  }}
                  onKeyDown={(e) => {
                    if (
                      e.key !== "ContextMenu" &&
                      !(e.shiftKey && e.key === "F10")
                    ) {
                      return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setContextMenu({
                      x: rect.left + Math.min(32, rect.width / 2),
                      y: rect.top + Math.min(32, rect.height / 2),
                      mediaId: m.id,
                    });
                  }}
                  onDragStart={(e) => {
                    setContextMenu(null);
                    const payload = mediaDragPayload(m);
                    beginMediaDrag(
                      payload,
                      mediaDragVisual(e.currentTarget, e.clientX, e.clientY),
                    );
                    e.dataTransfer.setData(
                      MEDIA_DRAG_TYPE,
                      JSON.stringify(payload),
                    );
                    e.dataTransfer.effectAllowed = "copy";
                    hideNativeDragPreview(e.dataTransfer);
                  }}
                  onDragEnd={endMediaDrag}
                  title={
                    interactive
                      ? showOptimizingDot
                        ? withReason(t("media_pool.optimizing_hint"))
                        : t("media_pool.card_ready_hint")
                      : reason === "missing"
                        ? t("media_pool.missing_hint", { path: m.path })
                        : reason === "proxy_pending"
                          ? withReason(
                              t("media_pool.proxy_pending_hint", {
                                defaultValue: "Preview is being prepared…",
                              }),
                            )
                          : reason === "proxy_failed"
                            ? withReason(
                                t("media_pool.proxy_failed_hint", {
                                  defaultValue:
                                    "Preview could not be prepared. Re-import to retry.",
                                }),
                              )
                            : t("media_pool.importing")
                  }
                >
                  <div className="media-item-thumb">
                    <MediaThumbnail mediaId={m.id} mediaKind={m.kind} />
                    <span
                      className={`media-kind kind-${m.kind.toLowerCase()}`}
                    >
                      {t(`kinds.${m.kind.toLowerCase()}`, {
                        defaultValue: m.kind,
                      })}
                    </span>
                    <div className="media-item-metadata">
                      <span className="media-resolution-badge">
                        {m.width !== null && m.height !== null
                          ? `${m.width}×${m.height}`
                          : "—"}
                      </span>
                      <span className="media-duration-badge">
                        {m.duration_us !== null
                          ? formatMediaDuration(m.duration_us)
                          : t("media_pool.no_duration")}
                      </span>
                    </div>
                    {reason === "importing" && (
                      <button
                        type="button"
                        className="media-import-cancel"
                        onClick={async (e) => {
                          e.stopPropagation();
                          await onCancelImport(m.id);
                        }}
                        title={t("media_pool.importing_cancel_hint")}
                      >
                        {t("media_pool.importing")}
                      </button>
                    )}
                    {reason === "missing" && (
                      <span
                        className="media-missing-badge"
                        title={t("media_pool.missing_hint", { path: m.path })}
                      >
                        {t("media_pool.missing")}
                      </span>
                    )}
                    {reason === "proxy_pending" && (
                      <span
                        className="media-proxy-pending-badge"
                        title={withReason(
                          t("media_pool.proxy_pending_hint", {
                            defaultValue: "Preview is being prepared…",
                          }),
                        )}
                      >
                        {t("media_pool.proxy_pending", {
                          defaultValue: "Preparing…",
                        })}
                      </span>
                    )}
                    {reason === "proxy_failed" && (
                      <span
                        className="media-proxy-failed-badge"
                        title={withReason(
                          t("media_pool.proxy_failed_hint", {
                            defaultValue:
                              "Preview could not be prepared. Re-import to retry.",
                          }),
                        )}
                      >
                        {t("media_pool.proxy_failed", {
                          defaultValue: "Preview failed",
                        })}
                      </span>
                    )}
                    {/* Bare corner dot — this clip is fully editable. */}
                    {showOptimizingDot && (
                      <span
                        className="media-optimizing-dot"
                        role="status"
                        aria-label={t("media_pool.optimizing")}
                        title={withReason(t("media_pool.optimizing_hint"))}
                      />
                    )}
                  </div>
                  <span className="media-item-name" title={m.label}>
                    {m.label}
                  </span>
                  {layout === "list" && (
                    // Compact rows have no room for the hover-revealed metadata
                    // gradient (hidden in CSS); surface the duration inline
                    // instead, like a file manager's details column.
                    <span className="media-item-meta-inline">
                      {m.duration_us !== null
                        ? formatMediaDuration(m.duration_us)
                        : t("media_pool.no_duration")}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

function RemoveMediaDialog({
  target,
  tracks,
  fpsNum,
  fpsDen,
  onReferencesChanged,
  onClose,
  onRemoved,
}: {
  target: MediaRemovalTarget;
  tracks: readonly TrackSummary[];
  fpsNum: number;
  fpsDen: number;
  onReferencesChanged: (references: MediaReference[]) => void;
  onClose: () => void;
  onRemoved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const force = target.references.length > 0;

  const confirmRemoval = async () => {
    setRemoving(true);
    setError(null);
    try {
      await removeMedia(target.media.id, force);
    } catch (cause) {
      const referencedBy = parseMediaInUseLayerIds(cause);
      if (referencedBy !== null && !force) {
        onReferencesChanged(
          mediaReferencesFor(target.media.id, tracks, referencedBy),
        );
      } else {
        setError(
          t("media_pool.remove_failed", {
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      }
      setRemoving(false);
      return;
    }

    await onRemoved().catch(() => undefined);
    onClose();
  };

  return (
    <AppDialog
      title={t(
        force
          ? "media_pool.remove_in_use_title"
          : "media_pool.remove_title",
      )}
      onClose={() => {
        if (!removing) onClose();
      }}
      closeLabel={removing ? undefined : t("media_pool.remove_cancel")}
      panelClassName="settings-panel media-remove-dialog"
    >
      <div className="settings-body">
        <div className="settings-card">
          {force ? (
            <>
              <p className="settings-blurb media-remove-copy">
                {t("media_pool.remove_in_use_body", {
                  label: target.media.label,
                  count: target.references.length,
                })}
              </p>
              <ul className="media-remove-reference-list">
                {target.references.map((reference) => {
                  const kind = reference.layerKind
                    ? t(`kinds.${reference.layerKind.toLowerCase()}`, {
                        defaultValue: reference.layerKind,
                      })
                    : null;
                  const layerName =
                    reference.layerLabel?.trim() ||
                    kind ||
                    t("media_pool.remove_unknown_layer", {
                      id: reference.layerId.slice(0, 8),
                    });
                  const trackName =
                    reference.trackLabel?.trim() ||
                    (reference.trackNumber !== null
                      ? t("timeline.track_label", {
                          n: reference.trackNumber,
                        })
                      : t("media_pool.remove_unknown_track"));
                  return (
                    <li key={reference.layerId} title={reference.layerId}>
                      <span className="media-remove-reference-name">
                        {layerName}
                      </span>
                      <span className="media-remove-reference-meta">
                        {trackName}
                        {reference.tStartUs !== null
                          ? ` · ${formatTimecode(
                              reference.tStartUs,
                              fpsNum,
                              fpsDen,
                            )}`
                          : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="settings-warn media-remove-note">
                {t("media_pool.remove_in_use_note")}
              </p>
            </>
          ) : (
            <>
              <p className="settings-blurb media-remove-copy">
                {t("media_pool.remove_body", {
                  label: target.media.label,
                })}
              </p>
              <p className="settings-warn media-remove-note">
                {t("media_pool.remove_unused_note")}
              </p>
            </>
          )}
          {error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}
          <div className="export-actions">
            <Button size="lg" disabled={removing} onClick={onClose}>
              {t("media_pool.remove_cancel")}
            </Button>
            <Button
              variant="destructive"
              size="lg"
              disabled={removing}
              onClick={() => void confirmRemoval()}
            >
              {removing
                ? t("media_pool.removing")
                : force
                  ? t("media_pool.remove_force_confirm", {
                      count: target.references.length,
                    })
                  : t("media_pool.remove_confirm")}
            </Button>
          </div>
        </div>
      </div>
    </AppDialog>
  );
}

/// Compact duration used by media-pool cards. Minutes deliberately represent
/// the complete duration instead of wrapping at an hour: 1:01:05 is 61:05.
export function formatMediaDuration(durationUs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationUs / 1_000_000));
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${totalMinutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
}
