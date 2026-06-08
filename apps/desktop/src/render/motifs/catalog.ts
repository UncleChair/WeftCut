// Built-in motif catalog. Manifests are imported as parsed JSON at build time.
// Motifs are keyed by their canonical `manifest.id` (kebab-case), not by their
// directory name (snake_case).
//
// Plan: docs/templates.md

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

const catalog = buildCatalog();

export function getMotif(id: string): Motif | null {
  return catalog.get(id) ?? null;
}

export function listMotifs(): MotifManifest[] {
  return [...catalog.values()].map((t) => t.manifest);
}

/// Resolve a motif's intrinsic content duration (µs) from its manifest +
/// the instance props. Mirrors Rust `resolve_motif_max_dur_us`: prefer the
/// `max_duration_prop` value (seconds, when finite & > 0), else `max_duration_s`,
/// else `null` (unbounded — no windowing, legacy "animate over layer width").
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
