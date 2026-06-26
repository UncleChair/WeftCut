import { describe, it, expect, vi } from 'vitest'
import { handleCallTool } from './server'
import { createActor } from '../state/actor'
import { uuidV7Gen } from '../state/ids'
import { blankProject } from '../state/model'
import { mediaItemTemplate } from '../state/mutations/media'

const MID = '00000000-0000-0000-0000-0000000000aa'

function tsHostStub() {
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'flip'), idGen, clock: () => '<TS>' })
  // Minimal hybridDeps: fake compute + spy enqueues, no workspace.
  const hybridDeps = {
    actor,
    compute: {
      probeMedia: vi.fn(async () => JSON.stringify(mediaItemTemplate(MID, 'Video', 4_000_000))),
      parseSubtitles: vi.fn(), synthesizeSpeechCompute: vi.fn(),
    },
    enqueueDerivatives: vi.fn(async () => {}),
    enqueueWorkspaceCopy: vi.fn(async () => {}),
    workspaceDir: () => null,
    readFile: () => '',
    snapshotComposition: () => actor.snapshot().composition,
  }
  return { actor, mcpCall: (name: string, argsJson: string) => actor.mcpCall(name, argsJson), hybridDeps, handleInvoke: async () => null, start: () => {}, stop: () => {}, beginAgentSessionSlot: () => {} } as any
}
function fakeBackend(mcpCallTool: (n: string, a: string) => Promise<string>) {
  return { mcpCallTool, mcpReadResource: async () => '{"ok":true,"result":{}}', mcpCatalog: async () => '{"tools":[]}' } as any
}

describe('handleCallTool flip routing', () => {
  it('routes a mutation tool to the TS actor (state changes)', async () => {
    const ts = tsHostStub()
    const track = ts.actor.snapshot().tracks[0].id
    const out: any = await handleCallTool(fakeBackend(async () => { throw new Error('rust must not be called') }), () => ts, 'add_color_layer', { track_id: track, color: { r: 0, g: 0, b: 0, a: 1 }, t_start_us: 0, t_end_us: 1_000_000 })
    expect(out.content[0].type).toBe('text') // a uuid
    const layers = ts.actor.snapshot().tracks.reduce((n: number, t: any) => n + t.layers.length, 0)
    expect(layers).toBe(1)
  })
  it('routes synthesize_speech through the hybrid (not blocked, Task 6)', async () => {
    // synthesize_speech is now a hybrid (landed Task 6); it must NOT be rejected
    // with -32600. The fake synthesizeSpeechCompute returns '{}'  (no media_item)
    // so the arm throws an actor-write error — but NOT a -32600 blocked rejection.
    const ts = tsHostStub()
    const result = await handleCallTool(fakeBackend(async () => '{}'), () => ts, 'synthesize_speech', { text: 'hi' })
      .then((v) => ({ ok: true as const, v }), (e: Error) => ({ ok: false as const, e }))
    // Must NOT have been rejected with code -32600 (that is the blocked path).
    if (!result.ok) {
      expect((result.e as { code?: number }).code).not.toBe(-32600)
    }
    // The hybrid path was entered (compute was called even though it returned '{}'
    // which causes a downstream throw; what matters is -32600 is not raised).
    expect(ts.hybridDeps.compute.synthesizeSpeechCompute).toHaveBeenCalled()
  })
  it('routes import_media through the hybrid (TS-write), returning the media id as text', async () => {
    const ts = tsHostStub()
    const out: any = await handleCallTool(fakeBackend(async () => { throw new Error('rust must not be called') }), () => ts, 'import_media', { path: 'C:/x.mp4' })
    expect(out.content[0]).toEqual({ type: 'text', text: MID })
    expect(ts.actor.snapshot().media_pool[MID]).toBeTruthy()
    expect(ts.hybridDeps.enqueueDerivatives).toHaveBeenCalledTimes(1)
  })
  it('forwards a rust-routed read to the backend', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(async () => '{"ok":true,"result":{"content":[{"type":"text","text":"[]"}]}}')
    await handleCallTool(fakeBackend(spy), () => ts, 'groups_list', {})
    expect(spy).toHaveBeenCalledWith('groups_list', JSON.stringify({}))
  })
  it('flag-off (no tsHost) forwards everything to the backend', async () => {
    const spy = vi.fn(async () => '{"ok":true,"result":{"content":[]}}')
    await handleCallTool(fakeBackend(spy), () => null, 'add_color_layer', {})
    expect(spy).toHaveBeenCalled()
  })
  it('flips the agent-session slot after a successful begin_agent_session', async () => {
    const ts = tsHostStub()
    const spy = vi.fn()
    ts.beginAgentSessionSlot = spy
    await handleCallTool(fakeBackend(async () => { throw new Error('rust must not be called') }), () => ts, 'begin_agent_session', { reason: 'cleanup' })
    expect(spy).toHaveBeenCalledWith('cleanup')
  })
})
