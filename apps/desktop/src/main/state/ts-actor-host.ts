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
import { runHybrid, type ComputeNapi, type HybridDeps } from './hybrids'
import { MotifCatalog, type Manifest } from '../../shared/motifs/catalog'
import type { UserMotifStore } from '../motif/store'
import { runMotifTool, type MotifToolDeps } from '../motif/motifTools'
import type { BuiltinMotif, MotifLayerRef } from '../motif/authoring'
import type { MotifParams, MotifRebindEntry } from './model'

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
  /** Rust compute facade for the native-compute → TS-write hybrids (Phase 3d-e). */
  compute: ComputeNapi
  /** Queue the background workspace-copy job (Backend.enqueueWorkspaceCopy). */
  enqueueWorkspaceCopy: (mediaId: string, sourcePath: string) => Promise<void>
  /** node:fs readFile (utf8) — for the subtitle hybrid (Task 4). */
  readFile: (p: string) => string
  /** Current workspace directory (cached from backend). Null before first open/newWorkspace. */
  workspaceDir: () => string | null
  /** Push the TS-serialized project + history view into the Rust read-mirror
   *  (backend.setProjectMirror). Optional → omitted/no-op flag-off + in tests. */
  setProjectMirror?: (projectJson: string, historyViewJson: string) => void
  /** Flip the Rust agent-session slot ON/OFF (backend.beginAgentSessionSlot / endAgentSessionSlot). */
  beginAgentSessionSlot?: (reason: string) => void
  endAgentSessionSlot?: () => void
  /** Emit a record-panel LogBus pin-row via the Rust log surface (Phase 4a-i §2.1 parity).
   *  Optional → no-op when omitted (tests that do not care about logging, or flag-off path).
   *  Must never throw — wrap call sites in try/catch; a failing emit must not abort the mutation. */
  emitLog?: (entry: {
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error'
    category: { kind: 'Project' | 'Mcp' | 'System' | string; name?: string }
    source: { kind: 'User' } | { kind: 'Agent'; client: string } | { kind: 'System' }
    message: string
    details?: Record<string, unknown>
  }) => void
  /** list_motifs JSON from the backend — used to hydrate the actor's motif catalog
   *  after start() and after motif-store-mutating operations (install/delete/write/
   *  import/amend/create_edit). Optional → no-op when absent (tests, flag-off). */
  listMotifs?: () => Promise<string>
  /** On-disk user Motif store (Phase 2 — the TS authoring/read/install surface).
   *  Optional → guard in runMotif throws if absent. Tests that don't exercise
   *  motif tools omit this so they don't need a real temp-dir store. */
  motifStore?: UserMotifStore
  /** Built-in Motifs ({id, manifest, html}), loaded once at boot from the
   *  relocated served assets. Empty in tests that don't exercise built-ins.
   *  Optional — defaults to [] when absent. */
  motifBuiltins?: BuiltinMotif[]
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
  /** Host-level MCP call: delegates to actor.mcpCall, then emits the appropriate
   *  LogBus pin-row for restore_checkpoint / checkpoint / begin_agent_session on success.
   *  The emit is best-effort (try/catch) and never blocks or fails the call.
   *  server.ts calls this instead of actor.mcpCall directly for the 'ts' route. */
  mcpCall: (name: string, argsJson: string) => import('./mcp-commands.js').McpCallResult
  /** Hybrid deps (native-compute → TS-write). Exposed so the MCP host's hybrid
   *  branch can `runHybrid(name, args, tsHost.hybridDeps)` (server.ts). */
  hybridDeps: HybridDeps
  /** Host-level Motif tool dispatch (catalog read + authoring + install). Both
   *  the renderer `handleInvoke('motif')` and the MCP `route==='motif'` path use it. */
  motifTool: (name: string, args: Record<string, unknown>) => unknown
  /** Re-pull list_motifs → actor.setUserMotifManifests. Exposed so the file
   *  watcher can refresh the actor catalog when a Motif appears on disk with no
   *  store-mutating tool call (otherwise add_motif rejects it). */
  refreshMotifCatalog: () => void
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

/** Extract Manifest-shaped entries from a `list_motifs` JSON array.
 *  list_motifs returns every manifest field plus `html`/`status`/`content_hash`;
 *  we keep only non-builtin entries (installed + draft) — built-ins are already
 *  in the catalog's built-in layer and built-ins always win on id collision. */
function manifestsFromList(entries: unknown[]): Manifest[] {
  const out: Manifest[] = []
  for (const e of entries) {
    if (e == null || typeof e !== 'object') continue
    const entry = e as Record<string, unknown>
    // Skip built-ins — already present in MotifCatalog's built-in layer.
    if (entry['status'] === 'builtin') continue
    // Keep only entries that have at minimum the required Manifest fields.
    if (typeof entry['id'] !== 'string' || typeof entry['name'] !== 'string') continue
    out.push(entry as unknown as Manifest)
  }
  return out
}

export function createTsActorHost(deps: TsActorHostDeps): TsActorHost {
  // Single shared idGen: used for blankProject, createActor, and orchestratorDeps.
  const idGen = uuidV7Gen()
  // The actor catalog's user layer is a watcher-refreshed cache. Back it with a
  // store fallback so add_motif resolves a disk-written Motif the instant
  // list_motifs (disk-backed) sees it, without waiting for the debounced refresh.
  const store = deps.motifStore
  const motifCatalog = new MotifCatalog(store ? (id) => store.getMotif(id)?.manifest ?? null : undefined)
  const actor = createActor({ initial: blankProject(idGen, 'untitled'), idGen, clock: () => new Date().toISOString(), motifCatalog })
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

  // Hybrid orchestrator deps (native-compute → TS-write). enqueueDerivatives here
  // takes the inserted ITEMS (vs the orchestrator's whole-Project variant) and
  // hands them straight to the Backend's open-time job re-fan-out napi.
  const hybridDeps: HybridDeps = {
    actor,
    compute: deps.compute,
    enqueueDerivatives: async (items) => { await deps.napi.enqueueJobsForMedia(JSON.stringify(items)) },
    enqueueWorkspaceCopy: deps.enqueueWorkspaceCopy,
    workspaceDir: deps.workspaceDir,
    readFile: deps.readFile,
    snapshotComposition: () => actor.snapshot().composition,
  }

  const persistence: PersistenceHandlers = {
    open: (dir) => openProject(orchestratorDeps, dir),
    saveAs: (dir) => saveProjectAs(orchestratorDeps, dir),
    newWorkspace: (a) => newWorkspace(orchestratorDeps, a),
    save: () => autosave.forceFlush(),
  }

  /** Best-effort refresh the actor's user motif layer from list_motifs.
   *  Called on start() and after motif-store-mutating hybrid channels
   *  (install_motif, delete_motif, write_motif_draft, amend_motif_draft,
   *  create_edit_draft, import_motif). A refresh failure must never abort. */
  function refreshMotifCatalog(): void {
    deps.listMotifs?.().then((j) => {
      actor.setUserMotifManifests(manifestsFromList(JSON.parse(j) as unknown[]))
    }).catch(() => {})
  }

  function runMotif(name: string, args: Record<string, unknown>): unknown {
    if (!deps.motifStore) throw new Error('motifTool: motifStore not configured')
    const motifToolDeps: MotifToolDeps = {
      store: deps.motifStore,
      builtins: deps.motifBuiltins ?? [],
      motifLayers: () =>
        actor.snapshot().tracks
          .flatMap((t) => t.layers)
          .filter((l) => l.params.kind === 'Motif')
          .map((l) => { const p = l.params as MotifParams; return { layerId: l.id, motifId: p.motif_id, version: p.motif_version, props: p.props } satisfies MotifLayerRef }),
      dispatchRebind: (updates: MotifRebindEntry[]) => { const r = actor.dispatch('rebind_motif', { updates }); if (!r.ok) throw new Error(JSON.stringify(r.error)) },
      emitChanged: () => deps.send('motifs:changed', {}),
      refreshCatalog: () => refreshMotifCatalog(),
      readFile: deps.readFile,
      emitLog: (entry) => { try { deps.emitLog?.(entry) } catch (err) { console.warn('[ts-actor-host] emitLog failed (motif)', err) } },
    }
    return runMotifTool(name, args, motifToolDeps)
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

  // ── LogBus pin-row helpers (Phase 4a-i §2.1) ────────────────────────────────
  // Emits are best-effort: a failing emitLog must never abort the mutation.
  // All pin-rows: level 'info', category {kind:'Project'}.

  function emitRestoreLog(id: string, label: string | null, source: { kind: 'User' } | { kind: 'Agent'; client: string }): void {
    try {
      deps.emitLog?.({
        level: 'info',
        category: { kind: 'Project' },
        source,
        message: label != null ? `Restored to checkpoint: ${label}` : `Restored to checkpoint: ${id}`,
        details: { kind: 'Restore', checkpoint_id: id, label: label ?? null },
      })
    } catch (err) { console.warn('[ts-actor-host] emitLog failed (restore)', err) }
  }

  function emitCheckpointLog(id: string, label: string, source: { kind: 'Agent'; client: string }): void {
    try {
      deps.emitLog?.({
        level: 'info',
        category: { kind: 'Project' },
        source,
        message: `Checkpoint: ${label}`,
        details: { kind: 'Checkpoint', id, label },
      })
    } catch (err) { console.warn('[ts-actor-host] emitLog failed (checkpoint)', err) }
  }

  /** Host-level MCP wrapper. Delegates to actor.mcpCall; on a successful result
   *  emits the pin-row LogBus entry for restore_checkpoint / checkpoint /
   *  begin_agent_session (best-effort, try/catch). Returns the actor result unchanged. */
  function mcpCall(name: string, argsJson: string): import('./mcp-commands.js').McpCallResult {
    const result = actor.mcpCall(name, argsJson)
    if (!result.ok) return result
    try {
      const a = JSON.parse(argsJson) as Record<string, unknown>
      if (name === 'restore_checkpoint') {
        const cpId = (a.checkpoint_id as string | undefined) ?? ''
        const label = actor.listCheckpoints().find((c) => c.id === cpId)?.label ?? null
        emitRestoreLog(cpId, label, { kind: 'Agent', client: 'mcp' })
      } else if (name === 'checkpoint') {
        const label = ((a.label as string | undefined) ?? '').trim()
        const cpId = result.result.content[0]?.text ?? ''
        emitCheckpointLog(cpId, label, { kind: 'Agent', client: 'mcp' })
      } else if (name === 'begin_agent_session') {
        const reason = ((a.reason as string | undefined) ?? '').trim()
        const label = `Pre-agent: ${reason}`
        const payload = JSON.parse(result.result.content[0]?.text ?? '{}') as { checkpoint_id?: string }
        const cpId = payload.checkpoint_id ?? ''
        emitCheckpointLog(cpId, label, { kind: 'Agent', client: 'mcp' })
      }
    } catch (err) { console.warn('[ts-actor-host] emitLog failed (mcpCall post-hook)', err) }
    return result
  }

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
        if (channel === 'project_restore_checkpoint') {
          // Emit the Restore pin-row (User source). The checkpoint is kept on restore,
          // so listCheckpoints() still resolves the id → label after the call.
          const cpId = (args.checkpointId as string | undefined) ?? ''
          const label = actor.listCheckpoints().find((c) => c.id === cpId)?.label ?? null
          emitRestoreLog(cpId, label, { kind: 'User' })
        }
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
      case 'hybrid': {
        const hybridResult = await runHybrid(route.tool, args, hybridDeps)
        return hybridResult
      }
      case 'motif':
        return runMotif(route.tool, args)
      case 'reject': return reject(route.reason)
      case 'rust': return reject(`router bug: ${channel} reached the TS host but is a Rust channel`)
    }
  }

  return {
    actor,
    handleInvoke,
    mcpCall,
    hybridDeps,
    motifTool: runMotif,
    refreshMotifCatalog,
    beginAgentSessionSlot(reason: string) { deps.beginAgentSessionSlot?.(reason) },
    start() {
      if (!unsub) unsub = actor.subscribe(emitChange)
      autosave.start()
      pushMirror()
      refreshMotifCatalog()
    },
    stop() {
      autosave.stop()
      if (unsub) { unsub(); unsub = null }
    },
  }
}
