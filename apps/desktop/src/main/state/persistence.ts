// apps/desktop/src/main/state/persistence.ts
//
// The PURE on-disk persistence surface: project serialization + the
// schema-version gate. No node:fs here — the file read/write/delete shell and
// the workspace/cache/LogBus/recents/jobs orchestration live in
// workspace-orchestrator.ts (injected fs). Filesystem/platform impurities are
// injected (`join` for path reconcile) or returned (quick-proxy files to
// delete).
import { SCHEMA_VERSION, type MediaItem, type Project } from './model'
import { serializeProject, parseProject, type GridRepair, type ParseProjectOptions } from './serialize'

/** The on-disk project file name inside a workspace folder. */
export const PROJECT_FILE = 'project.json'

/** 2-space-indented JSON, NO trailing newline. Round-trip fidelity, not
 *  byte-identical key order, is the contract. */
export function serializeProjectToJson(p: Project): string {
  return JSON.stringify(serializeProject(p), null, 2)
}

/** The schema-version gate. Equal → ok; below → re-create in a fresh workspace;
 *  above → update the app. Pre-release: no migration path. */
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

/** Deserialize project.json text → Project, gated on schema version.
 *  JSON.parse throws on malformed text; schemaGate runs BEFORE the structural cast
 *  so the rich version-specific guidance wins over parseProject's generic check. */
export function parseProjectJson(text: string, opts: ParseProjectOptions = {}): Project {
  const json: unknown = JSON.parse(text)
  schemaGate(json)
  return parseProject(json, opts)
}

/** On load, an item whose `path_rel` is populated has its in-memory `path_abs`
 *  recomputed as join(dir, path_rel), reconciling the saved absolute path with
 *  the current (possibly-moved) workspace location. Items with
 *  `path_rel === null` (import-worker copy pending, or synthesized Cache/ media)
 *  keep their serialized `path_abs` verbatim. `join` is injected: node:path in
 *  production, a posix joiner in tests. */
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
 *  return the dropped files for the caller to delete best-effort — staying
 *  pure (no node:fs; the caller owns the filesystem). */
export function clearSessionQuickProxies(p: Project): { project: Project; quickProxiesToDelete: string[] } {
  const quickProxiesToDelete: string[] = []
  const media_pool: Record<string, MediaItem> = {}
  for (const [id, item] of Object.entries(p.media_pool)) {
    const r = item.decode_route
    if ((r.route === 'direct-export' || r.route === 'proxied' || r.route === 'native-sw') && r.quick_proxy) {
      quickProxiesToDelete.push(r.quick_proxy)
      media_pool[id] = { ...item, decode_route: { ...r, quick_proxy: null } }
    } else media_pool[id] = item
  }
  return { project: { ...p, media_pool }, quickProxiesToDelete }
}

/** The pure half of a project load: parse + schema-gate + media path reconcile
 *  + quick-proxy clear. NOTE: stale-proxy invalidation (the Proxied route's
 *  `format_version`) is deliberately NOT done here — it rides the background
 *  jobs write-back. */
export function loadProjectFromJson(text: string, opts: { dir: string; join: (...parts: string[]) => string; onGridRepair?: (repairs: readonly GridRepair[]) => void }): { project: Project; quickProxiesToDelete: string[] } {
  // Omitting the hook (tests) leaves `onGridRepair: undefined`, which parseProject
  // falls back to its console default for — the reporting default is unchanged.
  const parsed = parseProjectJson(text, { onGridRepair: opts.onGridRepair })
  const reconciled = reconcileMediaPaths(parsed, opts.dir, opts.join)
  return clearSessionQuickProxies(reconciled)
}
