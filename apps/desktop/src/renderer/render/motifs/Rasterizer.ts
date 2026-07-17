// Prop canonicalizer for motifs.
//
// `canonicalizeProps` fills missing props from schema defaults, rejects
// unknown keys, validates prop values, and emits a key-order-stable object
// (alphabetical — BTreeMap order) so the canonical JSON form (used in raster
// cache keys) is deterministic. It mirrors the Rust `Motif::canonicalize_props`
// validator. Logic lives once in src/shared/motifs/catalog.ts.
//
// NOTE: argument order here is (raw, manifest) — intentionally opposite of the
// shared function — to preserve the existing call sites unchanged.
//
// Only the prop canonicalizer lives here (the file name predates the removal
// of the SVG rasterizer that once shared it). Importers: `exportBake.ts`
// (and the canonicalizer twin-checks in catalog / motifFrameDescriptor
// tests).

import type { MotifManifest } from "./catalog";
import { canonicalizeProps as _sharedStrict } from "../../../shared/motifs/catalog";

/// Fill defaults for missing props, reject unknown keys, validate values.
/// Returns a new object with keys in alphabetical order (BTreeMap order) so
/// the canonical JSON form is stable.
///
/// Adapter: keeps the (raw, manifest) call signature so all consumers compile
/// unchanged; delegates to the shared (manifest, raw) strict canonicalizer.
export function canonicalizeProps(
  raw: Record<string, unknown>,
  manifest: MotifManifest,
): Record<string, unknown> {
  return _sharedStrict(manifest, raw);
}
