import { describe, it, expect } from 'vitest'
import { createTsActorHost } from '../ts-actor-host'

// Regression for the 2026-06-25 soak finding: the actor.mcpCall dedicated arms
// (add_marker / add_color_layer / add_video_layer) cast non-uuid wire args with a
// raw `as` (color/numbers/label) and committed garbage to the actor instead of
// rejecting invalid_params before the commit. A struct-shaped bad arg (a string
// `color`) then broke the read-mirror push and wedged the actor. These assert the
// malformed input is rejected at the arg boundary with NO state mutation.
function makeDeps(setProjectMirror: (p: string, h: string) => void = () => {}) {
  const noopFs = { exists: () => false, readFile: () => '', writeFile: () => {}, mkdirp: () => {}, copyFile: () => {}, readdir: () => [], rm: () => {} }
  return {
    send: () => {}, mcpNotify: () => {}, fileExists: () => false,
    fs: noopFs as any, join: (...p: string[]) => p.join('/'),
    napi: { commitWorkspace: async () => {}, pushRecent: () => {}, setLastNewProjectParent: () => {}, enqueueJobsForMedia: () => {} } as any,
    compute: { probeMedia: async () => '{}', parseSubtitles: async () => '{}', synthesizeSpeechCompute: async () => '{}' },
    enqueueWorkspaceCopy: async () => {},
    readFile: () => '',
    workspaceDir: () => null as string | null,
    setProjectMirror,
  }
}

describe('mcpCall rejects malformed args before commit (soak finding)', () => {
  it('add_marker with a string color → invalid_params, no marker committed', () => {
    const pushes: number[] = []
    const host = createTsActorHost(makeDeps(() => pushes.push(1)))
    host.start()
    const pushesAtStart = pushes.length
    const r = host.actor.mcpCall('add_marker', JSON.stringify({ color: '#fff', label: 'x', t_us: 1_000_000 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_params')
    expect(host.actor.snapshot().markers.length, 'no garbage marker committed').toBe(0)
    expect(pushes.length, 'a rejected call must not push the mirror').toBe(pushesAtStart)
    host.stop()
  })

  it('add_marker with a string t_us → invalid_params, no marker committed', () => {
    const host = createTsActorHost(makeDeps())
    host.start()
    const r = host.actor.mcpCall('add_marker', JSON.stringify({ color: { r: 0, g: 128, b: 255, a: 255 }, label: 'x', t_us: 'abc' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_params')
    expect(host.actor.snapshot().markers.length).toBe(0)
    host.stop()
  })

  it('add_color_layer with a string color → invalid_params, no layer committed', () => {
    const host = createTsActorHost(makeDeps())
    host.start()
    const track = host.actor.snapshot().tracks[0].id
    const r = host.actor.mcpCall('add_color_layer', JSON.stringify({ track_id: track, color: '#fff', t_start_us: 0, t_end_us: 1_000_000 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_params')
    const layers = host.actor.snapshot().tracks.reduce((n, t) => n + t.layers.length, 0)
    expect(layers, 'no garbage layer committed').toBe(0)
    host.stop()
  })

  it('add_color_layer with a valid color still works (regression guard)', () => {
    const host = createTsActorHost(makeDeps())
    host.start()
    const track = host.actor.snapshot().tracks[0].id
    const r = host.actor.mcpCall('add_color_layer', JSON.stringify({ track_id: track, color: { r: 10, g: 20, b: 30, a: 255 }, t_start_us: 0, t_end_us: 1_000_000 }))
    expect(r.ok).toBe(true)
    const layers = host.actor.snapshot().tracks.reduce((n, t) => n + t.layers.length, 0)
    expect(layers).toBe(1)
    host.stop()
  })
})
