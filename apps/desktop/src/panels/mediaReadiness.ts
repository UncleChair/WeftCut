import type { MediaSummary } from "../ipc";

/// Per-video proxy lifecycle, session-scoped. Driven by `media:job_*`
/// events filtered to `kind === "proxy"`. The map only carries entries
/// for media we've observed at least one event for; other videos derive
/// their state from `MediaSummary.proxy_path` (non-null → ready) or
/// default to "pending" if the path is null and no event has arrived.
export type ProxyState = "pending" | "ready" | "failed";

export type MediaReadiness =
  | { ready: true }
  | {
      ready: false;
      reason: "importing" | "missing" | "proxy_pending" | "proxy_failed";
    };

/// Single source of truth for "may the user act on this media?" Used by
/// the Media Pool card (drag source) and by the Timeline drop handler
/// (defence in depth). Precedence: importing > missing > kind-specific
/// derivative checks > ready.
export function mediaReadiness(
  media: MediaSummary,
  importingIds: ReadonlySet<string>,
  proxyState: ReadonlyMap<string, ProxyState>,
): MediaReadiness {
  if (importingIds.has(media.id)) {
    return { ready: false, reason: "importing" };
  }
  if (!media.available) {
    return { ready: false, reason: "missing" };
  }
  if (media.kind === "Video") {
    if (media.proxy_path) return { ready: true };
    const s = proxyState.get(media.id);
    if (s === "ready") return { ready: true };
    if (s === "failed") return { ready: false, reason: "proxy_failed" };
    return { ready: false, reason: "proxy_pending" };
  }
  return { ready: true };
}
