import { describe, it, expect, vi } from 'vitest'
import { createTsActorHost } from '../ts-actor-host'

function makeDeps(overrides: {
  beginAgentSessionSlot?: (reason: string) => void
  endAgentSessionSlot?: () => void
} = {}) {
  const noopFs = { exists: () => false, readFile: () => '', writeFile: () => {}, mkdirp: () => {}, copyFile: () => {}, readdir: () => [], rm: () => {} }
  return {
    send: () => {}, mcpNotify: () => {}, fileExists: () => false,
    fs: noopFs as any, join: (...p: string[]) => p.join('/'),
    napi: { commitWorkspace: async () => {}, pushRecent: () => {}, setLastNewProjectParent: () => {}, enqueueJobsForMedia: () => {} } as any,
    compute: { probeMedia: async () => '{}', parseSubtitles: async () => '{}', synthesizeSpeechCompute: async () => '{}' },
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
    host.beginAgentSessionSlot('testing')
    expect(spy).toHaveBeenCalledWith('testing')
  })

  it('beginAgentSessionSlot is a no-op when dep is absent', () => {
    const host = createTsActorHost(makeDeps())
    expect(() => host.beginAgentSessionSlot('noop')).not.toThrow()
  })
})
