// apps/desktop/src/main/state/__tests__/restore-log-parity.test.ts
// Verify that host.mcpCall + host.handleInvoke emit the correct LogBus
// pin-row for restore_checkpoint, checkpoint, and begin_agent_session.
import { describe, it, expect, vi } from 'vitest'
import { createTsActorHost } from '../ts-actor-host'

// Reuse the same in-memory deps from ts-actor-host.test.ts (inlined here
// to keep the test self-contained — no shared helper file needed).
function makeInMemoryDeps() {
  const vfs: Record<string, string> = {}
  const dirsMade = new Set<string>()
  const memFs = {
    exists: (p: string) => Object.prototype.hasOwnProperty.call(vfs, p) || dirsMade.has(p),
    readFile: (p: string) => {
      if (!Object.prototype.hasOwnProperty.call(vfs, p)) throw new Error(`vfs: file not found: ${p}`)
      return vfs[p]!
    },
    writeFile: (p: string, t: string) => { vfs[p] = t },
    mkdirp: (d: string) => { dirsMade.add(d) },
    copyFile: (s: string, d: string) => { vfs[d] = vfs[s]! },
    readdir: (d: string) => Object.keys(vfs).filter((k) => k.startsWith(d + '/') && k.slice(d.length + 1).indexOf('/') === -1).map((k) => k.slice(d.length + 1)),
    rm: (p: string) => { delete vfs[p] },
  }
  let wsDir: string | null = null
  const memNapi = {
    commitWorkspace: async (p: string) => { wsDir = p },
    pushRecent: (_p: string, _n: string) => {},
    setLastNewProjectParent: (_p: string) => {},
    enqueueJobsForMedia: async (_j: string) => {},
  }
  const deps = {
    send: (_event: string, _payload: unknown) => {},
    mcpNotify: () => {},
    fileExists: (p: string) => memFs.exists(p),
    fs: memFs,
    join: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
    napi: memNapi,
    compute: { probeMedia: async () => '{}', hashMediaSource: async () => 'h', parseSubtitles: async () => '{}', synthesizeSpeechCompute: async () => '{}' },
    enqueueWorkspaceCopy: async () => {},
    readFile: (p: string) => memFs.readFile(p),
    workspaceDir: () => wsDir,
  }
  return deps
}

describe('restore_checkpoint LogBus parity — MCP path', () => {
  it('emits a Restore log entry with Agent source on MCP restore_checkpoint', () => {
    const emitLog = vi.fn()
    const host = createTsActorHost({ ...makeInMemoryDeps(), emitLog })
    host.start()

    // Create a checkpoint via the host MCP boundary.
    const made = host.mcpCall('checkpoint', JSON.stringify({ label: 'cp1' }))
    expect(made.ok).toBe(true)
    const cpId = (made as { ok: true; result: { content: Array<{ text: string }> } }).result.content[0].text

    // Clear setup emits so the assertion only covers the restore call.
    emitLog.mockClear()

    host.mcpCall('restore_checkpoint', JSON.stringify({ checkpoint_id: cpId }))

    expect(emitLog).toHaveBeenCalledWith(expect.objectContaining({
      level: 'info',
      category: { kind: 'Project' },
      source: { kind: 'Agent', client: 'mcp' },
      message: expect.stringContaining('Restored to checkpoint'),
      details: expect.objectContaining({ kind: 'Restore', checkpoint_id: cpId }),
    }))
  })

  it('emits a Checkpoint log entry with Agent source on MCP checkpoint', () => {
    const emitLog = vi.fn()
    const host = createTsActorHost({ ...makeInMemoryDeps(), emitLog })
    host.start()
    emitLog.mockClear()

    const result = host.mcpCall('checkpoint', JSON.stringify({ label: 'cp1' }))
    expect(result.ok).toBe(true)
    const cpId = (result as { ok: true; result: { content: Array<{ text: string }> } }).result.content[0].text

    expect(emitLog).toHaveBeenCalledWith(expect.objectContaining({
      level: 'info',
      category: { kind: 'Project' },
      source: { kind: 'Agent', client: 'mcp' },
      message: 'Checkpoint: cp1',
      details: expect.objectContaining({ kind: 'Checkpoint', id: cpId, label: 'cp1' }),
    }))
  })

  it('emits a Checkpoint log entry on begin_agent_session', () => {
    const emitLog = vi.fn()
    const host = createTsActorHost({ ...makeInMemoryDeps(), emitLog })
    host.start()
    emitLog.mockClear()

    const result = host.mcpCall('begin_agent_session', JSON.stringify({ reason: 'batch edit' }))
    expect(result.ok).toBe(true)
    const payload = JSON.parse(
      (result as { ok: true; result: { content: Array<{ text: string }> } }).result.content[0].text,
    ) as { checkpoint_id: string }
    const cpId = payload.checkpoint_id
    const expectedLabel = 'Pre-agent: batch edit'

    expect(emitLog).toHaveBeenCalledWith(expect.objectContaining({
      level: 'info',
      category: { kind: 'Project' },
      source: { kind: 'Agent', client: 'mcp' },
      message: `Checkpoint: ${expectedLabel}`,
      details: expect.objectContaining({ kind: 'Checkpoint', id: cpId, label: expectedLabel }),
    }))
  })
})

describe('restore_checkpoint LogBus parity — renderer command path', () => {
  it('emits a Restore log entry with User source on renderer command restore', async () => {
    const emitLog = vi.fn()
    const host = createTsActorHost({ ...makeInMemoryDeps(), emitLog })
    host.start()

    // Create a checkpoint via the actor directly (not the MCP host boundary,
    // so we avoid the MCP checkpoint emit being the focus here).
    const cpId = host.actor.checkpoint('pre-restore')
    emitLog.mockClear()

    await host.handleInvoke('project_restore_checkpoint', { checkpointId: cpId })

    expect(emitLog).toHaveBeenCalledWith(expect.objectContaining({
      level: 'info',
      category: { kind: 'Project' },
      source: { kind: 'User' },
      message: expect.stringContaining('Restored to checkpoint'),
      details: expect.objectContaining({ kind: 'Restore', checkpoint_id: cpId }),
    }))
  })

  // The MCP path emits `Checkpoint:` rows for every creation; the renderer path
  // did not. RecordPanel builds a `checkpoint_id → ts` map from exactly those
  // rows and pairs each later Restore against it, so a user-created checkpoint
  // produced a Restore divider whose creation event never existed — and the
  // rolled-back range it should have hidden stayed on screen.
  it('emits a Checkpoint log entry with User source on renderer command create', async () => {
    const emitLog = vi.fn()
    const host = createTsActorHost({ ...makeInMemoryDeps(), emitLog })
    host.start()
    emitLog.mockClear()

    const cpId = await host.handleInvoke('project_create_checkpoint', { label: 'before the recut' })

    expect(emitLog).toHaveBeenCalledWith(expect.objectContaining({
      level: 'info',
      category: { kind: 'Project' },
      source: { kind: 'User' },
      message: 'Checkpoint: before the recut',
      details: expect.objectContaining({ kind: 'Checkpoint', id: cpId, label: 'before the recut' }),
    }))
  })

  it('pairs a user-created checkpoint with the user restore that follows it', async () => {
    const emitLog = vi.fn()
    const host = createTsActorHost({ ...makeInMemoryDeps(), emitLog })
    host.start()
    emitLog.mockClear()

    const cpId = await host.handleInvoke('project_create_checkpoint', { label: 'cp' })
    await host.handleInvoke('project_restore_checkpoint', { checkpointId: cpId })

    // The pairing RecordPanel performs: both halves present, keyed on the SAME
    // id, so the rolled-back range between them is computable.
    const details = emitLog.mock.calls.map((c) => (c[0] as { details: { kind: string; id?: string; checkpoint_id?: string } }).details)
    expect(details.find((d) => d.kind === 'Checkpoint')?.id).toBe(cpId)
    expect(details.find((d) => d.kind === 'Restore')?.checkpoint_id).toBe(cpId)
  })

  // Deleting a checkpoint destroys a named recovery point and records NOTHING on
  // the edit stack — the log ring is the only place it can leave a trace.
  it('emits a distinct CheckpointDeleted row on renderer command delete', async () => {
    const emitLog = vi.fn()
    const host = createTsActorHost({ ...makeInMemoryDeps(), emitLog })
    host.start()
    const cpId = host.actor.checkpoint('doomed')
    emitLog.mockClear()

    await host.handleInvoke('project_delete_checkpoint', { checkpointId: cpId })

    expect(emitLog).toHaveBeenCalledWith(expect.objectContaining({
      level: 'info',
      category: { kind: 'Project' },
      source: { kind: 'User' },
      // The label is read BEFORE the delete — afterwards there is nothing left
      // to name it with.
      message: 'Checkpoint deleted: doomed',
      details: expect.objectContaining({ kind: 'CheckpointDeleted', id: cpId, label: 'doomed' }),
    }))
    // NOT `kind: 'Checkpoint'`: RecordPanel keys its checkpoint→restore map on
    // that, and reusing it here would overwrite the creation timestamp with the
    // deletion's, corrupting every rolled-back range computed from it.
    const kinds = emitLog.mock.calls.map((c) => (c[0] as { details: { kind: string } }).details.kind)
    expect(kinds).not.toContain('Checkpoint')
  })

  it('emits nothing when the command itself is refused', async () => {
    const emitLog = vi.fn()
    const host = createTsActorHost({ ...makeInMemoryDeps(), emitLog })
    host.start()
    emitLog.mockClear()

    await expect(host.handleInvoke('project_delete_checkpoint', { checkpointId: '00000000-0000-7000-8000-00000000dead' })).rejects.toThrow()
    await expect(host.handleInvoke('project_create_checkpoint', { label: '   ' })).rejects.toThrow()
    expect(emitLog).not.toHaveBeenCalled()
  })
})
