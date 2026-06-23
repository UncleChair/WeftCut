// apps/desktop/src/main/state/workspace-orchestrator.ts
//
// The TS-in-main re-home of commands/persistence.rs (project_open / save_as /
// new_workspace). Pure + dependency-injected: the TS actor handle, a WorkspaceNapi
// facade (the granular Rust bookkeeping), an OrchestratorFs (node:fs in production,
// in-memory in tests), node:path.join, and an idGen. Dormant in 3c-ii-b — the live
// wiring into src/main/index.ts is the 3c-ii-d flip. Mirrors the Rust handler order
// exactly: workspace bookkeeping (cache→workspace→agent-end→LogBus, inside
// commitWorkspace) BEFORE replace_state; recents AFTER a successful swap/write.
import type { ActorHandle } from './actor'
import type { IdGen } from './ids'
import type { Project } from './model'
import { blankProject } from './model'
import { loadProjectFromJson, serializeProjectToJson, PROJECT_FILE } from './persistence'

/** The Rust-native workspace bookkeeping, exposed over napi (Backend methods
 *  commit_workspace / push_recent / set_last_new_project_parent). */
export interface WorkspaceNapi {
  /** cache.set_workspace → workspace.set → agent_session end → LogBus rotate. */
  commitWorkspace(path: string): Promise<void>
  /** recents.push — after a successful replace_state / write. */
  pushRecent(path: string, displayName: string): Promise<void> | void
  /** recents.set_last_new_project_parent — new-workspace flow only. */
  setLastNewProjectParent(parent: string): Promise<void> | void
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
  /** Open-time derivative re-fan-out. A no-op in 3c-ii-b; 3c-ii-c injects the
   *  live kick-off (paired with the event-based jobs write-back). See plan S2. */
  enqueueDerivatives?: (project: Project) => void
}

/** project_open (persistence.rs:50-108). Pre-check sentinels → load (3b) →
 *  delete stale quick proxies → commit_workspace (pre-broadcast) → replace_state
 *  → push_recent → (deferred) derivative re-fan-out. */
export async function openProject(deps: OrchestratorDeps, dir: string): Promise<void> {
  const { actor, napi, fs, join } = deps
  // Typed sentinels for the two common failure modes (renderer matches them).
  if (!fs.exists(dir)) throw new Error('PROJECT_FOLDER_MISSING')
  const file = join(dir, PROJECT_FILE)
  if (!fs.exists(file)) throw new Error('NOT_PROJECT_FOLDER')

  const text = fs.readFile(file)
  const { project, quickProxiesToDelete } = loadProjectFromJson(text, { dir, join })
  // Best-effort: never fail the open on a leftover proxy we couldn't remove.
  for (const p of quickProxiesToDelete) { try { fs.rm(p) } catch { /* ignore */ } }

  // Re-point cache + workspace BEFORE the state swap, so project:changed
  // consumers see the workspace, not the boot fallback (persistence.rs:71-79).
  await napi.commitWorkspace(dir)
  actor.replaceState(project)                 // throws CommandFailure on invalid; matches Rust replace_state Err
  await napi.pushRecent(dir, project.metadata.name)

  // Re-fan-out derivative jobs (proxies/thumbnails/waveforms). Deferred to
  // 3c-ii-c with the jobs write-back rework (plan S2); a no-op until then.
  deps.enqueueDerivatives?.(project)
}

/** project_save_as (persistence.rs:23-48). snapshot → write project.json →
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

/** project_new_workspace (persistence.rs:116-171). Validate → blank project with
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
