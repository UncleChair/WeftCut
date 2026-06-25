// apps/desktop/src/main/state/ts-actor-host.ts
import { createActor, type ActorHandle, type ChangeEvent } from './actor'
import { uuidV7Gen } from './ids'
import { blankProject } from './model'
import { buildProjectSummary } from './summary'
import { routeChannel } from './router'
import { createAutosave, type AutosaveController, type AutosaveFs } from './autosave'
import { openProject, saveProjectAs, newWorkspace, makeEnqueueDerivatives, type WorkspaceNapi, type OrchestratorFs } from './workspace-orchestrator'
import { serializeProjectToJson } from './persistence'
import { agentSessionEnd } from './agent-session-seam'

export interface TsActorHostDeps {
  /** mainWindow.webContents.send('evt:'+event, payload) */
  send: (event: string, payload: unknown) => void
  /** mcpHost.notifyChange(payload) — the mcp:change relay. */
  mcpNotify: (payload: unknown) => void
  /** fs.existsSync, for buildProjectSummary's media-availability checks. */
  fileExists: (absPath: string) => boolean
  /** Combined OrchestratorFs & AutosaveFs adapter — node:fs in production, in-memory in tests. */
  fs: OrchestratorFs & AutosaveFs
  /** node:path.join — injected for testability. */
  join: (...parts: string[]) => string
  /** Backend napi facade for workspace bookkeeping. */
  napi: WorkspaceNapi
  /** Current workspace directory (cached from backend). Null before first open/newWorkspace. */
  workspaceDir: () => string | null
  /** Push the TS-serialized project + history view into the Rust read-mirror
   *  (backend.setProjectMirror). Optional → omitted/no-op flag-off + in tests. */
  setProjectMirror?: (projectJson: string, historyViewJson: string) => void
  /** Flip the Rust agent-session slot ON/OFF (backend.beginAgentSessionSlot / endAgentSessionSlot). */
  beginAgentSessionSlot?: (reason: string) => void
  endAgentSessionSlot?: () => void
}

interface PersistenceHandlers {
  open: (dir: string) => Promise<void>
  saveAs: (dir: string) => Promise<void>
  newWorkspace: (args: { parentFolder: string; name: string; width: number; height: number; fpsNum: number; fpsDen: number }) => Promise<string>
  save: () => Promise<void>
}

export interface TsActorHost {
  actor: ActorHandle
  handleInvoke: (channel: string, args: Record<string, unknown>) => Promise<unknown>
  beginAgentSessionSlot: (reason: string) => void
  start: () => void
  stop: () => void
}

/** Rust project:changed payload shape (napi_backend.rs:155-165). */
export function mapChangeEvent(e: ChangeEvent): { op_id: string; actor_kind: 'user' | 'agent'; client: string | null; summary: string; timestamp: string; affected_count: number } {
  const actor_kind = e.actor.kind === 'Agent' ? 'agent' : 'user'
  const client = e.actor.kind === 'Agent' ? e.actor.client : null
  return { op_id: e.op_id, actor_kind, client, summary: e.summary, timestamp: e.timestamp, affected_count: e.affected.length }
}

export function createTsActorHost(deps: TsActorHostDeps): TsActorHost {
  // Single shared idGen: used for blankProject, createActor, and orchestratorDeps.
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'untitled'), idGen, clock: () => new Date().toISOString() })
  let unsub: (() => void) | null = null

  const autosave: AutosaveController = createAutosave({
    actor,
    fs: deps.fs,
    workspaceDir: deps.workspaceDir,
    join: deps.join,
    serialize: serializeProjectToJson,
  })

  const enqueueDerivatives = makeEnqueueDerivatives(deps.napi)
  const orchestratorDeps = { actor, napi: deps.napi, fs: deps.fs, join: deps.join, idGen, enqueueDerivatives }

  const persistence: PersistenceHandlers = {
    open: (dir) => openProject(orchestratorDeps, dir),
    saveAs: (dir) => saveProjectAs(orchestratorDeps, dir),
    newWorkspace: (a) => newWorkspace(orchestratorDeps, a),
    save: () => autosave.forceFlush(),
  }

  function pushMirror(): void {
    if (!deps.setProjectMirror) return
    deps.setProjectMirror(serializeProjectToJson(actor.snapshot()), JSON.stringify(actor.historyView(100)))
  }

  function emitChange(e: ChangeEvent): void {
    pushMirror()
    const payload = mapChangeEvent(e)
    deps.send('project:changed', payload)
    deps.mcpNotify(payload)
  }

  function reject(reason: string): never { throw new Error(reason) }

  async function handleInvoke(channel: string, args: Record<string, unknown>): Promise<unknown> {
    const route = routeChannel(channel)
    switch (route.kind) {
      case 'command': {
        const r = actor.command(channel, args)
        // CommandError → renderer error contract: Rust's invoke returns a string error;
        // the renderer's invoke (bridge/ipc.ts) propagates IPC rejections as Error
        // objects where `.message` is the error string. Serialize the CommandError as
        // JSON so the renderer sees a structured message — same surface as Rust's
        // Debug-format string that the existing renderer error handling catches.
        if (!r.ok) throw new Error(JSON.stringify(r.error))
        return r.value
      }
      case 'summary':
        return buildProjectSummary(actor.snapshot(), actor.historyStatus(), deps.fileExists)
      case 'projectSettings':
        return actor.snapshot().settings
      case 'open': return persistence.open((args as { path: string }).path)
      case 'saveAs': return persistence.saveAs((args as { path: string }).path)
      case 'newWorkspace': return persistence.newWorkspace(args as never)
      case 'save': return persistence.save()
      case 'agentSessionEnd':
        agentSessionEnd({
          endSlot: () => deps.endAgentSessionSlot?.(),
          unlockHistory: () => actor.unlockHistory(),
        })
        return null
      case 'reject': return reject(route.reason)
      case 'rust': return reject(`router bug: ${channel} reached the TS host but is a Rust channel`)
    }
  }

  return {
    actor,
    handleInvoke,
    beginAgentSessionSlot(reason: string) { deps.beginAgentSessionSlot?.(reason) },
    start() {
      if (!unsub) unsub = actor.subscribe(emitChange)
      autosave.start()
      pushMirror()
    },
    stop() {
      autosave.stop()
      if (unsub) { unsub(); unsub = null }
    },
  }
}
