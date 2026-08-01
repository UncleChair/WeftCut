import { describe, it, expect, vi } from 'vitest'
import { createTsActorHost } from '../ts-actor-host'

function makeDeps(overrides: {
  beginAgentSessionSlot?: (reason: string, client: string) => void
  endAgentSessionSlot?: () => void
} = {}) {
  const noopFs = { exists: () => false, readFile: () => '', writeFile: () => {}, mkdirp: () => {}, copyFile: () => {}, readdir: () => [], rm: () => {} }
  return {
    send: () => {}, mcpNotify: () => {}, fileExists: () => false,
    fs: noopFs as any, join: (...p: string[]) => p.join('/'),
    napi: { commitWorkspace: async () => {}, pushRecent: () => {}, setLastNewProjectParent: () => {}, enqueueJobsForMedia: () => {} } as any,
    compute: { probeMedia: async () => '{}', hashMediaSource: async () => 'h', parseSubtitles: async () => '{}', synthesizeSpeechCompute: async () => '{}' },
    enqueueWorkspaceCopy: async () => {},
    readFile: () => '',
    workspaceDir: () => null as string | null,
    ...overrides,
  }
}

describe('TsActorHost agent-session-end seam', () => {
  it('handleInvoke(agent_session_end) calls endAgentSessionSlot then actor.unlockHistory', async () => {
    const calls: string[] = []
    const host = createTsActorHost(makeDeps({
      endAgentSessionSlot: () => calls.push('endSlot'),
    }))
    host.start()
    // Lock history to simulate an active agent session.
    host.actor.lockHistory('agent cleanup')
    // Verify restore is blocked while locked.
    const cp = host.actor.checkpoint('cp1')
    expect(() => host.actor.restoreCheckpoint(cp)).toThrow(/HistoryLocked/)
    // End the session — should call endSlot then unlock.
    await host.handleInvoke('agent_session_end', {})
    expect(calls).toEqual(['endSlot'])
    // After the seam runs, unlockHistory must have been called — restore should now succeed.
    expect(() => host.actor.restoreCheckpoint(cp)).not.toThrow()
    host.stop()
  })

  it('handleInvoke(agent_session_end) calls endSlot before unlockHistory (seam order)', async () => {
    const calls: string[] = []
    const host = createTsActorHost(makeDeps({
      endAgentSessionSlot: () => calls.push('endSlot'),
    }))
    // Spy on actor.unlockHistory to record call order.
    const origUnlock = host.actor.unlockHistory.bind(host.actor)
    host.actor.unlockHistory = vi.fn(() => { calls.push('unlockHistory'); origUnlock() })
    host.start()
    await host.handleInvoke('agent_session_end', {})
    expect(calls).toEqual(['endSlot', 'unlockHistory'])
    host.stop()
  })

  it('beginAgentSessionSlot delegates to deps.beginAgentSessionSlot with the reason', () => {
    const spy = vi.fn()
    const host = createTsActorHost(makeDeps({ beginAgentSessionSlot: spy }))
    host.beginAgentSessionSlot('testing', 'local')
    expect(spy).toHaveBeenCalledWith('testing', 'local')
  })

  it('beginAgentSessionSlot is a no-op when dep is absent', () => {
    const host = createTsActorHost(makeDeps())
    expect(() => host.beginAgentSessionSlot('noop', 'local')).not.toThrow()
  })

  it('handleInvoke(agent_session_begin) mints the Pre-agent checkpoint, then flips the slot', async () => {
    const calls: Array<[string, string]> = []
    const host = createTsActorHost(makeDeps({
      beginAgentSessionSlot: (reason, client) => calls.push([reason, client]),
    }))
    host.start()
    await host.handleInvoke('agent_session_begin', { reason: 'manual pass', client: 'local' })
    expect(calls).toEqual([['manual pass', 'local']])
    // Same auto-checkpoint the MCP tool creates (actor.ts begin_agent_session arm).
    expect(host.actor.listCheckpoints().map((c) => c.label)).toContain('Pre-agent: manual pass')
    host.stop()
  })

  it('handleInvoke(agent_session_begin) defaults the client to local and rejects an empty reason', async () => {
    const spy = vi.fn()
    const host = createTsActorHost(makeDeps({ beginAgentSessionSlot: spy }))
    host.start()
    await host.handleInvoke('agent_session_begin', { reason: 'ui' })
    expect(spy).toHaveBeenCalledWith('ui', 'local')
    await expect(host.handleInvoke('agent_session_begin', { reason: '  ' })).rejects.toThrow(/reason/)
    host.stop()
  })
})
