// The per-source Decode Route — persisted source of truth, hand-mirrored from
// the Rust enum (native/src/state/decode_route.rs). Variants fold in their
// readiness paths so route↔path contradictions are unrepresentable.
// See docs/adr/0028 and CONTEXT.md. resolveDecode (below) is added in Task 8.

export type DecodeRoute =
  | { route: "bypass" }
  | { route: "direct-export"; quick_proxy: string | null }
  | {
      route: "proxied";
      quick_proxy: string | null;
      full_proxy: string | null;
      format_version: number;
    };

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
      return { route: "proxied", previewPath: r.quick_proxy, exportPath: r.full_proxy };
  }
}

/** Preview path with the non-persisted session bridge layered on: when this
 *  machine confirmed it can decode the original (import probe), preview reads
 *  the original until a proxy lands. */
export function previewPathLive(
  media: { kind: string; path: string; decode_route: DecodeRoute },
  opts?: { previewDecodable?: boolean },
): string | null {
  const { previewPath } = resolveDecode(media);
  if (previewPath) return previewPath;
  if (opts?.previewDecodable) return media.path;
  return null;
}
