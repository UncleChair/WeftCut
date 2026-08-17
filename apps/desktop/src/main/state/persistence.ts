// apps/desktop/src/main/state/persistence.ts
//
// The PURE on-disk persistence surface: project serialization + the
// schema-version gate. No node:fs here — the file read/write/delete shell and
// the workspace/cache/LogBus/recents/jobs orchestration live in
// workspace-orchestrator.ts (injected fs). Filesystem/platform impurities are
// injected (`join` for path reconcile) or returned (quick-proxy files to
// delete).
import { SCHEMA_VERSION, type MediaItem, type Project } from './model'
import { upgradeWire } from './migrate'
import { serializeProject, parseProject, type GridRepair, type ParseProjectOptions } from './serialize'

/** The on-disk project file name inside a workspace folder. */
export const PROJECT_FILE = 'project.json'

/** Where the pre-upgrade bytes are kept when the migration chain moves a project
 *  forward: beside `project.json`, named for the version it came from.
 *
 *  Deliberately NOT in `Backups/`. That directory is the autosave's rolling
 *  snapshot set — 20 newest, gc'd by filename — and its snapshots are taken
 *  AFTER a write, so by the time one exists the upgraded bytes are already what
 *  got copied. The one file that can restore a project a bad migration step
 *  mangled must not be subject to a retention policy at all. */
export function preUpgradeBackupFile(fromVersion: number): string {
  return `project.pre-v${fromVersion}.json`
}

/** 2-space-indented JSON, NO trailing newline. Round-trip fidelity, not
 *  byte-identical key order, is the contract. */
export function serializeProjectToJson(p: Project): string {
  return JSON.stringify(serializeProject(p), null, 2)
}

/** The schema-version gate: refuse what this build cannot read, and report the
 *  version of what it can. Two refusals only —
 *
 *  - a missing / non-numeric version: not a project file this build recognises;
 *  - a version AHEAD of the build: the file may carry fields and semantics that
 *    do not exist here, and writing it back would silently drop them.
 *
 *  An OLDER version is deliberately NOT a refusal — it is the migration chain's
 *  input (migrate.ts). The ahead-of-build message stays version-agnostic on
 *  purpose: "update the app" is a guess that happens to be wrong for the file it
 *  fires on most often, a `.vproj` left behind by a different build of this repo.
 */
export function schemaGate(project: unknown): number {
  const v = (project as { schema_version?: unknown })?.schema_version
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`project schema version is missing or non-numeric (this build reads v${SCHEMA_VERSION})`)
  }
  if (v > SCHEMA_VERSION) {
    throw new Error(
      `project.json was written by a different build (schema v${v}); this build reads v${SCHEMA_VERSION}.`,
    )
  }
  return v
}

/** A parsed project plus what the load had to do to get there. */
export interface ParsedProjectFile {
  project: Project
  /** The on-disk version, when the chain upgraded it; null when the file was
   *  already current. The caller preserves the pre-upgrade bytes off the back of
   *  this — see `openProject`. */
  upgradedFrom: number | null
}

/** Deserialize project.json text → Project: parse → gate → upgrade → cast.
 *  JSON.parse throws on malformed text; the gate runs BEFORE the structural cast
 *  so the rich version-specific guidance wins over parseProject's generic check,
 *  and the chain runs before it so the cast only ever sees the current shape. */
export function parseProjectJson(text: string, opts: ParseProjectOptions = {}): ParsedProjectFile {
  const json: unknown = JSON.parse(text)
  const version = schemaGate(json)
  const { wire } = upgradeWire(json as Record<string, unknown>, version, SCHEMA_VERSION)
  return { project: parseProject(wire, opts), upgradedFrom: version === SCHEMA_VERSION ? null : version }
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

/** The pure half of a project load: parse + schema-gate + schema upgrade + media
 *  path reconcile + quick-proxy clear. NOTE: stale-proxy invalidation (the
 *  Proxied route's `format_version`) is deliberately NOT done here — it rides the
 *  background jobs write-back. */
export function loadProjectFromJson(text: string, opts: { dir: string; join: (...parts: string[]) => string; onGridRepair?: (repairs: readonly GridRepair[]) => void }): { project: Project; quickProxiesToDelete: string[]; upgradedFrom: number | null } {
  // Omitting the hook (tests) leaves `onGridRepair: undefined`, which parseProject
  // falls back to its console default for — the reporting default is unchanged.
  const { project, upgradedFrom } = parseProjectJson(text, { onGridRepair: opts.onGridRepair })
  const reconciled = reconcileMediaPaths(project, opts.dir, opts.join)
  return { ...clearSessionQuickProxies(reconciled), upgradedFrom }
}
