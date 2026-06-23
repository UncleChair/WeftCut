// apps/desktop/src/main/state/ts-actor-host.ts
import { createActor, type ActorHandle, type ChangeEvent } from './actor'
import { uuidV7Gen } from './ids'
import { blankProject } from './model'
import { buildProjectSummary } from './summary'
import { routeChannel } from './router'

export interface TsActorHostDeps {
  /** mainWindow.webContents.send('evt:'+event, payload) */
  send: (event: string, payload: unknown) => void
  /** mcpHost.notifyChange(payload) — the mcp:change relay. */
  mcpNotify: (payload: unknown) => void
  /** fs.existsSync, for buildProjectSummary's media-availability checks. */
  fileExists: (absPath: string) => boolean
  // Task 5 injects: openProject/saveProjectAs/newWorkspace/save handlers + autosave.
  persistence?: PersistenceHandlers
}

export interface PersistenceHandlers {
  open: (dir: string) => Promise<void>
  saveAs: (dir: string) => Promise<void>
  newWorkspace: (args: { parentFolder: string; name: string; width: number; height: number; fpsNum: number; fpsDen: number }) => Promise<string>
  save: () => Promise<void>
}

export interface TsActorHost {
  actor: ActorHandle
  handleInvoke: (channel: string, args: Record<string, unknown>) => Promise<unknown>
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
  const actor = createActor({ initial: blankProject(uuidV7Gen(), 'untitled'), idGen: uuidV7Gen(), clock: () => new Date().toISOString() })
  let unsub: (() => void) | null = null

  function emitChange(e: ChangeEvent): void {
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
      case 'open': return deps.persistence!.open((args as { path: string }).path)
      case 'saveAs': return deps.persistence!.saveAs((args as { path: string }).path)
      case 'newWorkspace': return deps.persistence!.newWorkspace(args as never)
      case 'save': return deps.persistence!.save()
      case 'reject': return reject(route.reason)
      case 'rust': return reject(`router bug: ${channel} reached the TS host but is a Rust channel`)
    }
  }

  return {
    actor,
    handleInvoke,
    start() { if (!unsub) unsub = actor.subscribe(emitChange) },
    stop() { if (unsub) { unsub(); unsub = null } },
  }
}
