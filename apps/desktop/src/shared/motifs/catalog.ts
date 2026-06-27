// Shared TS motif catalog — the single source of motif validation + duration
// resolution, consumed by both Electron-main and the renderer. (The Rust motif
// modules this once mirrored were deleted when motifs moved fully to TS.)
//
// Canonicalization rules (load-bearing — motif capture and the catalog must
// agree on these for a draft to validate + render identically):
//   - Key order: prop maps emitted with Object.keys sorted ascending.
//   - String max_length: counted as UNICODE SCALAR VALUES (Array.from(s).length),
//     not UTF-16 code units (str.length).
//   - Color regex: ^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$
//   - Number min/max: inclusive on both ends. Values must be finite JS numbers.
//   - resolveMotifTEndUs None-branch: Math.trunc.
//   - resolveMotifMaxDurUs EXCLUDES content_duration_s (the layer cap resolver);
//     resolveMotifContentDurationUs INCLUDES it (seek span).

import countdownJson from "./builtin/countdown/manifest.json";
import lowerThirdJson from "./builtin/lower-third/manifest.json";
import textFxJson from "./builtin/text-fx/manifest.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PropSpec =
  | { type: "string"; default: string; max_length?: number; multiline?: boolean }
  | { type: "color"; default: string }
  | { type: "number"; default: number; min?: number; max?: number }
  | { type: "enum"; default: string; options: string[] };

export interface Manifest {
  id: string;
  name: string;
  version: number;
  size: [number, number];
  default_duration_s: number;
  max_duration_s?: number | null;
  max_duration_prop?: string | null;
  content_duration_s?: number | null;
  props_schema: Record<string, PropSpec>;
  // Extra optional fields present in the renderer's MotifManifest — preserved
  // so Task 3 can re-export `MotifManifest = Manifest` without dropping fields.
  settle_rafs?: number;
  content_hash?: string;
  status?: "builtin" | "installed" | "draft";
  target_id?: string;
  fonts?: Array<{ family: string; file: string; weight?: number; style?: string }>;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class MotifPropError extends Error {
  constructor(public readonly detail: string) {
    super(detail);
    this.name = "MotifPropError";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const HEX_COLOR_RE =
  /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function specDefault(spec: PropSpec): unknown {
  return spec.default;
}

function validateProp(key: string, spec: PropSpec, value: unknown): void {
  switch (spec.type) {
    case "string": {
      if (typeof value !== "string") {
        throw new MotifPropError(`prop \`${key}\` must be a string`);
      }
      // Mirror Rust str::chars().count() — count Unicode scalar values, not UTF-16 units.
      if (spec.max_length != null && Array.from(value).length > spec.max_length) {
        throw new MotifPropError(`prop \`${key}\` exceeds max_length ${spec.max_length}`);
      }
      break;
    }
    case "color": {
      if (typeof value !== "string") {
        throw new MotifPropError(`prop \`${key}\` must be a color string`);
      }
      if (!HEX_COLOR_RE.test(value)) {
        throw new MotifPropError(`prop \`${key}\` is not a valid hex color: ${JSON.stringify(value)}`);
      }
      break;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new MotifPropError(`prop \`${key}\` must be a number`);
      }
      // min/max are INCLUSIVE, matching Rust (n < lo → error, n > hi → error).
      if (spec.min != null && value < spec.min) {
        throw new MotifPropError(`prop \`${key}\` out of range [${spec.min}, ${spec.max ?? null}]`);
      }
      if (spec.max != null && value > spec.max) {
        throw new MotifPropError(`prop \`${key}\` out of range [${spec.min ?? null}, ${spec.max}]`);
      }
      break;
    }
    case "enum": {
      if (typeof value !== "string") {
        throw new MotifPropError(`prop \`${key}\` must be an enum string`);
      }
      if (!spec.options.includes(value)) {
        throw new MotifPropError(`prop \`${key}\` value ${JSON.stringify(value)} is not one of the enum options`);
      }
      break;
    }
  }
}

function propValueValid(key: string, spec: PropSpec, value: unknown): boolean {
  try {
    validateProp(key, spec, value);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Strict prop canonicalizer. Mirrors Rust `Motif::canonicalize_props`.
 * - null/undefined provided → treated as empty object (all defaults).
 * - Non-object (not null) → throws MotifPropError.
 * - Unknown keys → throws MotifPropError.
 * - Missing keys → filled from schema defaults.
 * - Keys in the returned object are sorted alphabetically (BTreeMap order).
 */
export function canonicalizeProps(
  manifest: Manifest,
  provided: unknown,
): Record<string, unknown> {
  // null/undefined → use all defaults (mirrors Rust Null branch)
  const normalised = provided == null ? {} : provided;
  if (typeof normalised !== "object" || Array.isArray(normalised)) {
    throw new MotifPropError("props must be a JSON object");
  }
  const providedMap = normalised as Record<string, unknown>;

  // Reject unknown keys — typos shouldn't silently pass.
  for (const k of Object.keys(providedMap)) {
    if (!(k in manifest.props_schema)) {
      throw new MotifPropError(`unknown prop \`${k}\` — not in manifest props_schema`);
    }
  }

  // Build BTreeMap-ordered output: sort schema keys ascending.
  const sortedKeys = Object.keys(manifest.props_schema).sort();
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const spec = manifest.props_schema[key]!;
    const value = key in providedMap ? providedMap[key] : specDefault(spec);
    validateProp(key, spec, value);
    out[key] = value;
  }
  return out;
}

/**
 * Lenient prop canonicalizer. Mirrors Rust `Motif::canonicalize_props_lenient`.
 * Never throws. Unknown keys are dropped; missing keys filled from defaults;
 * values that fail validation fall back to their default.
 * Keys in the returned object are sorted alphabetically (BTreeMap order).
 */
export function canonicalizePropsLenient(
  manifest: Manifest,
  provided: unknown,
): Record<string, unknown> {
  const providedMap =
    provided != null && typeof provided === "object" && !Array.isArray(provided)
      ? (provided as Record<string, unknown>)
      : {};

  const sortedKeys = Object.keys(manifest.props_schema).sort();
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const spec = manifest.props_schema[key]!;
    const candidate = providedMap[key];
    const valid = candidate !== undefined && propValueValid(key, spec, candidate);
    out[key] = valid ? candidate : specDefault(spec);
  }
  return out;
}

/**
 * Resolve a motif layer's length cap (µs) from its manifest + current props.
 * Mirrors Rust `resolve_motif_max_dur_us` in native/src/motifs/catalog.rs.
 *
 * EXCLUDES `content_duration_s` — that field does NOT cap the layer (freely
 * extendable holdable overlays). Use `resolveMotifContentDurationUs` for the
 * seekable content span.
 *
 * Resolution order:
 *   1. If `max_duration_prop` names a prop carrying a finite, positive number
 *      → that value (s → µs), rounded.
 *   2. Otherwise, `max_duration_s` (if positive) → µs, rounded.
 *   3. Otherwise, null (unbounded).
 */
export function resolveMotifMaxDurUs(
  manifest: Manifest,
  props: Record<string, unknown>,
): number | null {
  if (manifest.max_duration_prop) {
    const raw = props[manifest.max_duration_prop];
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return Math.round(raw * 1_000_000);
    }
  }
  if (typeof manifest.max_duration_s === "number" && manifest.max_duration_s > 0) {
    return Math.round(manifest.max_duration_s * 1_000_000);
  }
  return null;
}

/**
 * Compute the layer's end time for `add_motif`. Mirrors Rust
 * `resolve_motif_t_end_us` in native/src/commands/motifs.rs.
 *
 * When t_end_us is null, the duration is derived as:
 *   Math.trunc(default_duration_s * 1_000_000) + t_start_us
 * TRUNCATION (Math.trunc) mirrors the Rust `as i64` cast (not round).
 *
 * When max_duration_us is present and the computed length exceeds it,
 * the result is clamped to t_start_us + max_duration_us.
 */
export function resolveMotifTEndUs(
  tStartUs: number,
  tEndUs: number | null,
  defaultDurationS: number,
  maxDurUs: number | null,
): number {
  let end: number;
  if (tEndUs !== null) {
    end = tEndUs;
  } else {
    // Mirror Rust: (default_duration_s * 1_000_000.0) as i64 → truncate.
    const durationUs = Math.trunc(defaultDurationS * 1_000_000);
    end = tStartUs + durationUs;
  }
  // No saturating_add (Rust): JS numbers are exact to 2^53, safe for realistic µs timestamps; diverges only on absurd values.
  if (maxDurUs !== null && end - tStartUs > maxDurUs) {
    return tStartUs + maxDurUs;
  }
  return end;
}

/**
 * Resolve the motif's seekable content/animation duration (µs).
 * Mirrors the renderer's `resolveMotifContentDurationUs`.
 * INCLUDES `content_duration_s` (intentionally diverges from
 * `resolveMotifMaxDurUs` which excludes it).
 *
 * Priority: content_duration_s → max_duration_prop live value →
 *           max_duration_s → null.
 */
export function resolveMotifContentDurationUs(
  manifest: Manifest,
  props: Record<string, unknown>,
): number | null {
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

/** Reserved built-in ids; a user/uploaded Motif may never take one. */
export const BUILTIN_IDS: readonly string[] = ["countdown", "lower-third", "text-fx"];
const DRAFTS_DIR = "drafts";

/** Slugify a name → safe single path-segment id. Mirrors Rust `sanitize_id`. */
export function sanitizeId(name: string): string {
  let out = "";
  let prevDash = false;
  for (const c of name) {
    if (/[a-zA-Z0-9]/.test(c)) {
      out += c.toLowerCase();
      prevDash = false;
    } else if (!prevDash) {
      out += "-";
      prevDash = true;
    }
  }
  const trimmed = out.replace(/^-+|-+$/g, "");
  return trimmed === "" ? "motif" : trimmed;
}

/** Unique id from `name`, avoiding `taken`, built-ins, and `drafts`. Mirrors `assign_unique_id`. */
export function assignUniqueId(name: string, taken: string[]): string {
  const base = sanitizeId(name);
  const reserved = (id: string): boolean =>
    BUILTIN_IDS.includes(id) || id === DRAFTS_DIR || taken.includes(id);
  if (!reserved(base)) return base;
  let n = 2;
  for (;;) {
    const candidate = `${base}-${n}`;
    if (!reserved(candidate)) return candidate;
    n += 1;
  }
}

// ---------------------------------------------------------------------------
// Built-in manifests
// ---------------------------------------------------------------------------

// Static imports (not import.meta.glob) — work in both renderer and main bundles.
// Cast through unknown because JSON import types are widened (number[] not tuple,
// etc.) — mirrors how the renderer casts its glob result.
const _countdown = countdownJson as unknown as Manifest;
const _lowerThird = lowerThirdJson as unknown as Manifest;
const _textFx = textFxJson as unknown as Manifest;

/**
 * The 3 built-in motif manifests, keyed by id. ReadonlyMap so callers can't
 * mutate the catalog accidentally.
 */
export const BUILTIN_MANIFESTS: ReadonlyMap<string, Manifest> = new Map([
  [_countdown.id, _countdown],
  [_lowerThird.id, _lowerThird],
  [_textFx.id, _textFx],
]);

// ---------------------------------------------------------------------------
// Manifest island parse / compose (ports native/src/motifs/{catalog,authoring}.rs)
// ---------------------------------------------------------------------------

const ISLAND_MARKER = 'id="motif-manifest"';

/**
 * Extract + JSON-parse the `<script type="application/json" id="motif-manifest">`
 * island from a Motif's HTML, WITHOUT executing the page. Mirrors Rust
 * `parse_manifest_island`. Throws MotifPropError on a missing island or bad JSON.
 */
export function parseManifestIsland(html: string): Manifest {
  const idMarker = html.indexOf(ISLAND_MARKER);
  if (idMarker < 0) throw new MotifPropError("no motif-manifest island found in HTML");
  // Constraint (mirrors Rust): the island's opening <script> tag must not contain
  // a `>` inside an attribute value — we control the writer (composeMotifHtml), so this holds.
  // End of the opening <script ...> tag: first '>' at or after the marker.
  const gt = html.indexOf(">", idMarker);
  if (gt < 0) throw new MotifPropError("no motif-manifest island found in HTML");
  const tagEnd = gt + 1;
  const closeRel = html.indexOf("</script>", tagEnd);
  if (closeRel < 0) throw new MotifPropError("no motif-manifest island found in HTML");
  const json = html.slice(tagEnd, closeRel).trim();
  try {
    return JSON.parse(json) as Manifest;
  } catch (e) {
    throw new MotifPropError(`manifest island is not valid JSON: ${String(e)}`);
  }
}

/** Remove the existing manifest island (its owning <script>..</script>) if present. */
export function stripManifestIsland(html: string): string {
  const idMarker = html.indexOf(ISLAND_MARKER);
  if (idMarker < 0) return html;
  const open = html.lastIndexOf("<script", idMarker);
  if (open < 0) return html;
  const closeRel = html.indexOf("</script>", idMarker);
  if (closeRel < 0) return html;
  const close = closeRel + "</script>".length;
  return html.slice(0, open) + html.slice(close);
}

function findCi(haystack: string, needle: string): number {
  return haystack.toLowerCase().indexOf(needle.toLowerCase());
}

/**
 * The core manifest fields that live in the on-disk island — the ONLY fields the
 * composed island and the content hash serialize. Excludes payload-decoration
 * fields (`status`, `content_hash`, `target_id`, `settle_rafs`) so the island +
 * hash are stable. Keys emitted in a fixed order for deterministic JSON.
 * (Consumed here by `composeMotifHtml` and in Task 4 by `motifContentHash`.)
 */
export function coreManifestForHash(m: Manifest): Record<string, unknown> {
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    size: m.size,
    default_duration_s: m.default_duration_s,
    max_duration_s: m.max_duration_s ?? null,
    max_duration_prop: m.max_duration_prop ?? null,
    content_duration_s: m.content_duration_s ?? null,
    fonts: m.fonts ?? [],
    props_schema: m.props_schema,
  };
}

/**
 * Compose the canonical single-file Motif HTML: strip any existing island, then
 * inject a fresh pretty-JSON island (with `<` escaped as < so a string
 * field can't close the island early) right after the opening <head> (or at the
 * top if none). Mirrors Rust `compose_motif_html`. Round-trips through
 * `parseManifestIsland`.
 */
export function composeMotifHtml(manifest: Manifest, html: string): string {
  const stripped = stripManifestIsland(html);
  const json = JSON.stringify(coreManifestForHash(manifest), null, 2).replaceAll("<", "\\u003c");
  const island = `<script type="application/json" id="motif-manifest">\n${json}\n</script>\n`;
  const headPos = findCi(stripped, "<head>");
  if (headPos >= 0) {
    const at = headPos + "<head>".length;
    return stripped.slice(0, at) + "\n" + island + stripped.slice(at);
  }
  return island + stripped;
}

// ---------------------------------------------------------------------------
// Validation and duration resolution (Task 3)
// ---------------------------------------------------------------------------

const MAX_DIMENSION = 8192;
const MAX_PROPS = 64;

/** Validate a default value against its own spec. Mirrors `validate_default_for`. */
export function validateDefaultFor(key: string, spec: PropSpec): void {
  validateProp(key, spec, specDefault(spec));
}

/** Semantic manifest validation beyond JSON shape. Mirrors `validate_manifest`. */
export function validateManifest(m: Manifest): void {
  if (m.name.trim() === "") throw new MotifPropError("name must not be empty");
  const [w, h] = m.size;
  if (w < 1 || h < 1 || w > MAX_DIMENSION || h > MAX_DIMENSION) {
    throw new MotifPropError(`size [${w},${h}] must be within [1,${MAX_DIMENSION}] on each axis`);
  }
  if (!(Number.isFinite(m.default_duration_s) && m.default_duration_s > 0)) {
    throw new MotifPropError("default_duration_s must be finite and > 0");
  }
  for (const [field, val] of [
    ["max_duration_s", m.max_duration_s],
    ["content_duration_s", m.content_duration_s],
  ] as const) {
    if (val != null && !(Number.isFinite(val) && val > 0)) {
      throw new MotifPropError(`${field} must be finite and > 0 when present`);
    }
  }
  const keys = Object.keys(m.props_schema);
  if (keys.length > MAX_PROPS) {
    throw new MotifPropError(`props_schema has ${keys.length} entries (max ${MAX_PROPS})`);
  }
  for (const key of keys) {
    const spec = m.props_schema[key]!;
    if (spec.type === "number") {
      if (spec.min != null && spec.max != null && spec.min > spec.max) {
        throw new MotifPropError(`prop \`${key}\`: min ${spec.min} > max ${spec.max}`);
      }
      if (!Number.isFinite(spec.default)) {
        throw new MotifPropError(`prop \`${key}\`: default must be finite`);
      }
    }
    validateDefaultFor(key, spec);
  }
}

/**
 * Capture content duration in SECONDS. Mirrors Rust `motif_ctx_duration_s`:
 * content_duration_s → max_duration_prop live value → max_duration_s → default_duration_s.
 */
export function motifCtxDurationS(manifest: Manifest, props: Record<string, unknown>): number {
  const cds = manifest.content_duration_s;
  if (typeof cds === "number" && Number.isFinite(cds) && cds > 0) return cds;
  const propName = manifest.max_duration_prop;
  if (propName) {
    const raw = props[propName];
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  }
  if (typeof manifest.max_duration_s === "number" && manifest.max_duration_s > 0) return manifest.max_duration_s;
  return manifest.default_duration_s;
}

// ---------------------------------------------------------------------------
// MotifCatalog class
// ---------------------------------------------------------------------------

/**
 * Motif catalog with a built-in layer (always present) and a settable user
 * layer. Built-ins win on id collision so an uploaded motif can never shadow
 * a built-in.
 */
export class MotifCatalog {
  private _user: Map<string, Manifest> = new Map();

  /**
   * @param resolveMissing optional source-of-truth fallback for a cache miss.
   *   The in-memory user layer is a cache refreshed asynchronously by the file
   *   watcher (debounced); a Motif written to disk is visible to the disk-backed
   *   `list_motifs` before that refresh lands. Wiring this to the store
   *   (`store.getMotif(id)?.manifest`) lets `add_motif` resolve such a Motif
   *   without losing the watcher race. Omitted in tests/renderer → cache-only.
   *   Called SYNCHRONOUSLY on the main thread and only on a cache MISS (the `??`
   *   chain short-circuits on builtins/cache) — a mutation-time slow path
   *   (add_motif / the content-window clamp), never the per-frame render path.
   */
  constructor(private readonly resolveMissing?: (id: string) => Manifest | null) {}

  get(id: string): Manifest | undefined {
    // Built-ins win, then the cached user layer, then the store fallback.
    return BUILTIN_MANIFESTS.get(id) ?? this._user.get(id) ?? this.resolveMissing?.(id) ?? undefined;
  }

  setUserManifests(ms: Manifest[]): void {
    this._user = new Map(ms.map((m) => [m.id, m]));
  }

  list(): Manifest[] {
    // Built-ins first, then user entries (excluding any shadowed by a built-in).
    const out: Manifest[] = [...BUILTIN_MANIFESTS.values()];
    for (const [id, m] of this._user) {
      if (!BUILTIN_MANIFESTS.has(id)) {
        out.push(m);
      }
    }
    return out;
  }
}
