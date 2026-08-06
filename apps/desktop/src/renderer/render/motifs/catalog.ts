// Built-in motif catalog — thin renderer layer over src/shared/motifs/catalog.ts.
// Types and logic live once in the shared module (Rust-faithful); this file adds
// the React useSyncExternalStore subscription layer (setUserMotifs / subscribe /
// revision) that is renderer-only.
//
// Plan: docs/motifs.md

import {
  type PropSpec,
  type Manifest,
  BUILTIN_MANIFESTS,
  MotifCatalog,
  canonicalizePropsLenient as _sharedLenient,
  resolveMotifContentDurationUs,
} from "../../../shared/motifs/catalog";

// Re-export shared types/functions so consumers see a stable surface.
export type { PropSpec };
export { resolveMotifContentDurationUs };

/// Renderer alias — keeps all consumers compiling without change.
export type MotifManifest = Manifest;

export interface Motif {
  manifest: MotifManifest;
}

// ---------------------------------------------------------------------------
// Catalog state
// ---------------------------------------------------------------------------

const catalog = new MotifCatalog();

// --- catalog change notification (so React consumers re-render after
// `setUserMotifs` — a plain mutation otherwise). ---
let catalogRevision = 0;
const catalogSubscribers = new Set<() => void>();

/// Subscribe to catalog changes (a `setUserMotifs` call). Returns an unsubscribe fn.
/// Pair with `motifCatalogRevision` for React's `useSyncExternalStore`.
export function subscribeMotifCatalog(cb: () => void): () => void {
  catalogSubscribers.add(cb);
  return () => catalogSubscribers.delete(cb);
}

/// A monotonically increasing revision, bumped on every `setUserMotifs`. The
/// `getSnapshot` for `useSyncExternalStore`.
export function motifCatalogRevision(): number {
  return catalogRevision;
}

/// Replace the runtime user-Motif layer (from the backend `list_motifs` IPC).
/// Built-ins are always present and authoritative; this only adds/removes the
/// user entries. Idempotent — call it whenever the backend catalog changes.
export function setUserMotifs(manifests: MotifManifest[]): void {
  catalog.setUserManifests(manifests);
  catalogRevision += 1;
  for (const cb of catalogSubscribers) cb();
}

export function getMotif(id: string): Motif | null {
  const m = catalog.get(id);
  return m != null ? { manifest: m } : null;
}

export function listMotifs(): MotifManifest[] {
  return catalog.list();
}

// ---------------------------------------------------------------------------
// Adapters — keep (props, manifest) call signature so all consumers compile
// unchanged; delegate to the shared (manifest, props) functions.
// ---------------------------------------------------------------------------

/// Render-path prop canonicalizer that NEVER throws — drops unknown keys, fills
/// missing keys from defaults, and falls back to the default when a value fails
/// its spec. The strict `canonicalizeProps` (Rasterizer) stays on the
/// ADD/validation path; the render path uses this so a layer whose Motif's
/// `props_schema` changed under it (an in-place update) degrades gracefully
/// instead of rendering blank.
///
/// NOTE: argument order is (props, manifest) — intentionally opposite of the
/// shared function — to preserve the existing call sites unchanged.
export function canonicalizePropsLenient(
  props: Record<string, unknown>,
  manifest: MotifManifest,
): Record<string, unknown> {
  return _sharedLenient(manifest, props);
}

// Re-export BUILTIN_MANIFESTS for any code that references it directly.
export { BUILTIN_MANIFESTS };
