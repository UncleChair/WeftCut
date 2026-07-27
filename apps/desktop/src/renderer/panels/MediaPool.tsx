import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { MediaThumbnail } from "./MediaThumbnail";
import { mediaReadiness, type ProxyState } from "./mediaReadiness";
import {
  MEDIA_DRAG_TYPE,
  mediaDragPayload,
  useMediaDragStore,
} from "../timeline/mediaDrag";
import { AppInput } from "../components/AppInput";
import { type MediaSummary, generateQuickProxy, analyzeShots } from "../ipc";
import { registerRevealMedia } from "../state/navigation";
import { useProxyPrefStore, setProxyOverride } from "../state/proxyPreferenceStore";
import { quickProxyPath } from "../render/decodeRoute";

function isFileDrag(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

const MAX_DRAG_PREVIEW_WIDTH_PX = 220;

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
/// under Electron the dropped Files' real
/// filesystem paths are surfaced through the main-process drop handler.
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
  importing,
  proxyState,
  previewDecodable,
  onCancelImport,
}: {
  media: MediaSummary[];
  importing: ReadonlySet<string>;
  proxyState: ReadonlyMap<string, ProxyState>;
  previewDecodable: ReadonlySet<string>;
  fpsNum: number;
  fpsDen: number;
  onCancelImport: (mediaId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const beginMediaDrag = useMediaDragStore((s) => s.begin);
  const endMediaDrag = useMediaDragStore((s) => s.end);

  // Palette "reveal in media pool": clear any filter (the target must be
  // in the filtered list), then flash + scroll the row into view.
  const [flashId, setFlashId] = useState<string | null>(null);
  // The media id whose shot analysis is currently running (drive-by "Analyze
  // shots"). One at a time is enough for a pool action; the button shows a
  // pending label and disables so a second click can't re-kick mid-run.
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
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

  if (media.length === 0) {
    return (
      <div className="media-pool-inner">
        <p className="placeholder">{t("media_pool.empty")}</p>
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

  return (
    <div className="media-pool-inner">
      <MediaDragPreview />
      <div className="media-pool-search">
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
      </div>
      {filtered.length === 0 ? (
        <p className="placeholder">
          {t("media_pool.no_matches", { query: trimmed })}
        </p>
      ) : (
        <ul className="media-list">
          {filtered.map((m) => {
            const readiness = mediaReadiness(m, importing, proxyState, {
              previewDecodable: previewDecodable.has(m.id),
            });
            const interactive = readiness.ready;
            const reason = readiness.ready ? null : readiness.reason;
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
              onDragStart={(e) => {
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
                  ? t("media_pool.drag_hint", {
                      defaultValue: "Drag onto a track to add",
                    })
                  : reason === "missing"
                    ? t("media_pool.missing_hint", { path: m.path })
                    : reason === "proxy_pending"
                      ? t("media_pool.proxy_pending_hint", {
                          defaultValue: "Preview is being prepared…",
                        })
                      : reason === "proxy_failed"
                        ? t("media_pool.proxy_failed_hint", {
                            defaultValue:
                              "Preview could not be prepared. Re-import to retry.",
                          })
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
                <ProxyPill media={m} />
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
                    title={t("media_pool.proxy_pending_hint", {
                      defaultValue: "Preview is being prepared…",
                    })}
                  >
                    {t("media_pool.proxy_pending", {
                      defaultValue: "Preparing…",
                    })}
                  </span>
                )}
                {reason === "proxy_failed" && (
                  <span
                    className="media-proxy-failed-badge"
                    title={t("media_pool.proxy_failed_hint", {
                      defaultValue:
                        "Preview could not be prepared. Re-import to retry.",
                    })}
                  >
                    {t("media_pool.proxy_failed", {
                      defaultValue: "Preview failed",
                    })}
                  </span>
                )}
              </div>
              <span className="media-item-name" title={m.label}>
                {m.label}
              </span>
              {interactive && m.kind === "Video" && (
                // Drive-by "Analyze shots": warms the deterministic shot-detector
                // cache (shared with the agent's analyze_clip / auto_split_by_shot)
                // via the main-side `analyze_shots` handler. Disabled + relabeled
                // while running; on a long clip the whole-source scan is inline, so
                // the pending state is the user's only progress cue for now.
                <button
                  type="button"
                  className="media-analyze-shots"
                  disabled={analyzingId === m.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setAnalyzingId(m.id);
                    void analyzeShots(m.id).finally(() => setAnalyzingId((cur) => (cur === m.id ? null : cur)));
                  }}
                  title={t("media_pool.analyze_shots_hint", {
                    defaultValue: "Detect shot cuts for this clip",
                  })}
                >
                  {analyzingId === m.id
                    ? t("media_pool.analyze_shots_running", { defaultValue: "Analyzing…" })
                    : t("media_pool.analyze_shots", { defaultValue: "Analyze shots" })}
                </button>
              )}
            </li>
          );
        })}
        </ul>
      )}
    </div>
  );
}

/// Per-clip proxy override: cycles Auto → Force proxy → Force original → Auto.
/// Hidden for Bypass (no quick_proxy slot). Choosing Force-proxy on a source
/// with no built proxy kicks an on-demand build.
function ProxyPill({ media }: { media: MediaSummary }) {
  const { t } = useTranslation();
  const override = useProxyPrefStore((s) => s.overrides[media.id]); // boolean | undefined
  if (media.decode_route.route === "bypass") return null;
  const state: "auto" | "proxy" | "original" =
    override === undefined ? "auto" : override ? "proxy" : "original";
  const next: boolean | null = state === "auto" ? true : state === "proxy" ? false : null;
  return (
    <button
      type="button"
      className={`media-proxy-pill is-${state}`}
      title={t(`media_pool.proxy_pill_${state}_hint`)}
      onClick={(e) => {
        e.stopPropagation();
        if (next === true && quickProxyPath(media) === null) void generateQuickProxy(media.id);
        void setProxyOverride(media.id, next);
      }}
    >
      {t(`media_pool.proxy_pill_${state}`)}
    </button>
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
