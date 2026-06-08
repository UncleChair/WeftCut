// Built-in motif catalog. Manifests are imported as parsed JSON at build time.
// Motifs are keyed by their canonical `manifest.id` (kebab-case), not by their
// directory name (snake_case).
//
// Plan: docs/motifs.md

export type PropSpec =
  | { type: "string"; default: string; max_length?: number }
  | { type: "color"; default: string }
  | { type: "number"; default: number; min?: number; max?: number };

export interface MotifManifest {
  id: string;
  name: string;
  version: number;
  size: [number, number];
  default_duration_s: number;
  /// Optional hard cap on a placed layer's total length, in seconds. When
  /// present, the timeline forbids trimming/adding the motif longer than
  /// this; when absent the motif is freely extendable (holdable overlays).
  /// Static fallback — overridden live by `max_duration_prop` when that names
  /// a prop carrying a valid value.
  max_duration_s?: number;
  /// Optional name of a NUMBER prop whose current value (in seconds) is the
  /// layer's length cap. When set, editing that prop changes the cap live;
  /// falls back to `max_duration_s` when the prop is missing/invalid.
  max_duration_prop?: string;
  /// Fixed content/animation duration (seconds) that does NOT cap the layer.
  /// When set, the seekable content spans this many seconds; the layer stays
  /// freely extendable and frames past it clamp to the last content frame (a
  /// held, deduped tail). Distinct from `max_duration_s`, which caps the layer.
  /// Holdable overlays (e.g. the lower third) use this.
  content_duration_s?: number;
  props_schema: Record<string, PropSpec>;
  /// How many real browser frames `__motifRender` waits before capture.
  /// 2 (default, omitted) is safe for canvas/WebGL Motifs; CSS-only Motifs can
  /// set 1 to shave ~16 ms/frame. Clamped to {0,1,2} by the runtime.
  settle_rafs?: number;
  /// "builtin" | "installed" | "draft" — set by the backend `list_motifs`
  /// payload; absent for the statically-globbed built-ins (treated as builtin).
  status?: "builtin" | "installed" | "draft";
}

export interface Motif {
  manifest: MotifManifest;
}

const manifestModules = import.meta.glob("./builtin/*/manifest.json", {
  eager: true,
  import: "default",
}) as Record<string, MotifManifest>;

/// Strip `./builtin/<dir>/<file>` to `<dir>`.
function dirFromPath(path: string): string {
  const m = /\.\/builtin\/([^/]+)\//.exec(path);
  if (!m) throw new Error(`catalog: cannot extract motif dir from ${path}`);
  return m[1]!;
}

function buildCatalog(): Map<string, Motif> {
  const byId = new Map<string, Motif>();
  for (const [path, manifest] of Object.entries(manifestModules)) {
    const dir = dirFromPath(path);
    if (!manifest) {
      // eslint-disable-next-line no-console
      console.warn(`[weftcut/motifs] skipping ${dir}: missing manifest.json`);
      continue;
    }
    byId.set(manifest.id, { manifest });
  }
  return byId;
}

const builtinCatalog = buildCatalog();
let userCatalog = new Map<string, Motif>();
let merged = mergeCatalogs();

/// Built-ins win on id collision so an uploaded Motif can never shadow one.
function mergeCatalogs(): Map<string, Motif> {
  const out = new Map<string, Motif>(userCatalog);
  for (const [id, motif] of builtinCatalog) {
    if (userCatalog.has(id)) {
      // eslint-disable-next-line no-console
      console.warn(`[weftcut/motifs] user motif id "${id}" shadows a built-in; built-in kept`);
    }
    out.set(id, motif);
  }
  return out;
}

// --- catalog change notification (so React consumers re-render after `merged`
// actually updates — setUserMotifs is a plain mutation otherwise). ---
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
  userCatalog = new Map(manifests.map((manifest) => [manifest.id, { manifest }]));
  merged = mergeCatalogs();
  catalogRevision += 1;
  for (const cb of catalogSubscribers) cb();
}

export function getMotif(id: string): Motif | null {
  return merged.get(id) ?? null;
}

export function listMotifs(): MotifManifest[] {
  return [...merged.values()].map((t) => t.manifest);
}

/// Render-path prop canonicalizer that NEVER throws — drops unknown keys, fills
/// missing keys from defaults, and falls back to the default when a value fails
/// its spec. Mirrors Rust `Motif::canonicalize_props_lenient`. The strict
/// `canonicalizeProps` (Rasterizer) stays on the ADD/validation path; the render
/// path uses this so a layer whose Motif's `props_schema` changed under it (an
/// in-place update) degrades gracefully instead of rendering blank.
export function canonicalizePropsLenient(
  props: Record<string, unknown>,
  manifest: MotifManifest,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(manifest.props_schema)) {
    const v = props[key];
    out[key] = propValueValid(v, spec) ? v : spec.default;
  }
  return out;
}

function propValueValid(v: unknown, spec: PropSpec): boolean {
  switch (spec.type) {
    case "string":
      return typeof v === "string" && (spec.max_length == null || v.length <= spec.max_length);
    case "color":
      return typeof v === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v)
        && (spec.min == null || v >= spec.min) && (spec.max == null || v <= spec.max);
    default: {
      // Exhaustiveness guard: a new PropSpec variant makes this a compile error
      // until propValueValid handles it (rather than silently failing validation).
      const _exhaustive: never = spec;
      return Boolean(_exhaustive);
    }
  }
}

/// Resolve a motif's seekable content/animation duration (µs) from its manifest
/// + the instance props. Priority: `content_duration_s` (highest) →
/// `max_duration_prop` live value → `max_duration_s` → `null` (unbounded).
/// Intentionally diverges from Rust `resolve_motif_max_dur_us` (the layer-cap
/// resolver): `content_duration_s` is included here so holdable overlays report
/// a finite seek span, but is excluded there so the layer stays freely
/// extendable.
export function resolveMotifContentDurationUs(
  manifest: MotifManifest,
  props: Record<string, unknown>,
): number | null {
  // A fixed content/animation duration decoupled from the layer cap takes
  // precedence: it defines the seekable content span for holdable overlays.
  const cds = manifest.content_duration_s;
  if (typeof cds === "number" && Number.isFinite(cds) && cds > 0) {
    return Math.round(cds * 1_000_000);
  }
  const propName = manifest.max_duration_prop;
  if (propName) {
    const raw = props[propName];
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return Math.round(raw * 1_000_000);
    }
  }
  if (typeof manifest.max_duration_s === "number" && manifest.max_duration_s > 0) {
    return Math.round(manifest.max_duration_s * 1_000_000);
  }
  return null;
}
