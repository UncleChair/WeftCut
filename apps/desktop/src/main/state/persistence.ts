// apps/desktop/src/main/state/persistence.ts
//
// The PURE on-disk persistence surface — mirrors native/src/io/mod.rs (save/load)
// + native/src/io/migrate.rs (the schema-version gate). No node:fs here: the file
// read/write/delete shell + the workspace/cache/LogBus/recents/jobs orchestration
// stay in Rust until Phase 3c wires this module's pure functions into the
// project_open/save_as/new_workspace cutover. Filesystem/platform impurities are
// injected (`join` for path reconcile) or returned (quick-proxy files to delete).
import { SCHEMA_VERSION, type MediaItem, type Project } from './model'
import { serializeProject, parseProject } from './serialize'

/** io/mod.rs:19 — the on-disk project file name inside a workspace folder. */
export const PROJECT_FILE = 'project.json'

/** io/mod.rs:25 — serde_json::to_string_pretty (2-space indent, NO trailing
 *  newline; fs::write writes the string verbatim). Round-trip fidelity, not
 *  byte-identical key order vs Rust, is the contract (see Task 5). */
export function serializeProjectToJson(p: Project): string {
  return JSON.stringify(serializeProject(p), null, 2)
}

/** io/migrate.rs:20 run — the schema-version gate. Equal → ok; below → re-create
 *  in a fresh workspace; above → update the app. Pre-release: no migration path. */
export function schemaGate(project: unknown): void {
  const v = (project as { schema_version?: unknown })?.schema_version
  if (v === SCHEMA_VERSION) return
  if (typeof v === 'number' && v < SCHEMA_VERSION) {
    throw new Error(
      `project schema v${v} is below the supported minimum v${SCHEMA_VERSION}. ` +
      `Pre-release builds don't migrate older \`.vproj\` folders forward — ` +
      `re-create the project in a fresh workspace.`,
    )
  }
  if (typeof v === 'number') {
    throw new Error(`project schema v${v} is newer than this build (v${SCHEMA_VERSION}). Update the app.`)
  }
  throw new Error(`project schema version is missing or non-numeric (expected ${SCHEMA_VERSION})`)
}

/** io/mod.rs:57 — deserialize project.json text → Project, gated on schema version.
 *  JSON.parse throws on malformed text; schemaGate runs BEFORE the structural cast
 *  so the rich version-specific guidance wins over parseProject's generic check. */
export function parseProjectJson(text: string): Project {
  const json: unknown = JSON.parse(text)
  schemaGate(json)
  return parseProject(json)
}

/** io/mod.rs:73-86 — on load, an item whose `path_rel` is populated has its
 *  in-memory `path_abs` recomputed as join(dir, path_rel), reconciling the saved
 *  absolute path with the current (possibly-moved) workspace location. Items with
 *  `path_rel === null` (import-worker copy pending, or synthesized Cache/ media)
 *  keep their serialized `path_abs` verbatim. `join` is injected (platform-native
 *  in 3c via node:path; a posix joiner in tests) — see the plan's path landmine. */
export function reconcileMediaPaths(p: Project, dir: string, join: (...parts: string[]) => string): Project {
  const media_pool: Record<string, MediaItem> = {}
  for (const [id, item] of Object.entries(p.media_pool)) {
    media_pool[id] = item.path_rel ? { ...item, path_abs: join(dir, item.path_rel) } : item
  }
  return { ...p, media_pool }
}

/** Quick proxies are session-scoped preview accelerators; never trust
 *  serialized paths across launches. Null the `quick_proxy` slot of every
 *  decode route that carries one (DirectExport/Proxied — Bypass has none) and
 *  return the dropped files for the caller (Phase 3c) to delete best-effort —
 *  staying pure (no node:fs), the way 3a injected `fileExists`. */
export function clearSessionQuickProxies(p: Project): { project: Project; quickProxiesToDelete: string[] } {
  const quickProxiesToDelete: string[] = []
  const media_pool: Record<string, MediaItem> = {}
  for (const [id, item] of Object.entries(p.media_pool)) {
    const r = item.decode_route
    if ((r.route === 'direct-export' || r.route === 'proxied') && r.quick_proxy) {
      quickProxiesToDelete.push(r.quick_proxy)
      media_pool[id] = { ...item, decode_route: { ...r, quick_proxy: null } }
    } else media_pool[id] = item
  }
  return { project: { ...p, media_pool }, quickProxiesToDelete }
}

/** io/mod.rs:49 load_from_dir — the pure half: parse + schema-gate + media path
 *  reconcile + quick-proxy clear. NOTE: stale-proxy invalidation (the Proxied
 *  route's format_version) is `#[cfg(feature = "jobs")]` in Rust and rides the
 *  jobs-callback re-point; it is deliberately NOT done here. */
export function loadProjectFromJson(text: string, opts: { dir: string; join: (...parts: string[]) => string }): { project: Project; quickProxiesToDelete: string[] } {
  const parsed = parseProjectJson(text)
  const reconciled = reconcileMediaPaths(parsed, opts.dir, opts.join)
  return clearSessionQuickProxies(reconciled)
}
