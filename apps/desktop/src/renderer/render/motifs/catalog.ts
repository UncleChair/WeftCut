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
  /// The Motif ships its own parameter page (`params.html`). Stamped by the
  /// backend catalog payload — only the main process can stat the file — and
  /// tracked beside the manifest layer rather than inside it, because built-in
  /// manifests come from static JSON imports that never see the payload.
  hasParamsUi: boolean;
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

/// Ids whose backend payload reported a `params.html` companion. Kept OUTSIDE
/// `MotifCatalog` on purpose: `catalog.get` answers built-ins from the static
/// `BUILTIN_MANIFESTS` JSON, which the payload never replaces, so a flag stored
/// on the user manifest layer would be invisible for exactly the built-ins.
/// The payload lists built-ins too, so this set covers every entry.
let paramsUiIds: ReadonlySet<string> = new Set();

/// Replace the runtime user-Motif layer (from the backend `list_motifs` IPC).
/// Built-ins are always present and authoritative; this only adds/removes the
/// user entries. Idempotent — call it whenever the backend catalog changes.
export function setUserMotifs(manifests: MotifManifest[]): void {
  catalog.setUserManifests(manifests);
  paramsUiIds = new Set(manifests.filter((m) => m.has_params_ui === true).map((m) => m.id));
  catalogRevision += 1;
  for (const cb of catalogSubscribers) cb();
}

export function getMotif(id: string): Motif | null {
  const m = catalog.get(id);
  return m != null ? { manifest: m, hasParamsUi: paramsUiIds.has(id) } : null;
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
