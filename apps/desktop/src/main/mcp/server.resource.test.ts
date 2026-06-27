import { describe, it, expect, vi } from 'vitest'
import { handleReadResource } from './server'
import { createActor } from '../state/actor'
import { uuidV7Gen } from '../state/ids'
import { blankProject } from '../state/model'

function tsHostStub() {
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'res'), idGen, clock: () => '<TS>' })
  return { actor, motifTool: () => [] } as any
}
function fakeBackend(spy: (u: string, s?: string) => Promise<string>) {
  return { mcpReadResource: spy } as any
}
function contents(out: unknown) {
  return (out as { contents: Array<{ text: string; mimeType: string }> }).contents
}

describe('handleReadResource', () => {
  it('serves project://current from the actor without calling the backend', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(async () => '{"ok":true,"result":{"contents":[]}}')
    const out = await handleReadResource(fakeBackend(spy), () => ts, 'project://current')
    expect(spy).not.toHaveBeenCalled()
    expect(contents(out)[0].mimeType).toBe('application/json')
    expect(JSON.parse(contents(out)[0].text).project_id).toBe(ts.actor.snapshot().project_id)
  })
  it('serves project://history from the actor (no backend call)', async () => {
    const ts = tsHostStub()
    const out = await handleReadResource(fakeBackend(async () => { throw new Error('no backend') }), () => ts, 'project://history')
    const body = JSON.parse(contents(out)[0].text)
    expect(Array.isArray(body.ops)).toBe(true)
  })
  it('forwards project://compiled to the backend with the injected project', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(async (_u: string, _s?: string) => '{"ok":true,"result":{"contents":[{"uri":"project://compiled","mimeType":"application/json","text":"{}"}]}}')
    await handleReadResource(fakeBackend(spy), () => ts, 'project://compiled')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe('project://compiled')
    expect(JSON.parse(spy.mock.calls[0][1] as string).project.project_id).toBe(ts.actor.snapshot().project_id)
  })
  it('forwards media://{id} with the resolved MediaItem (null when absent)', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(async (_u: string, _s?: string) => '{"ok":true,"result":{"contents":[]}}')
    await handleReadResource(fakeBackend(spy), () => ts, 'media://gone/thumbnail')
    const injected = JSON.parse(spy.mock.calls[0][1] as string)
    expect('media' in injected).toBe(true)
    expect(injected.media).toBeNull()
  })
  it('forwards composition://meter with no state injection', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(async (_u: string, _s?: string) => '{"ok":true,"result":{"contents":[]}}')
    await handleReadResource(fakeBackend(spy), () => ts, 'composition://meter')
    expect(spy.mock.calls[0][1]).toBe('{}')
  })
})
