import { describe, it, expect } from 'vitest'
import { createTsActorHost } from '../ts-actor-host'

function makeDeps(setProjectMirror: (p: string, h: string) => void) {
  const noopFs = { exists: () => false, readFile: () => '', writeFile: () => {}, mkdirp: () => {}, copyFile: () => {}, readdir: () => [], rm: () => {} }
  return {
    send: () => {}, mcpNotify: () => {}, fileExists: () => false,
    fs: noopFs as any, join: (...p: string[]) => p.join('/'),
    napi: { commitWorkspace: async () => {}, pushRecent: () => {}, setLastNewProjectParent: () => {}, enqueueJobsForMedia: () => {} } as any,
    workspaceDir: () => null as string | null,
    setProjectMirror,
  }
}

describe('TS host read-mirror push', () => {
  it('pushes the serialized project + history view at start and on every change', () => {
    const calls: Array<{ p: string; h: string }> = []
    const host = createTsActorHost(makeDeps((p, h) => calls.push({ p, h })))
    host.start()
    expect(calls.length, 'a bring-up push').toBe(1)
    // A mutation must trigger another push reflecting the new state.
    const before = calls.length
    const track = host.actor.snapshot().tracks[0].id
    host.actor.mcpCall('add_color_layer', JSON.stringify({ track_id: track, color: { r: 0, g: 0, b: 0, a: 1 }, t_start_us: 0, t_end_us: 1_000_000 }))
    expect(calls.length, 'a push per change').toBe(before + 1)
    const pushed = JSON.parse(calls[calls.length - 1].p)
    const layers = pushed.tracks.reduce((n: number, t: any) => n + t.layers.length, 0)
    expect(layers, 'the pushed project reflects the new layer').toBe(1)
    const hv = JSON.parse(calls[calls.length - 1].h)
    expect(Array.isArray(hv.ops), 'history view shape').toBe(true)
    host.stop()
  })
})
