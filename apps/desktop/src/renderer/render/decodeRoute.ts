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
      // Option B: native-sw resolves identically to proxied — with the
      // experimental toggle OFF a ProRes clip previews via its proxy (no
      // regression). The toggle-ON "use the native-SW original" path is a later
      // overlay (forceStrategy), layered on top, not a resolveDecode change.
      return { route: "native-sw", previewPath: r.quick_proxy ?? r.full_proxy, exportPath: r.full_proxy };
  }
}

/** Preview path with the non-persisted session bridge layered on: when this
 *  machine confirmed it can decode the original (import probe), the original is
 *  usable until a proxy lands.
 *
 *  NOTE (D2): the RENDER path no longer flows through this — PixiPreview drives
 *  preview via the engine resolver (`resolveEngineTier`), where the bridge is
 *  now tier 2 (webcodecs-original). This helper survives only as the Media Pool
 *  actionability gate (`mediaReadiness.ts`): "is there any preview source right
 *  now?" — a UI-readiness question distinct from render tiering. */
export function previewPathLive(
  media: { kind: string; path: string; decode_route: DecodeRoute },
  opts?: { previewDecodable?: boolean },
): string | null {
  const { previewPath } = resolveDecode(media);
  if (previewPath) return previewPath;
  if (opts?.previewDecodable) return media.path;
  return null;
}
