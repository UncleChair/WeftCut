// Prop canonicalizer for templates.
//
// `canonicalizeProps` fills missing props from schema defaults, rejects
// unknown keys, and emits a key-order-stable object so the canonical JSON
// form (used in raster cache keys) is deterministic. It mirrors the Rust
// `Template::canonicalize_props` validator.
//
// The old foreignObject SVG rasterizer that lived here was removed with the
// SVG render path (`harness.ts` + `svgRaster.ts` + `frameCache.ts`); only the
// canonicalizer survives. Importers: `MotifSprite.ts`, `exportBake.ts`.

import type { MotifManifest } from "./catalog";

/// Fill defaults for missing props, reject unknown keys. Returns a
/// new object with keys in `props_schema` insertion order so the
/// canonical JSON form is stable.
export function canonicalizeProps(
  raw: Record<string, unknown>,
  manifest: MotifManifest,
): Record<string, unknown> {
  for (const key of Object.keys(raw)) {
    if (!(key in manifest.props_schema)) {
      throw new Error(
        `canonicalizeProps: unknown prop "${key}" for template "${manifest.id}"`,
      );
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(manifest.props_schema)) {
    out[key] = raw[key] ?? spec.default;
  }
  return out;
}
