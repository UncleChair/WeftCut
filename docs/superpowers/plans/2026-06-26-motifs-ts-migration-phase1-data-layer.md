# Motifs → TS Migration — Phase 1: Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Motif *data layer* (manifest island parse/compose/validate, id minting, content hash, built-in served assets, and the on-disk user store) from Rust to TypeScript, and re-point the `motif://` protocol + capture-duration call at the TS implementations — with Rust still authoritative for MCP/authoring.

**Architecture:** Pure, Node-free functions extend the existing `src/shared/motifs/catalog.ts` (importable by both main and renderer). Stateful/disk/Node-only modules land in a new `src/main/motif/` set (`contentHash.ts`, `builtinAssets.ts`, `store.ts`). Built-in served bytes (index.html + fonts) are read from disk via the repo's existing `extraResources` + `app.isPackaged` path pattern (mirroring the ffmpeg sidecar). The Rust `motifs` feature stays compiled and authoritative for everything else; this phase only swaps the protocol byte-resolver and the capture duration call.

**Tech Stack:** TypeScript, Node (`crypto`, `fs`, `path`), Electron (`app`, `protocol`), Vitest, electron-vite, electron-builder.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-26-motifs-ts-migration-design.md`.
- On-disk user store layout at `<userData>/motifs/` is UNCHANGED — no user-data migration. Layout: `<root>/<id>/{index.html, assets/...}` and `<root>/drafts/<id>/{index.html, target}`.
- `content_hash` switches from blake3 to Node `crypto` **sha256** (lowercase hex). Hash ONLY the core manifest fields (`id`, `name`, `version`, `size`, `default_duration_s`, `max_duration_s`, `max_duration_prop`, `content_duration_s`, `fonts`, `props_schema`) ‖ `\0` ‖ `html` ‖ `\0`. Exclude decoration fields (`status`, `content_hash`, `target_id`, `settle_rafs`).
- Pure functions (parse/compose/validate/id/duration) go in `src/shared/motifs/catalog.ts` and MUST NOT import any Node builtin (the renderer bundles this file).
- Node-only code (`crypto`, `fs`) lives ONLY under `src/main/`.
- Path-safety rejection set (verbatim from Rust `store.rs`): reject a segment that is empty, `.`, `..`, or contains `/`, `\`, or `:`.
- Built-in ids: `["countdown", "lower-third", "text-fx"]`. Built-ins always win over user-store ids.
- `motifs:changed` event name is stable; do not rename.
- Rust remains the source of truth this phase — do NOT delete or `#[cfg]`-gate any Rust motif code in Phase 1.
- Commit after each task. Run `npm run -w apps/desktop typecheck` (or the repo's tsc command) and the relevant vitest file before each commit.

---

## File Structure

- **Modify** `apps/desktop/src/shared/motifs/catalog.ts` — add pure functions: `BUILTIN_IDS`, `parseManifestIsland`, `stripManifestIsland`, `composeMotifHtml`, `sanitizeId`, `assignUniqueId`, `validateManifest`, `validateDefaultFor`, `motifCtxDurationS`. Plus a `coreManifestForHash` helper.
- **Modify** `apps/desktop/src/shared/motifs/catalog.test.ts` — add tests for the above (or a sibling `catalog.authoring.test.ts`).
- **Create** `apps/desktop/src/main/motif/contentHash.ts` — `motifContentHash(manifest, html): string` (sha256).
- **Create** `apps/desktop/src/main/motif/contentHash.test.ts`.
- **Create** `apps/desktop/src/main/motif/store.ts` — `UserMotifStore` class.
- **Create** `apps/desktop/src/main/motif/store.test.ts`.
- **Create** `apps/desktop/src/main/motif/builtinAssets.ts` — `resolveMotifFile`, `contentTypeFor`, `builtinAssetDir`.
- **Create** `apps/desktop/src/main/motif/builtinAssets.test.ts`.
- **Create** `apps/desktop/src/shared/motifs/builtin/{countdown,lower-third,text-fx}/index.html` (+ `lower-third/assets/Inter.woff2`, `text-fx/assets/Inter.woff2`, `lower-third/assets/LICENSE`) — relocated from `native/src/motifs/catalog/`.
- **Modify** `apps/desktop/electron-builder.yml` — add an `extraResources` entry copying `src/shared/motifs/builtin` → `motifs/builtin`.
- **Modify** `apps/desktop/src/main/motif/protocol.ts` — resolve via `resolveMotifFile` instead of `backend.motifResolveFile`.
- **Modify** `apps/desktop/src/main/motif/capture.ts` — compute duration via TS `motifCtxDurationS` instead of `backend.motifCtxDurationS`.
- **Modify** `apps/desktop/src/main/index.ts` — construct the `UserMotifStore`, pass it to `registerMotifProtocol` and the capture wiring.

**Interface summary (produced by this phase, consumed by Phases 2–4):**
- `src/shared/motifs/catalog.ts`:
  - `BUILTIN_IDS: readonly string[]`
  - `parseManifestIsland(html: string): Manifest` (throws `MotifPropError` on missing/invalid island)
  - `stripManifestIsland(html: string): string`
  - `composeMotifHtml(manifest: Manifest, html: string): string`
  - `sanitizeId(name: string): string`
  - `assignUniqueId(name: string, taken: string[]): string`
  - `validateManifest(m: Manifest): void` (throws `MotifPropError`)
  - `validateDefaultFor(key: string, spec: PropSpec): void` (throws)
  - `motifCtxDurationS(manifest: Manifest, props: Record<string, unknown>): number`
- `src/main/motif/contentHash.ts`: `motifContentHash(manifest: Manifest, html: string): string`
- `src/main/motif/store.ts`: `class UserMotifStore` (methods listed in Task 5)
- `src/main/motif/builtinAssets.ts`: `resolveMotifFile(store: UserMotifStore, id: string, rest: string): { bytes: Buffer; contentType: string } | null`, `contentTypeFor(rel: string): string`

---

## Task 1: Manifest island parse + strip + compose (pure)

**Files:**
- Modify: `apps/desktop/src/shared/motifs/catalog.ts`
- Test: `apps/desktop/src/shared/motifs/catalog.authoring.test.ts` (new)

**Interfaces:**
- Consumes: existing `Manifest`, `MotifPropError` from `catalog.ts`.
- Produces: `parseManifestIsland`, `stripManifestIsland`, `composeMotifHtml`.

- [ ] **Step 1: Write the failing tests** (port the Rust `authoring.rs` + `catalog.rs` island cases)

Create `apps/desktop/src/shared/motifs/catalog.authoring.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  parseManifestIsland,
  composeMotifHtml,
  type Manifest,
} from "./catalog";

function base(): Manifest {
  return {
    id: "x", name: "X", version: 1, size: [640, 480],
    default_duration_s: 5, props_schema: {},
  };
}

describe("parseManifestIsland", () => {
  it("parses a well-formed island", () => {
    const html = `<head><script type="application/json" id="motif-manifest">{"id":"demo","name":"Demo","version":1,"size":[10,10],"default_duration_s":1,"props_schema":{}}</script></head><body></body>`;
    const m = parseManifestIsland(html);
    expect(m.id).toBe("demo");
    expect(m.name).toBe("Demo");
  });
  it("throws when no island present", () => {
    expect(() => parseManifestIsland("<html><body>no island</body></html>")).toThrow();
  });
  it("throws on invalid island JSON", () => {
    const html = `<script type="application/json" id="motif-manifest">{not json}</script>`;
    expect(() => parseManifestIsland(html)).toThrow();
  });
});

describe("composeMotifHtml", () => {
  it("injects an island that parses back (round-trip)", () => {
    const m = { ...base(), id: "demo", name: "Demo" };
    const html = `<!doctype html><html><head></head><body><script>motif.define({setup(){}})</script></body></html>`;
    const composed = composeMotifHtml(m, html);
    const parsed = parseManifestIsland(composed);
    expect(parsed.id).toBe("demo");
    expect(parsed.name).toBe("Demo");
    expect(composed).toContain("motif.define");
  });
  it("survives a </script> inside a string field", () => {
    const m = { ...base(), id: "evil", name: "Evil</script><script>x" };
    const composed = composeMotifHtml(m, `<head></head><body><script>motif.define({setup(){}})</script></body>`);
    const parsed = parseManifestIsland(composed);
    expect(parsed.name).toBe("Evil</script><script>x");
    expect(parsed.id).toBe("evil");
  });
  it("prepends island when no <head>", () => {
    const m = { ...base(), id: "nohead" };
    const composed = composeMotifHtml(m, `<body><script>motif.define({setup(){}})</script></body>`);
    expect(parseManifestIsland(composed).id).toBe("nohead");
    expect(composed.trimStart().startsWith("<script")).toBe(true);
  });
  it("replaces a pre-existing island (exactly one remains)", () => {
    const m = { ...base(), id: "new-id" };
    const seed = `<head><script type="application/json" id="motif-manifest">{"id":"old-id","name":"Old","version":1,"size":[10,10],"default_duration_s":1,"props_schema":{}}</script></head><body><script>motif.define({setup(){}})</script></body>`;
    const composed = composeMotifHtml(m, seed);
    expect(parseManifestIsland(composed).id).toBe("new-id");
    expect((composed.match(/id="motif-manifest"/g) ?? []).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests; verify they fail**

Run: `npx vitest run src/shared/motifs/catalog.authoring.test.ts` (from `apps/desktop`)
Expected: FAIL — `parseManifestIsland`/`composeMotifHtml` are not exported.

- [ ] **Step 3: Implement the three functions in `catalog.ts`**

Append to `apps/desktop/src/shared/motifs/catalog.ts` (after the existing exports). Ports `parse_manifest_island`, `strip_manifest_island`, `compose_motif_html` from `native/src/motifs/catalog.rs` + `authoring.rs`:

```ts
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
```

> Note: `composeMotifHtml` serializes via `coreManifestForHash` (defined in Task 4) so the island never carries decoration fields. If implementing Task 1 before Task 4, temporarily inline `JSON.stringify(manifest, null, 2)`; Task 4 swaps it to `coreManifestForHash`. The round-trip tests pass either way because `base()` has no decoration fields.

- [ ] **Step 4: Run the tests; verify they pass**

Run: `npx vitest run src/shared/motifs/catalog.authoring.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/motifs/catalog.ts apps/desktop/src/shared/motifs/catalog.authoring.test.ts
git commit -m "feat(motifs): port manifest island parse/strip/compose to shared TS"
```

---

## Task 2: id sanitize + unique assignment (pure)

**Files:**
- Modify: `apps/desktop/src/shared/motifs/catalog.ts`
- Test: `apps/desktop/src/shared/motifs/catalog.authoring.test.ts`

**Interfaces:**
- Consumes: `BUILTIN_IDS` (add it), the literal `"drafts"` reserved dir name.
- Produces: `sanitizeId`, `assignUniqueId`, `BUILTIN_IDS`.

- [ ] **Step 1: Write the failing tests** (port `authoring.rs` id tests)

Append to `catalog.authoring.test.ts`:

```ts
import { sanitizeId, assignUniqueId, BUILTIN_IDS } from "./catalog";

describe("sanitizeId", () => {
  it("slugifies display names", () => {
    expect(sanitizeId("My Cool Motif!")).toBe("my-cool-motif");
    expect(sanitizeId("  Trailing--dashes  ")).toBe("trailing-dashes");
    expect(sanitizeId("___")).toBe("motif");
    expect(sanitizeId("Lower/Third")).toBe("lower-third");
  });
});

describe("assignUniqueId", () => {
  it("avoids collisions, built-ins, and the reserved drafts dir", () => {
    expect(assignUniqueId("My Motif", ["my-motif", "my-motif-2"])).toBe("my-motif-3");
    expect(assignUniqueId("countdown", [])).toBe("countdown-2");
    expect(assignUniqueId("Drafts", [])).toBe("drafts-2");
    expect(assignUniqueId("Fresh", ["my-motif", "my-motif-2"])).toBe("fresh");
  });
});

describe("BUILTIN_IDS", () => {
  it("is the three built-ins", () => {
    expect([...BUILTIN_IDS].sort()).toEqual(["countdown", "lower-third", "text-fx"]);
  });
});
```

- [ ] **Step 2: Run; verify fail**

Run: `npx vitest run src/shared/motifs/catalog.authoring.test.ts -t "sanitizeId|assignUniqueId|BUILTIN_IDS"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement in `catalog.ts`** (ports `sanitize_id`, `assign_unique_id`)

```ts
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
```

> `sanitizeId` uses `is_ascii_alphanumeric` semantics — the regex `/[a-zA-Z0-9]/` matches that exactly (ASCII only). Iterating `for (const c of name)` is code-point iteration, matching Rust `name.chars()`.

- [ ] **Step 4: Run; verify pass**

Run: `npx vitest run src/shared/motifs/catalog.authoring.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/motifs/catalog.ts apps/desktop/src/shared/motifs/catalog.authoring.test.ts
git commit -m "feat(motifs): port sanitizeId/assignUniqueId + BUILTIN_IDS to shared TS"
```

---

## Task 3: validateManifest + validateDefaultFor + motifCtxDurationS (pure)

**Files:**
- Modify: `apps/desktop/src/shared/motifs/catalog.ts`
- Test: `apps/desktop/src/shared/motifs/catalog.authoring.test.ts`

**Interfaces:**
- Consumes: existing internal `validateProp`, `specDefault`, `MotifPropError`, `PropSpec`, `Manifest`.
- Produces: `validateManifest`, `validateDefaultFor`, `motifCtxDurationS`.

- [ ] **Step 1: Write the failing tests** (port `authoring.rs` + `catalog.rs` validation cases)

Append to `catalog.authoring.test.ts`:

```ts
import { validateManifest, validateDefaultFor, motifCtxDurationS } from "./catalog";

describe("validateManifest", () => {
  it("accepts a sane manifest", () => {
    expect(() => validateManifest(base())).not.toThrow();
  });
  it("rejects empty name / zero / huge size", () => {
    expect(() => validateManifest({ ...base(), name: "  " })).toThrow();
    expect(() => validateManifest({ ...base(), size: [0, 100] })).toThrow();
    expect(() => validateManifest({ ...base(), size: [99999, 100] })).toThrow();
  });
  it("rejects bad durations", () => {
    expect(() => validateManifest({ ...base(), default_duration_s: 0 })).toThrow();
    expect(() => validateManifest({ ...base(), content_duration_s: -1 })).toThrow();
  });
  it("rejects inverted number bounds and bad color default", () => {
    expect(() => validateManifest({ ...base(), props_schema: { n: { type: "number", default: 5, min: 10, max: 1 } } })).toThrow();
    expect(() => validateManifest({ ...base(), props_schema: { c: { type: "color", default: "not-a-hex" } } })).toThrow();
  });
});

describe("validateDefaultFor", () => {
  it("rejects an enum default not in options; accepts one that is", () => {
    expect(() => validateDefaultFor("e", { type: "enum", default: "x", options: ["a", "b"] })).toThrow();
    expect(() => validateDefaultFor("e", { type: "enum", default: "a", options: ["a", "b"] })).not.toThrow();
  });
});

describe("motifCtxDurationS", () => {
  it("prefers content_duration_s, then prop value, then max_duration_s, then default", () => {
    expect(motifCtxDurationS({ ...base(), content_duration_s: 2.5 }, {})).toBeCloseTo(2.5);
    expect(motifCtxDurationS({ ...base(), max_duration_prop: "seconds" }, { seconds: 7 })).toBeCloseTo(7);
    expect(motifCtxDurationS({ ...base(), max_duration_s: 4 }, {})).toBeCloseTo(4);
    expect(motifCtxDurationS({ ...base(), default_duration_s: 5 }, {})).toBeCloseTo(5);
  });
});
```

- [ ] **Step 2: Run; verify fail**

Run: `npx vitest run src/shared/motifs/catalog.authoring.test.ts -t "validateManifest|validateDefaultFor|motifCtxDurationS"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement in `catalog.ts`** (ports `validate_manifest`, `validate_default_for`, `motif_ctx_duration_s`)

```ts
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
  if (w === 0 || h === 0 || w > MAX_DIMENSION || h > MAX_DIMENSION) {
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
```

- [ ] **Step 4: Run; verify pass**

Run: `npx vitest run src/shared/motifs/catalog.authoring.test.ts`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/motifs/catalog.ts apps/desktop/src/shared/motifs/catalog.authoring.test.ts
git commit -m "feat(motifs): port validateManifest/validateDefaultFor/motifCtxDurationS to shared TS"
```

---

## Task 4: content hash (sha256, main-only)

**Files:**
- Modify: `apps/desktop/src/shared/motifs/catalog.ts` (add `coreManifestForHash` helper)
- Create: `apps/desktop/src/main/motif/contentHash.ts`
- Test: `apps/desktop/src/main/motif/contentHash.test.ts`

**Interfaces:**
- Consumes: `Manifest` + `coreManifestForHash` from shared catalog.
- Produces: `motifContentHash(manifest, html): string`.

- [ ] **Step 1: Add `coreManifestForHash` to `catalog.ts`** (no test of its own; exercised via Task 1 round-trip + Task 4 hash)

```ts
/**
 * The core manifest fields that live in the on-disk island — the ONLY fields the
 * content hash and composed island serialize. Excludes payload-decoration fields
 * (`status`, `content_hash`, `target_id`, `settle_rafs`) so the hash is stable.
 * Keys are emitted in a fixed order for deterministic JSON.
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
```

> Swap the temporary `JSON.stringify(manifest, null, 2)` in `composeMotifHtml` (Task 1) to `JSON.stringify(coreManifestForHash(manifest), null, 2)` now. Re-run `catalog.authoring.test.ts` to confirm still green.

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/main/motif/contentHash.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { motifContentHash } from "./contentHash";
import type { Manifest } from "../../shared/motifs/catalog";

const m: Manifest = { id: "x", name: "X", version: 1, size: [10, 10], default_duration_s: 1, props_schema: {} };

describe("motifContentHash", () => {
  it("is a 64-char lowercase hex sha256", () => {
    const h = motifContentHash(m, "<html></html>");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is stable for identical inputs", () => {
    expect(motifContentHash(m, "<a/>")).toBe(motifContentHash(m, "<a/>"));
  });
  it("changes when html changes", () => {
    expect(motifContentHash(m, "<a/>")).not.toBe(motifContentHash(m, "<b/>"));
  });
  it("changes when a core manifest field changes", () => {
    expect(motifContentHash(m, "<a/>")).not.toBe(motifContentHash({ ...m, version: 2 }, "<a/>"));
  });
  it("ignores decoration fields (status/content_hash/target_id/settle_rafs)", () => {
    const decorated = { ...m, status: "draft", content_hash: "deadbeef", target_id: "y", settle_rafs: 3 } as Manifest;
    expect(motifContentHash(decorated, "<a/>")).toBe(motifContentHash(m, "<a/>"));
  });
});
```

- [ ] **Step 3: Run; verify fail**

Run: `npx vitest run src/main/motif/contentHash.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `contentHash.ts`**

```ts
import { createHash } from "node:crypto";
import { coreManifestForHash, type Manifest } from "../../shared/motifs/catalog";

/**
 * sha256( canonicalCoreManifestJSON ‖ \0 ‖ html ‖ \0 ) as lowercase hex.
 * Replaces the Rust blake3 `Motif::content_hash` (value changes once → harmless
 * one-time frame re-bake). Feeds the capture host `?v=` cache-buster + raster key.
 */
export function motifContentHash(manifest: Manifest, html: string): string {
  const hasher = createHash("sha256");
  // Compact (no whitespace) canonical JSON of the CORE fields only.
  const manifestJson = JSON.stringify(coreManifestForHash(manifest));
  hasher.update(Buffer.from(manifestJson, "utf8"));
  hasher.update(Buffer.from([0]));
  hasher.update(Buffer.from(html, "utf8"));
  hasher.update(Buffer.from([0]));
  return hasher.digest("hex");
}
```

- [ ] **Step 5: Run; verify pass**

Run: `npx vitest run src/main/motif/contentHash.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/shared/motifs/catalog.ts apps/desktop/src/main/motif/contentHash.ts apps/desktop/src/main/motif/contentHash.test.ts
git commit -m "feat(motifs): TS sha256 motifContentHash + coreManifestForHash helper"
```

---

## Task 5: UserMotifStore (Node fs)

**Files:**
- Create: `apps/desktop/src/main/motif/store.ts`
- Test: `apps/desktop/src/main/motif/store.test.ts`

**Interfaces:**
- Consumes: `parseManifestIsland`, `composeMotifHtml`, `type Manifest` from shared catalog.
- Produces: `class UserMotifStore` with: `constructor(root: string)`, `root(): string`, `readFile(id, rel): Buffer | null`, `readHtml(id): string | null`, `getMotif(id): { manifest: Manifest; html: string } | null`, `writeDraft(draftId, html): void`, `writeDraftTarget(draftId, targetId): void`, `readDraftTarget(draftId): string | null`, `listDraftIds(): string[]`, `listDrafts(): { manifest; html }[]`, `getDraft(draftId): { manifest; html } | null`, `installDraft(draftId, finalId): void`, `deleteUserMotif(id): void`, `publishedIds(): string[]`, `listManifests(): Manifest[]`.

- [ ] **Step 1: Write the failing tests** (port `store.rs` tests near-verbatim)

Create `apps/desktop/src/main/motif/store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UserMotifStore } from "./store";
import { composeMotifHtml, type Manifest } from "../../shared/motifs/catalog";

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "motif-store-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function man(id: string, name: string, version: number): Manifest {
  return { id, name, version, size: [100, 100], default_duration_s: 1, props_schema: {} };
}
const body = "<head></head><body><script>motif.define({setup(){}})</script></body>";

describe("UserMotifStore drafts + publish", () => {
  it("write_draft → list + get", () => {
    const s = new UserMotifStore(root);
    s.writeDraft("d1", composeMotifHtml(man("d1", "Draft One", 1), body));
    expect(s.listDraftIds()).toEqual(["d1"]);
    expect(s.listManifests()).toEqual([]);
    expect(s.getDraft("d1")?.manifest.id).toBe("d1");
  });
  it("install_new publishes and removes draft", () => {
    const s = new UserMotifStore(root);
    s.writeDraft("foo", composeMotifHtml(man("foo", "Foo", 1), body));
    s.installDraft("foo", "foo");
    expect(s.listManifests().map((m) => m.id)).toEqual(["foo"]);
    expect(s.listDraftIds()).toEqual([]);
  });
  it("install over an existing published id (update path)", () => {
    const s = new UserMotifStore(root);
    s.writeDraft("foo", composeMotifHtml(man("foo", "Foo v1", 1), body));
    s.installDraft("foo", "foo");
    s.writeDraft("foo", composeMotifHtml(man("foo", "Foo v2", 2), body));
    s.installDraft("foo", "foo");
    const parsed = s.listManifests().find((m) => m.id === "foo")!;
    expect(parsed.version).toBe(2);
    expect(parsed.name).toBe("Foo v2");
    expect(s.publishedIds()).toEqual(["foo"]);
  });
  it("delete removes published + draft", () => {
    const s = new UserMotifStore(root);
    s.writeDraft("d1", composeMotifHtml(man("d1", "D1", 1), body));
    expect(s.listDraftIds()).toEqual(["d1"]);
    s.deleteUserMotif("d1");
    expect(s.listDraftIds()).toEqual([]);
  });
});

describe("UserMotifStore path safety", () => {
  it("rejects traversal in readFile", () => {
    const s = new UserMotifStore(root);
    expect(s.readFile("user-x", "../secret.txt")).toBeNull();
    expect(s.readFile("user-x", "a/../../b")).toBeNull();
    expect(s.readFile("..", "index.html")).toBeNull();
    expect(s.readFile("user-x", "/etc/hosts")).toBeNull();
    expect(s.readFile("user-x", "a\\b")).toBeNull();
    expect(s.readFile("user-x", ".")).toBeNull();
    expect(s.readFile("user-x", "")).toBeNull();
    expect(s.readFile("user-x", "C:/foo")).toBeNull();
    expect(s.readFile("drafts", "index.html")).toBeNull();
  });
  it("rejects unsafe ids on the write surface", () => {
    const s = new UserMotifStore(root);
    expect(() => s.writeDraft("..", "html")).toThrow();
    expect(() => s.writeDraft("a/b", "html")).toThrow();
    expect(() => s.writeDraft("", "html")).toThrow();
    expect(() => s.deleteUserMotif("..")).toThrow();
    expect(() => s.installDraft("ok", "../escape")).toThrow();
  });
});

describe("UserMotifStore reads", () => {
  it("reads an existing asset + html", () => {
    const dir = path.join(root, "user-x");
    mkdirSync(path.join(dir, "assets"), { recursive: true });
    const manifestJson = `{"id":"user-x","name":"X","version":1,"size":[10,10],"default_duration_s":1,"props_schema":{}}`;
    writeFileSync(path.join(dir, "index.html"), `<script type="application/json" id="motif-manifest">${manifestJson}</script><script>motif.define({setup(){}})</script>`);
    writeFileSync(path.join(dir, "assets", "logo.svg"), "<svg/>");
    const s = new UserMotifStore(root);
    expect(s.readFile("user-x", "assets/logo.svg")?.toString()).toBe("<svg/>");
    expect(s.readHtml("user-x")).toContain("motif.define");
    expect(s.getMotif("user-x")?.manifest.id).toBe("user-x");
  });
  it("lists installed, skipping drafts and broken", () => {
    const dir = path.join(root, "user-a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.html"), `<script type="application/json" id="motif-manifest">{"id":"user-a","name":"A","version":1,"size":[10,10],"default_duration_s":1,"props_schema":{}}</script>`);
    mkdirSync(path.join(root, "drafts", "wip"), { recursive: true });
    writeFileSync(path.join(root, "drafts", "wip", "index.html"), "draft");
    mkdirSync(path.join(root, "broken"), { recursive: true });
    writeFileSync(path.join(root, "broken", "index.html"), "<html>no island</html>");
    const s = new UserMotifStore(root);
    expect(s.listManifests().map((m) => m.id)).toEqual(["user-a"]);
  });
  it("missing root is empty", () => {
    const s = new UserMotifStore(path.join(root, "no", "such", "dir"));
    expect(s.listManifests()).toEqual([]);
    expect(s.readHtml("anything")).toBeNull();
  });
  it("readFile falls back to draft then prefers published", () => {
    const s = new UserMotifStore(root);
    s.writeDraft("foo", composeMotifHtml(man("foo", "Draft Foo", 1), "<head></head><body>draft<script>motif.define({setup(){}})</script></body>"));
    expect(s.readFile("foo", "index.html")?.toString()).toContain("draft");
    s.installDraft("foo", "foo");
    expect(s.listDraftIds()).toEqual([]);
    expect(s.readFile("foo", "index.html")?.toString()).toContain("draft");
  });
  it("draft target sidecar round-trips and defaults absent", () => {
    const s = new UserMotifStore(root);
    s.writeDraft("d1", "<html>x</html>");
    expect(s.readDraftTarget("d1")).toBeNull();
    s.writeDraftTarget("d1", "lower-third");
    expect(s.readDraftTarget("d1")).toBe("lower-third");
    s.deleteUserMotif("d1");
    expect(s.readDraftTarget("d1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run; verify fail**

Run: `npx vitest run src/main/motif/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `store.ts`** (ports `native/src/motifs/store.rs`)

```ts
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, statSync,
  existsSync, rmSync, renameSync, cpSync,
} from "node:fs";
import path from "node:path";
import { parseManifestIsland, type Manifest } from "../../shared/motifs/catalog";

export const DRAFTS_DIR = "drafts";

/** Reject an id segment that could traverse or escape. Mirrors Rust `safe_seg`. */
function safeSeg(seg: string): string {
  if (seg === "" || seg === "." || seg === ".." || seg.includes("/") || seg.includes("\\") || seg.includes(":")) {
    throw new Error(`unsafe path segment: ${JSON.stringify(seg)}`);
  }
  return seg;
}

/** Validate a `/`-separated relative path into safe segments, or null. Mirrors `safe_rel`. */
function safeRel(rel: string): string[] | null {
  const out: string[] = [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return null;
    if (seg.includes("\\") || seg.includes(":")) return null;
    out.push(seg);
  }
  return out.length === 0 ? null : out;
}

type MotifSource = { manifest: Manifest; html: string };

/** On-disk store of user Motifs rooted at `<userData>/motifs/`. Ports `UserMotifStore`. */
export class UserMotifStore {
  constructor(private readonly _root: string) {}

  root(): string { return this._root; }
  private draftsRoot(): string { return path.join(this._root, DRAFTS_DIR); }

  /** Published copy first, then draft of the same id. Mirrors `read_file`. */
  readFile(id: string, rel: string): Buffer | null {
    if (id === DRAFTS_DIR) return null;
    const safeId = safeRel(id);
    const safe = safeRel(rel);
    if (!safeId || !safe) return null;
    const published = path.join(this._root, ...safeId, ...safe);
    try { return readFileSync(published); } catch { /* fall through */ }
    const draft = path.join(this.draftsRoot(), ...safeId, ...safe);
    try { return readFileSync(draft); } catch { return null; }
  }

  readHtml(id: string): string | null {
    const b = this.readFile(id, "index.html");
    return b ? b.toString("utf8") : null;
  }

  getMotif(id: string): MotifSource | null {
    if (id === DRAFTS_DIR) return null;
    const html = this.readHtml(id);
    if (html == null) return null;
    try { return { manifest: parseManifestIsland(html), html }; } catch { return null; }
  }

  writeDraft(draftId: string, html: string): void {
    const dir = path.join(this.draftsRoot(), safeSeg(draftId));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.html"), html);
  }

  writeDraftTarget(draftId: string, targetId: string): void {
    const dir = path.join(this.draftsRoot(), safeSeg(draftId));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "target"), targetId);
  }

  readDraftTarget(draftId: string): string | null {
    let seg: string;
    try { seg = safeSeg(draftId); } catch { return null; }
    try {
      const t = readFileSync(path.join(this.draftsRoot(), seg, "target"), "utf8").trim();
      return t === "" ? null : t;
    } catch { return null; }
  }

  listDraftIds(): string[] {
    let entries: string[] = [];
    try {
      entries = readdirSync(this.draftsRoot()).filter((name) =>
        statSync(path.join(this.draftsRoot(), name)).isDirectory(),
      );
    } catch { return []; }
    return entries.sort();
  }

  listDrafts(): MotifSource[] {
    return this.listDraftIds()
      .map((id) => this.getDraft(id))
      .filter((m): m is MotifSource => m !== null);
  }

  getDraft(draftId: string): MotifSource | null {
    let seg: string;
    try { seg = safeSeg(draftId); } catch { return null; }
    let html: string;
    try { html = readFileSync(path.join(this.draftsRoot(), seg, "index.html"), "utf8"); }
    catch { return null; }
    try { return { manifest: parseManifestIsland(html), html }; } catch { return null; }
  }

  /** Move `<root>/drafts/<draftId>/` → `<root>/<finalId>/`, overwriting. Mirrors `install_draft`. */
  installDraft(draftId: string, finalId: string): void {
    mkdirSync(this._root, { recursive: true });
    const from = path.join(this.draftsRoot(), safeSeg(draftId));
    const to = path.join(this._root, safeSeg(finalId));
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    try {
      renameSync(from, to);
    } catch {
      // Cross-device fallback: copy then remove the source.
      try {
        cpSync(from, to, { recursive: true });
      } catch (copyErr) {
        rmSync(to, { recursive: true, force: true });
        throw copyErr;
      }
      rmSync(from, { recursive: true, force: true });
    }
  }

  /** Remove published + draft dirs for an id. Idempotent. Mirrors `delete_user_motif`. */
  deleteUserMotif(id: string): void {
    const safeId = safeSeg(id);
    const published = path.join(this._root, safeId);
    if (existsSync(published)) rmSync(published, { recursive: true, force: true });
    const draft = path.join(this.draftsRoot(), safeId);
    if (existsSync(draft)) rmSync(draft, { recursive: true, force: true });
  }

  publishedIds(): string[] {
    return this.listManifests().map((m) => m.id);
  }

  /** Every installed user manifest, id-sorted; skips drafts + broken. Mirrors `list_manifests`. */
  listManifests(): Manifest[] {
    let entries: string[];
    try { entries = readdirSync(this._root); } catch { return []; }
    const out: Manifest[] = [];
    for (const name of entries) {
      const p = path.join(this._root, name);
      try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
      if (name === DRAFTS_DIR) continue;
      let html: string;
      try { html = readFileSync(path.join(p, "index.html"), "utf8"); } catch { continue; }
      try { out.push(parseManifestIsland(html)); }
      catch { /* skip broken island */ }
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }
}
```

> `cpSync` (Node ≥16.7) is the cross-device fallback for `rename` (mirrors Rust `copy_dir_all`). `installDraft`/`deleteUserMotif`/`writeDraft*` call `safeSeg` which THROWS on an unsafe id (matching Rust's `io::Result` Err), so the "rejects unsafe ids" test expects throws.

- [ ] **Step 4: Run; verify pass**

Run: `npx vitest run src/main/motif/store.test.ts`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/motif/store.ts apps/desktop/src/main/motif/store.test.ts
git commit -m "feat(motifs): port UserMotifStore (disk I/O + path safety) to TS"
```

---

## Task 6: Relocate built-in served assets + extraResources

**Files:**
- Create: `apps/desktop/src/shared/motifs/builtin/countdown/index.html` (copy from `native/src/motifs/catalog/countdown/index.html`)
- Create: `apps/desktop/src/shared/motifs/builtin/lower-third/index.html` + `assets/Inter.woff2` + `assets/LICENSE`
- Create: `apps/desktop/src/shared/motifs/builtin/text-fx/index.html` + `assets/Inter.woff2`
- Modify: `apps/desktop/electron-builder.yml`

**Interfaces:** none (file relocation + build config).

- [ ] **Step 1: Copy the served files** (manifests already exist under `src/shared/motifs/builtin/<id>/`)

Run (from repo root):

```bash
cd apps/desktop
cp native/src/motifs/catalog/countdown/index.html  src/shared/motifs/builtin/countdown/index.html
cp native/src/motifs/catalog/lower-third/index.html src/shared/motifs/builtin/lower-third/index.html
cp native/src/motifs/catalog/text-fx/index.html     src/shared/motifs/builtin/text-fx/index.html
mkdir -p src/shared/motifs/builtin/lower-third/assets src/shared/motifs/builtin/text-fx/assets
cp native/src/motifs/catalog/lower-third/assets/Inter.woff2 src/shared/motifs/builtin/lower-third/assets/Inter.woff2
cp native/src/motifs/catalog/lower-third/assets/LICENSE      src/shared/motifs/builtin/lower-third/assets/LICENSE
cp native/src/motifs/catalog/text-fx/assets/Inter.woff2      src/shared/motifs/builtin/text-fx/assets/Inter.woff2
```

> Do NOT delete the `native/.../catalog/` copies in Phase 1 — Rust still serves them as the authoritative path until Phase 4.

- [ ] **Step 2: Verify the copies landed**

Run: `find src/shared/motifs/builtin -type f | sort`
Expected: lists 3 `manifest.json`, 3 `index.html`, 2 `Inter.woff2`, 1 `LICENSE`.

- [ ] **Step 3: Add the `extraResources` entry to `electron-builder.yml`**

Edit the `extraResources:` list (currently only ffmpeg) to add:

```yaml
extraResources:
  - from: resources/ffmpeg/${os}
    to: ffmpeg
    filter: ["**/*"]
  - from: src/shared/motifs/builtin
    to: motifs/builtin
    filter: ["**/*"]
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/shared/motifs/builtin apps/desktop/electron-builder.yml
git commit -m "chore(motifs): relocate built-in served assets to src/shared + package via extraResources"
```

---

## Task 7: builtinAssets resolver + contentTypeFor

**Files:**
- Create: `apps/desktop/src/main/motif/builtinAssets.ts`
- Test: `apps/desktop/src/main/motif/builtinAssets.test.ts`

**Interfaces:**
- Consumes: `UserMotifStore` (Task 5); the relocated built-in dir (Task 6).
- Produces: `resolveMotifFile(store, id, rest)`, `contentTypeFor(rel)`, `builtinAssetDir()`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/motif/builtinAssets.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// app.isPackaged → false in tests; builtinAssetDir resolves to the src tree.
vi.mock("electron", () => ({ app: { isPackaged: false } }));

import { resolveMotifFile, contentTypeFor } from "./builtinAssets";
import { UserMotifStore } from "./store";

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "motif-assets-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("contentTypeFor", () => {
  it("maps known extensions and defaults to octet-stream", () => {
    expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("assets/x.woff2")).toBe("font/woff2");
    expect(contentTypeFor("a.png")).toBe("image/png");
    expect(contentTypeFor("weird")).toBe("application/octet-stream");
  });
});

describe("resolveMotifFile", () => {
  it("serves a built-in index.html (built-in wins)", () => {
    const s = new UserMotifStore(root);
    const file = resolveMotifFile(s, "countdown", "index.html");
    expect(file).not.toBeNull();
    expect(file!.contentType).toBe("text/html; charset=utf-8");
    expect(file!.bytes.toString("utf8")).toContain("motif.define");
  });
  it("falls back to the user store for a non-built-in id", () => {
    const dir = path.join(root, "user-z");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.html"), "<html>user-z</html>");
    const s = new UserMotifStore(root);
    expect(resolveMotifFile(s, "user-z", "index.html")!.bytes.toString("utf8")).toBe("<html>user-z</html>");
  });
  it("returns null for an unknown id", () => {
    const s = new UserMotifStore(root);
    expect(resolveMotifFile(s, "nope", "index.html")).toBeNull();
  });
});
```

- [ ] **Step 2: Run; verify fail**

Run: `npx vitest run src/main/motif/builtinAssets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `builtinAssets.ts`** (ports `native/src/motifs/builtin.rs`)

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { BUILTIN_IDS } from "../../shared/motifs/catalog";
import type { UserMotifStore } from "./store";

/**
 * Base dir of built-in served assets. Mirrors the ffmpeg-sidecar resolution
 * (`src/main/index.ts`): packaged → `<resources>/motifs/builtin`; dev/test →
 * `<projectRoot>/src/shared/motifs/builtin` relative to the bundled main file.
 * In dev the bundled main is `apps/desktop/out/main`, so `../../src/...`.
 */
export function builtinAssetDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "motifs", "builtin")
    : path.join(__dirname, "../../src/shared/motifs/builtin");
}

/** Guess a Content-Type from a file extension. Mirrors `content_type_for`. */
export function contentTypeFor(rel: string): string {
  const ext = (rel.split(".").pop() ?? "").toLowerCase();
  switch (ext) {
    case "html": case "htm": return "text/html; charset=utf-8";
    case "js": case "mjs": return "text/javascript; charset=utf-8";
    case "css": return "text/css; charset=utf-8";
    case "json": return "application/json; charset=utf-8";
    case "svg": return "image/svg+xml";
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "woff2": return "font/woff2";
    case "woff": return "font/woff";
    case "ttf": return "font/ttf";
    case "otf": return "font/otf";
    default: return "application/octet-stream";
  }
}

/** Reject a `/`-relative path that could escape the motif dir (built-in side). */
function safeBuiltinRel(rel: string): string[] | null {
  const out: string[] = [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return null;
    if (seg.includes("\\") || seg.includes(":")) return null;
    out.push(seg);
  }
  return out.length === 0 ? null : out;
}

/**
 * Resolve `motif://<id>/<rest>` to bytes + content-type. Embedded built-ins win;
 * the on-disk user store is the fallback. Mirrors `resolve_bytes` + the napi
 * `motif_resolve_file`.
 */
export function resolveMotifFile(
  store: UserMotifStore,
  id: string,
  rest: string,
): { bytes: Buffer; contentType: string } | null {
  if (BUILTIN_IDS.includes(id)) {
    const safe = safeBuiltinRel(rest);
    if (safe) {
      try {
        const bytes = readFileSync(path.join(builtinAssetDir(), id, ...safe));
        return { bytes, contentType: contentTypeFor(rest) };
      } catch { /* fall through to store (won't normally hit for built-ins) */ }
    }
  }
  const bytes = store.readFile(id, rest);
  return bytes ? { bytes, contentType: contentTypeFor(rest) } : null;
}
```

> Built-ins are checked first by id (matching Rust: an uploaded motif can never shadow a built-in). The `readFileSync` path-join uses `safeBuiltinRel` segments so a built-in request can't traverse either.

- [ ] **Step 4: Run; verify pass**

Run: `npx vitest run src/main/motif/builtinAssets.test.ts`
Expected: PASS (all suites). (`builtinAssetDir` resolves via `__dirname` to `apps/desktop/src/shared/motifs/builtin` in the vitest run — confirm the test machine runs vitest from `apps/desktop`. If `__dirname` differs under vitest, see the note below.)

> **vitest `__dirname` caveat:** under vitest, `__dirname` is the test file's dir (`src/main/motif`), so `../../src/shared/motifs/builtin` would be wrong. To keep the test hermetic, the test mocks `electron` only for `app.isPackaged`; `builtinAssetDir` still uses `__dirname`. If the path resolves wrong in the test runner, adjust `builtinAssetDir` to derive from a known anchor that holds in BOTH the bundled-main (`out/main`) and vitest (`src/main/motif`) contexts — e.g. walk up to the nearest `src/shared/motifs/builtin`. Simplest robust form: `path.resolve(__dirname, "../../shared/motifs/builtin")` works from `src/main/motif` (→ `src/shared/motifs/builtin`) in vitest, AND the bundled main can be configured to the same relative depth. Pick the form that makes BOTH this test and the Task 9 packaged-build check pass; the dev (`__dirname=out/main`) path is verified in Task 9, not here.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/motif/builtinAssets.ts apps/desktop/src/main/motif/builtinAssets.test.ts
git commit -m "feat(motifs): TS built-in asset resolver + contentTypeFor (motif:// serving)"
```

---

## Task 8: Re-point protocol + capture + main wiring to TS

**Files:**
- Modify: `apps/desktop/src/main/motif/protocol.ts`
- Modify: `apps/desktop/src/main/motif/capture.ts`
- Modify: `apps/desktop/src/main/index.ts`

**Interfaces:**
- Consumes: `resolveMotifFile` (Task 7), `UserMotifStore` (Task 5), `motifCtxDurationS` (Task 3).
- Produces: a single `UserMotifStore` instance in main, threaded to protocol + capture. `registerMotifProtocol(store)` and `captureMotifFrameB64(store, a)` new signatures.

- [ ] **Step 1: Re-point `protocol.ts` to `resolveMotifFile`**

Replace the `Backend`-based handler body. New `registerMotifProtocol`:

```ts
import { protocol } from 'electron'
import { resolveMotifFile } from './builtinAssets.js'
import type { UserMotifStore } from './store.js'

const MOTIF_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: motif:; font-src data: motif:"

export const MOTIF_SCHEME_ENTRY = {
  scheme: 'motif',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
} as const

/** Serve motif://<id>/<rest> from TS (built-in assets + the user store). */
export function registerMotifProtocol(store: UserMotifStore): void {
  protocol.handle('motif', async (request) => {
    const url = new URL(request.url)
    const id = url.hostname
    const rest = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html'
    const file = resolveMotifFile(store, id, rest)
    if (!file) return new Response('not found: ' + id + '/' + rest, { status: 404 })
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: { 'Content-Type': file.contentType, 'Content-Security-Policy': MOTIF_CSP },
    })
  })
}
```

- [ ] **Step 2: Re-point `capture.ts` duration to TS**

In `capture.ts`: replace the `backend.motifCtxDurationS(...)` call. The capture needs the manifest by id; resolve it from built-ins + store. Change `captureMotifFrameB64` to take the store instead of the backend (the backend was used ONLY for the duration call — confirm with a grep first):

Run first: `grep -n "backend\." apps/desktop/src/main/motif/capture.ts`
Expected: a single use — `backend.motifCtxDurationS` on line ~128.

Then edit:

```ts
// top of file — replace `type Backend = ...`
import { BUILTIN_MANIFESTS, motifCtxDurationS, type Manifest } from '../../shared/motifs/catalog.js'
import type { UserMotifStore } from './store.js'

// signature changes: backend → store
async function doCapture(store: UserMotifStore, a: CaptureArgs): Promise<string> {
  // ...unchanged host/ready logic...
  const manifest: Manifest | undefined =
    BUILTIN_MANIFESTS.get(a.motifId) ?? store.getMotif(a.motifId)?.manifest
  const props = JSON.parse(a.propsJson) as Record<string, unknown>
  const duration = manifest ? motifCtxDurationS(manifest, props) : 5
  const meta = { duration, width: a.width, height: a.height, fps: 30, settleRafs: a.settleRafs }
  // ...unchanged from here (expr/screenshot)...
}

export function captureMotifFrameB64(store: UserMotifStore, a: CaptureArgs): Promise<string> {
  const run = chain.then(() => doCapture(store, a))
  chain = run.then(() => undefined, () => undefined)
  return run
}
```

> Duration fallback `5` matches Rust `resolve_capture_duration`'s final default when the id is unknown. `props` is now parsed once before the meta build (it was parsed after the duration call previously; behaviour identical).

- [ ] **Step 3: Wire the store in `index.ts`**

In `apps/desktop/src/main/index.ts`:
- Construct the store once after `app` paths are known:
  ```ts
  import { UserMotifStore } from './motif/store.js'
  // ... after backend/userData setup:
  const motifStore = new UserMotifStore(path.join(app.getPath('userData'), 'motifs'))
  ```
- Replace `registerMotifProtocol(backend!)` (line ~525) with `registerMotifProtocol(motifStore)`.
- Replace the capture-frame IPC handler body (line ~313) call `captureMotifFrameB64(backend!, {...})` with `captureMotifFrameB64(motifStore, {...})`.
- The MCP `preview_motif_draft` path in `src/main/mcp/server.ts` also calls `captureMotifFrameB64(backend, {...})` — update it to pass `motifStore`. Thread `motifStore` into `buildMcpServer`/`handleCallTool` (add a param) OR export the singleton store from a small module and import it in `server.ts`. Prefer threading a param to avoid a hidden singleton.

Run: `grep -rn "captureMotifFrameB64\|registerMotifProtocol" apps/desktop/src/main`
Expected: every call site updated to pass `motifStore`.

- [ ] **Step 4: Typecheck**

Run: `npm run -w apps/desktop typecheck` (or `npx tsc -p apps/desktop/tsconfig.main.json --noEmit`)
Expected: PASS — no references to `backend.motifResolveFile` / `backend.motifCtxDurationS` remain. (Rust still EXPORTS them; we just no longer call them.)

- [ ] **Step 5: Run the full motif unit suite + commit**

Run: `npx vitest run src/main/motif src/shared/motifs` (from `apps/desktop`)
Expected: PASS.

```bash
git add apps/desktop/src/main/motif/protocol.ts apps/desktop/src/main/motif/capture.ts apps/desktop/src/main/index.ts apps/desktop/src/main/mcp/server.ts
git commit -m "feat(motifs): serve motif:// + capture duration from TS store/catalog (Rust uncalled)"
```

---

## Task 9: Real-app verification (dev + packaged)

**Files:** none (verification only).

- [ ] **Step 1: Dev launch — built-ins + a user motif render**

Run: `npm run -w apps/desktop dev` (launches a visible window).
Verify in the running app:
- The Motif picker shows the 3 built-ins (countdown, lower-third, text-fx) with correct previews (served via TS `motif://`).
- Place a built-in motif; it renders a frame (capture path resolved duration from TS).
- The lower-third / text-fx font renders correctly (the `assets/Inter.woff2` served via TS, not a fallback).

Expected: all render; no `motif://` 404s in the main-process console.

- [ ] **Step 2: Capture-duration parity check**

In the dev app, place a `countdown` with `{seconds: 7}` (or its `max_duration_prop`) and confirm the capture content duration matches the pre-change behaviour (7s). Compare against a build with the old Rust path if in doubt (the spec's `resolve_capture_duration` test asserts `7.0`).

- [ ] **Step 3: Packaged-build asset resolution**

Run: `npm run -w apps/desktop build && npx electron-builder --dir` (or the repo's packaging script producing an unpacked dir under `release/`).
Launch the packaged app from `release/.../WeftCut`. Verify the 3 built-ins still render (this exercises `builtinAssetDir()`'s `app.isPackaged → process.resourcesPath/motifs/builtin` branch and the `extraResources` copy).

Expected: built-ins render identically to dev. If 404, confirm `resources/motifs/builtin/<id>/index.html` exists in the packaged tree and `builtinAssetDir()` points at it.

- [ ] **Step 4: Commit a short verification note (optional) / mark phase done**

No code change. Record the result in the PR description / phase note. Phase 1 complete: `motif://` and capture-duration now served from TS; Rust motif code still present and authoritative for MCP/authoring (Phases 2–4).

---

## Self-Review

- **Spec coverage (§1.3 + §2 + §3 + §4 data-layer rows):**
  - parse/strip/compose → Task 1 ✓; sanitize/assign-id → Task 2 ✓; validate_manifest/validate_default_for/motif_ctx_duration_s → Task 3 ✓; content_hash (sha256, core-fields-only) → Task 4 ✓; UserMotifStore → Task 5 ✓; built-in asset relocation + extraResources → Task 6 ✓; resolve_bytes/content_type_for → Task 7 ✓; protocol + capture re-point → Task 8 ✓; packaged-build gate (spec §10 risk) → Task 9 ✓.
  - Out of Phase 1 scope (deferred to later phases, per the 4-phase plan): list_motifs payload, authoring lifecycle, hybrid collapse (Phase 2); staleness + watcher (Phase 3); Rust deletion + MCP def moves (Phase 4). These are NOT gaps — they are later phases.
- **Placeholder scan:** No TBD/TODO. The only conditional guidance is the `builtinAssetDir()` `__dirname` caveat in Task 7 Step 4 — it gives a concrete robust form (`path.resolve(__dirname, "../../shared/motifs/builtin")`) and defers final confirmation to the Task 9 packaged check, which is a real gate, not a placeholder.
- **Type consistency:** `Manifest`/`PropSpec`/`MotifPropError` come from the existing `catalog.ts`. `UserMotifStore` method names used in Task 7/8 match Task 5's produced list (`readFile`, `getMotif`, `listManifests`). `resolveMotifFile(store, id, rest)` signature consistent across Tasks 7 and 8. `motifContentHash` not consumed until Phase 2 (list_motifs payload) — defined here, no Phase 1 caller, which is intentional (it's a produced interface).
- **Naming:** `coreManifestForHash` used by both `composeMotifHtml` (Task 1, after Task 4 swap) and `motifContentHash` (Task 4) — single definition in `catalog.ts`.
