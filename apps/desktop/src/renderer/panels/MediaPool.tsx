import { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";

import { MediaThumbnail } from "./MediaThumbnail";
import { mediaReadiness, type ProxyState } from "./mediaReadiness";
import { MEDIA_DRAG_TYPE } from "../timeline/TrackLane";
import { AppInput } from "../components/AppInput";
import { formatTimecode } from "../frames";
import { type MediaSummary, generateQuickProxy } from "../ipc";
import { registerRevealMedia } from "../state/navigation";
import { useProxyPrefStore, setProxyOverride } from "../state/proxyPreferenceStore";
import { quickProxyPath } from "../render/decodeRoute";

/// The media-pool column doubles as the drop target for Explorer file
/// drags. HTML5 drag events fire because the OS-level drop interception is
/// off (the legacy `dragDropEnabled: false` rationale, load-bearing for the
/// timeline's internal DnD); under Electron the dropped Files' real
/// filesystem paths are surfaced through the main-process drop handler.
/// Internal media-item drags carry a custom MIME type, not "Files", and are
/// ignored here.
export function MediaDropZone({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [active, setActive] = useState(false);
  // dragenter/leave fire per descendant; track depth so the highlight
  // doesn't flicker while moving across children.
  const depth = useRef(0);
  const isFileDrag = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes("Files");
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
  fpsNum,
  fpsDen,
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

  // Palette "reveal in media pool": clear any filter (the target must be
  // in the filtered list), then flash + scroll the row into view.
  const [flashId, setFlashId] = useState<string | null>(null);
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
    // Reveal can arrive while the drawer is mid-open (~160ms width
    // transition, see the drawer's CSS), so an immediate scrollIntoView can
    // land off-target against the pre-transition layout. Defer past it.
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
        <h2>{t("media_pool.heading")}</h2>
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
      <h2>
        {t("media_pool.heading")} (
        {trimmed ? `${filtered.length}/${media.length}` : media.length})
      </h2>
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
              aria-disabled={!interactive}
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  MEDIA_DRAG_TYPE,
                  JSON.stringify({ mediaId: m.id, kind: m.kind }),
                );
                e.dataTransfer.effectAllowed = "copy";
              }}
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
                {/* Hover-revealed details overlay. Shows kind, duration,
                    dimensions, size. Hidden by default; opacity-faded
                    in on hover so the card stays calm in the resting
                    state. Importing / missing states swap in a pinned
                    status badge instead. */}
                <div className="media-item-details" aria-hidden="true">
                  <span
                    className={`media-kind kind-${m.kind.toLowerCase()}`}
                  >
                    {t(`kinds.${m.kind.toLowerCase()}`, {
                      defaultValue: m.kind,
                    })}
                  </span>
                  <span className="media-meta">
                    {m.duration_us !== null
                      ? t("media_pool.duration", {
                          value: formatTimecode(m.duration_us, fpsNum, fpsDen),
                        })
                      : t("media_pool.no_duration")}
                  </span>
                  {m.width !== null && m.height !== null && (
                    <span className="media-meta">
                      {m.width}×{m.height}
                    </span>
                  )}
                  <span className="media-meta">
                    {formatBytes(m.size_bytes, t)}
                  </span>
                </div>
                {/* Sibling of the aria-hidden .media-item-details above, NOT
                    nested inside it: that panel is pointer-events:none at
                    rest, which would trap this button from keyboard/AT
                    reach (axe aria-hidden-focus). Absolutely positioned in
                    its own corner; CSS reveals it on hover OR
                    focus-within so Tab can reach it. */}
                <ProxyPill media={m} />
                {reason === "importing" && (
                  <button
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
              <span
                className="media-item-name"
                title={m.label}
              >
                {m.label}
              </span>
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

function formatBytes(
  bytes: number,
  t: (k: string, v: Record<string, unknown>) => string,
): string {
  const KIB = 1024;
  const MIB = KIB * 1024;
  const GIB = MIB * 1024;
  if (bytes >= GIB) {
    return t("media_pool.size_gib", { value: (bytes / GIB).toFixed(2) });
  }
  if (bytes >= MIB) {
    return t("media_pool.size_mib", { value: (bytes / MIB).toFixed(2) });
  }
  if (bytes >= KIB) {
    return t("media_pool.size_kib", { value: (bytes / KIB).toFixed(0) });
  }
  return t("media_pool.size_bytes", { bytes });
}
