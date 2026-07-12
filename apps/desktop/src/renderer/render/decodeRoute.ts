// Decode-path resolvers over the per-source Decode Route. The DecodeRoute TYPE
// itself lives in src/shared/decode-route.ts (carried by both the main-process
// MediaItem and the renderer MediaSummary); it is re-exported here so existing
// renderer imports (`from "./decodeRoute"`) keep working. resolveDecode is the
// one place the route maps to decode paths. See docs/adr/0028 and CONTEXT.md.

import type { DecodeRoute } from "../../shared/decode-route";

export type { DecodeRoute } from "../../shared/decode-route";

export interface ResolvedDecode {
  route: DecodeRoute["route"];
  /** File preview decodes; null = not ready (no defensive fallback). */
  previewPath: string | null;
  /** File export decodes; null = not ready. */
  exportPath: string | null;
}

/** The one place the route maps to decode paths. Pure, persisted-only — the
 *  machine-specific bridge is layered on by previewPathLive. */
export function resolveDecode(media: {
  kind: string;
  path: string;
  decode_route: DecodeRoute;
}): ResolvedDecode {
  const r = media.decode_route;
  switch (r.route) {
    case "bypass":
      return { route: "bypass", previewPath: media.path, exportPath: media.path };
    case "direct-export":
      return { route: "direct-export", previewPath: r.quick_proxy, exportPath: media.path };
    case "proxied":
      // Preview prefers the lighter quick proxy, but falls back to the full
      // master when the quick proxy is absent (a clean H.264 short-GOP source is
      // perfectly previewable) — so a proxied source whose quick proxy was never
      // built or has been cleaned up still previews instead of going blank.
      return { route: "proxied", previewPath: r.quick_proxy ?? r.full_proxy, exportPath: r.full_proxy };
    case "native-sw":
      // Native-sw resolves identically to proxied: preview uses the lighter quick
      // proxy (or full proxy if unavailable), export uses the full proxy. The route
      // itself carries no original-vs-proxy decision; that is handled by the engine
      // resolver at decode time.
      return { route: "native-sw", previewPath: r.quick_proxy ?? r.full_proxy, exportPath: r.full_proxy };
  }
}

/** The 720p quick proxy path for a media, or null if none exists yet or the
 *  route is Bypass (which has no quick_proxy slot). Distinct from
 *  resolveDecode().previewPath, which can be the original (Bypass) or the
 *  source-res full proxy — the proxy AXIS wants the light quick proxy only. */
export function quickProxyPath(media: { decode_route: DecodeRoute }): string | null {
  const r = media.decode_route;
  switch (r.route) {
    case "bypass": return null;
    case "direct-export": return r.quick_proxy;
    case "proxied": return r.quick_proxy;
    case "native-sw": return r.quick_proxy;
  }
}

/** Preview path with the non-persisted session bridge layered on: when this
 *  machine confirmed it can decode the original (import probe), the original is
 *  usable until a proxy lands.
 *
 *  NOTE: the RENDER path uses the engine resolver at decode time. This helper
 *  survives as the Media Pool actionability gate (`mediaReadiness.ts`): "is there
 *  any preview source right now?" — a UI-readiness question distinct from engine
 *  tier selection. */
export function previewPathLive(
  media: { kind: string; path: string; decode_route: DecodeRoute },
  opts?: { previewDecodable?: boolean },
): string | null {
  const { previewPath } = resolveDecode(media);
  if (previewPath) return previewPath;
  if (opts?.previewDecodable) return media.path;
  return null;
}
