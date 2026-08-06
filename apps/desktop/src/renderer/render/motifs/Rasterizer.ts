// Prop canonicalizer for motifs. Logic lives once in
// src/shared/motifs/catalog.ts; this file is the adapter over it.
//
// Name is historical: only the prop canonicalizer lives here. Importers:
// `exportBake.ts` (and the canonicalizer twin-checks in catalog /
// motifFrameDescriptor tests).

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
