import type { MediaSummary } from "../ipc";

/// Per-video proxy lifecycle, session-scoped. Driven by `media:job_*`
/// events filtered to proxy-like jobs. The map only carries entries
/// for media we've observed at least one event for; other videos derive
/// their state from durable paths on `MediaSummary` or default to
/// "pending" if no preview source is available yet.
export type ProxyState = "pending" | "ready" | "failed";

export type MediaReadiness =
  | { ready: true }
  | {
      ready: false;
      reason: "importing" | "missing" | "proxy_pending" | "proxy_failed";
    };

export interface MediaReadinessOptions {
  /// Session-scoped preview bridge: this machine successfully decoded the
  /// original, so preview can use `media.path` until the proxy lands.
  previewDecodable?: boolean;
}

/// Single source of truth for "may the user act on this media?" Used by
/// the Media Pool card (drag source) and by the Timeline drop handler
/// (defence in depth). For video, "ready" means there is a preview source
/// right now: quick/full proxy, bypassed original, or a session bridge.
/// `export_uses_original` alone is not enough because preview intentionally
/// waits for a quick proxy unless the bridge probe succeeded.
export function mediaReadiness(
  media: MediaSummary,
  importingIds: ReadonlySet<string>,
  proxyState: ReadonlyMap<string, ProxyState>,
  options: MediaReadinessOptions = {},
): MediaReadiness {
  if (importingIds.has(media.id)) {
    return { ready: false, reason: "importing" };
  }
  if (!media.available) {
    return { ready: false, reason: "missing" };
  }
  if (media.kind === "Video") {
    if (
      media.proxy_path ||
      media.quick_proxy_path ||
      media.proxy_bypassed ||
      options.previewDecodable === true
    ) {
      return { ready: true };
    }
    const s = proxyState.get(media.id);
    if (s === "ready") return { ready: true };
    if (s === "failed") return { ready: false, reason: "proxy_failed" };
    return { ready: false, reason: "proxy_pending" };
  }
  return { ready: true };
}
