// apps/desktop/src/main/state/__tests__/restore-log-parity.test.ts
// TDD: verify that host.mcpCall + host.handleInvoke emit the correct LogBus
// pin-row for restore_checkpoint, checkpoint, and begin_agent_session.
// RED before the host-level mcpCall wrapper + emitLog dep exist; GREEN after.
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
    compute: { probeMedia: async () => '{}', parseSubtitles: async () => '{}', computeMotifRebind: async () => '{}', computeAckMotifRebind: async () => '{}', synthesizeSpeechCompute: async () => '{}' },
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
})
