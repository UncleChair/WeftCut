// apps/desktop/src/main/state/workspace-orchestrator.ts
//
// The TS-in-main home of workspace lifecycle (project_open / save_as /
// new_workspace). Pure + dependency-injected: the TS actor handle, a WorkspaceNapi
// facade (the granular Rust bookkeeping), an OrchestratorFs (node:fs in production,
// in-memory in tests), node:path.join, and an idGen; wired by src/main/index.ts.
// Handler order is LOAD-BEARING: workspace bookkeeping (cache→workspace→
// agent-end→LogBus, inside commitWorkspace) BEFORE replace_state; recents AFTER
// a successful swap/write.
import type { ActorHandle } from './actor'
import type { IdGen } from './ids'
import type { Project } from './model'
import { blankProject } from './model'
import { loadProjectFromJson, serializeProjectToJson, PROJECT_FILE, preUpgradeBackupFile } from './persistence'
import { relinkMissingMedia, type RelinkDeps, type RelinkReport } from './relink'
import { serializeProject, type GridRepair } from './serialize'

/** The Rust-native workspace bookkeeping, exposed over napi (Backend methods
 *  commit_workspace / push_recent / set_last_new_project_parent). */
export interface WorkspaceNapi {
  /** cache.set_workspace → workspace.set → agent_session end → LogBus rotate. */
  commitWorkspace(path: string): Promise<void>
  /** recents.push — after a successful replace_state / write. */
  pushRecent(path: string, displayName: string): Promise<void> | void
  /** recents.set_last_new_project_parent — new-workspace flow only. */
  setLastNewProjectParent(parent: string): Promise<void> | void
  /** jobs::enqueue_for_media per media item (open-time derivative re-fan-out +
   *  stale-proxy invalidation). mediaItemsJson = JSON array of serialized
   *  MediaItem. Async napi binding → Promise; the factory fire-and-forgets it. */
  enqueueJobsForMedia(mediaItemsJson: string): Promise<void> | void
}

/** Filesystem shell, injected so the orchestrator stays unit-testable. */
export interface OrchestratorFs {
  exists(path: string): boolean
  /** Throws if the file is missing — only called after `exists`. */
  readFile(path: string): string
  writeFile(path: string, text: string): void
  /** create_dir_all equivalent. */
  mkdirp(dir: string): void
  /** Best-effort delete (stale quick proxies); must not throw on a missing file. */
  rm(path: string): void
}

export interface OrchestratorDeps {
  actor: Pick<ActorHandle, 'replaceState' | 'snapshot'>
  napi: WorkspaceNapi
  fs: OrchestratorFs
  join: (...parts: string[]) => string
  idGen: IdGen
  /** Open-time derivative re-fan-out (paired with the event-based jobs
   *  write-back). Optional — omitted in tests; a no-op then. */
  enqueueDerivatives?: (project: Project) => void
  /** Open-time relink-by-content self-heal (relink.ts) for workspace-managed
   *  media whose on-disk filename changed in transit. Optional — omitted in
   *  tests / hosts without a native hash, and the open skips healing. */
  relink?: RelinkDeps
  /** Surfaced only when the heal did something (or left items missing) —
   *  the host turns it into a LogBus entry. Fired AFTER commitWorkspace
   *  (which rotates the per-workspace LogBus), never during the heal. */
  onRelink?: (report: RelinkReport) => void
  /** Surfaced only when `parseProject`'s load pass actually moved a timeline field
   *  (off-grid geometry, or a negative start) — the host turns it into a LogBus
   *  row so a silently-migrated project is visible. Same timing constraint as
   *  `onRelink`: fired AFTER commitWorkspace, never during the parse. */
  onGridRepair?: (repairs: readonly GridRepair[]) => void
  /** Surfaced only when the migration chain moved the project to a newer schema
   *  version — the one on-open event that changes what the next save will write.
   *  Same timing constraint as the two reports above. */
  onSchemaUpgrade?: (report: SchemaUpgradeReport) => void
}

export interface SchemaUpgradeReport {
  /** The schema version the file on disk was at. */
  from: number
  /** The version it now holds in memory (the build's `SCHEMA_VERSION`). */
  to: number
  /** The file the pre-upgrade bytes were preserved in, or null when that write
   *  failed — in which case the next save is the point of no return, and the row
   *  should say so rather than implying a safety net that isn't there. */
  backupFile: string | null
}

/** project_open. Pre-check sentinels → load (schema gate + migration chain) →
 *  delete stale quick proxies → preserve pre-upgrade bytes → relink heal →
 *  commit_workspace (pre-broadcast) → onGridRepair + onSchemaUpgrade reports →
 *  replace_state → onRelink report → push_recent → (deferred) derivative
 *  re-fan-out. All three reports sit after commit_workspace because it rotates
 *  the per-workspace LogBus. */
export async function openProject(deps: OrchestratorDeps, dir: string): Promise<void> {
  const { actor, napi, fs, join } = deps
  // Typed sentinels for the two common failure modes (renderer matches them).
  if (!fs.exists(dir)) throw new Error('PROJECT_FOLDER_MISSING')
  const file = join(dir, PROJECT_FILE)
  if (!fs.exists(file)) throw new Error('NOT_PROJECT_FOLDER')

  const text = fs.readFile(file)
  // CAPTURE the repair report, do not emit it here. The LogBus is per-workspace and
  // `commitWorkspace` below ROTATES it, so a row emitted during the parse lands in
  // the doomed pre-open bus (or nowhere at all on a fresh launch) and silently
  // vanishes — the same trap `OrchestratorDeps.onRelink` documents. Object
  // identity cannot carry the report instead: `reconcileMediaPaths` and
  // `clearSessionQuickProxies` both spread into fresh objects, so a WeakMap keyed on
  // the parsed project is already dead by the time `replaceState` runs.
  let gridRepairs: readonly GridRepair[] = []
  const loaded = loadProjectFromJson(text, { dir, join, onGridRepair: (r) => { gridRepairs = r } })
  let project = loaded.project
  const { quickProxiesToDelete } = loaded
  // Best-effort: never fail the open on a leftover proxy we couldn't remove.
  for (const p of quickProxiesToDelete) { try { fs.rm(p) } catch { /* ignore */ } }

  // A schema upgrade happened in memory only; project.json still holds the old
  // bytes until the first edit's autosave overwrites it. Preserve them NOW —
  // this is the last moment they exist, and if a migration step is wrong they are
  // the only way back. Written straight from `text` rather than re-serializing:
  // a re-serialization would already be the upgraded shape.
  //
  // Best-effort like the two heals below, and reported either way: an upgrade the
  // user is not told about is one they cannot second-guess. Skipped when the file
  // is already there, so opening the same project twice without editing (each
  // open upgrades again) cannot clobber the first, oldest copy.
  let schemaUpgrade: SchemaUpgradeReport | null = null
  if (loaded.upgradedFrom !== null) {
    const backupFile = preUpgradeBackupFile(loaded.upgradedFrom)
    let kept: string | null = backupFile
    try {
      const backupPath = join(dir, backupFile)
      if (!fs.exists(backupPath)) fs.writeFile(backupPath, text)
    } catch { kept = null }
    schemaUpgrade = { from: loaded.upgradedFrom, to: project.schema_version, backupFile: kept }
  }

  // Relink-by-content self-heal (relink.ts). Best-effort: a heal crash must
  // never block the open — the un-healed project still loads (MissingMedia UI).
  let relinkReport: RelinkReport | null = null
  if (deps.relink) {
    try {
      const healed = await relinkMissingMedia(project, dir, deps.relink)
      project = healed.project
      if (healed.report.healed.length > 0 || healed.report.missing.length > 0) relinkReport = healed.report
    } catch { /* keep the un-healed project */ }
  }

  // Re-point cache + workspace BEFORE the state swap, so project:changed
  // consumers see the workspace, not the boot fallback.
  await napi.commitWorkspace(dir)
  // Emitted BEFORE replace_state deliberately: the repair is what lets an older
  // project satisfy the backstop at all, so if the swap STILL fails validation this
  // row is the diagnostic that says what load already had to move.
  if (gridRepairs.length > 0) { try { deps.onGridRepair?.(gridRepairs) } catch { /* best-effort, never blocks the open */ } }
  // Before replace_state for the same reason as the grid-repair row: if the swap
  // fails validation, "this file was upgraded from v{n}" is the first thing worth
  // knowing about why.
  if (schemaUpgrade) { try { deps.onSchemaUpgrade?.(schemaUpgrade) } catch { /* best-effort, never blocks the open */ } }
  actor.replaceState(project)                 // throws CommandFailure on invalid
  // After commitWorkspace — see OrchestratorDeps.onRelink.
  if (relinkReport) { try { deps.onRelink?.(relinkReport) } catch { /* best-effort, never blocks the open */ } }
  await napi.pushRecent(dir, project.metadata.name)

  // Re-fan-out derivative jobs (proxies/thumbnails/waveforms). No-op when the
  // host doesn't inject it (tests).
  deps.enqueueDerivatives?.(project)
}

/** project_save_as. snapshot → write project.json →
 *  commit_workspace → push_recent. Never swaps state (the actor already holds it). */
export async function saveProjectAs(deps: OrchestratorDeps, dir: string): Promise<void> {
  const { actor, napi, fs, join } = deps
  const snap = actor.snapshot()
  fs.mkdirp(dir)                                              // save_to_dir's create_dir_all
  fs.writeFile(join(dir, PROJECT_FILE), serializeProjectToJson(snap))
  await napi.commitWorkspace(dir)
  await napi.pushRecent(dir, snap.metadata.name)
}

export interface NewWorkspaceArgs {
  parentFolder: string; name: string
  width: number; height: number; fpsNum: number; fpsDen: number
}

/** Build the `enqueueDerivatives` seam from the napi facade: serialize the
 *  project's media-pool values and hand them to the Rust open-time job re-fan-out
 *  (workspace-orchestrator's `enqueueDerivatives?` hook). Fire-and-forget (the
 *  Rust enqueue returns immediately; jobs run on tokio). Injected into the live
 *  OrchestratorDeps by the host. */
export function makeEnqueueDerivatives(
  napi: Pick<WorkspaceNapi, 'enqueueJobsForMedia'>,
): (project: Project) => void {
  return (project) => { void napi.enqueueJobsForMedia(JSON.stringify(Object.values((serializeProject(project) as { media_pool: Record<string, unknown> }).media_pool))) }
}

/** project_new_workspace. Validate → blank project with
 *  the canvas preset → write → commit_workspace → replace_state → push_recent +
 *  set_last_new_project_parent. Returns the created workspace path. */
export async function newWorkspace(deps: OrchestratorDeps, args: NewWorkspaceArgs): Promise<string> {
  const { actor, napi, fs, join, idGen } = deps
  const trimmed = args.name.trim()
  if (trimmed.length === 0) throw new Error('project name is required')
  if (args.width === 0 || args.height === 0 || args.fpsNum === 0 || args.fpsDen === 0) {
    throw new Error('invalid canvas preset')
  }
  const target = join(args.parentFolder, trimmed)
  if (fs.exists(target)) throw new Error(`folder already exists: ${target}`)

  const project = blankProject(idGen, trimmed)
  project.composition.width = args.width
  project.composition.height = args.height
  project.composition.fps = { num: args.fpsNum, den: args.fpsDen }

  fs.mkdirp(target)
  fs.writeFile(join(target, PROJECT_FILE), serializeProjectToJson(project))
  await napi.commitWorkspace(target)
  actor.replaceState(project)
  await napi.pushRecent(target, project.metadata.name)
  await napi.setLastNewProjectParent(args.parentFolder)
  return target
}
