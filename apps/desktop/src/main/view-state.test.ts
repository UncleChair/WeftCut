import { describe, it, expect } from 'vitest'
import { createViewStateStore, type ViewStateFs } from './view-state'

const WS = '/ws'
const FILE = '/ws/view.json'

function memFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed))
  const fs: ViewStateFs = {
    exists: (p) => files.has(p),
    readFile: (p) => { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v },
    writeFile: (p, t) => { files.set(p, t) },
    rename: (a, b) => { const v = files.get(a); if (v === undefined) throw new Error('ENOENT'); files.set(b, v); files.delete(a) },
    mkdirp: () => {},
  }
  return { fs, files }
}
const store = (seed?: Record<string, string>) =>
  createViewStateStore({ ...memFs(seed), join: (...p) => p.join('/') })

describe('view-state store', () => {
  it('defaults when no file', () => {
    const got = store().load(WS)
    expect(got.timeline_px_per_sec).toBe(80)
    expect(got.track_heights).toEqual({})
    expect(got.expanded_tracks).toEqual([])
  })

  it('round-trips zoom + track heights + expanded tracks', () => {
    const { fs } = memFs()
    const s = createViewStateStore({ fs, join: (...p) => p.join('/') })
    s.save(WS, { timeline_px_per_sec: 200, track_heights: { t1: 64, t2: 96 }, expanded_tracks: ['t1'] })
    const reader = createViewStateStore({ fs, join: (...p) => p.join('/') })
    const got = reader.load(WS)
    expect(got.timeline_px_per_sec).toBe(200)
    expect(got.track_heights.t1).toBe(64)
    expect(got.track_heights.t2).toBe(96)
    expect(got.expanded_tracks).toEqual(['t1'])
  })

  it('atomic write leaves no .tmp behind', () => {
    const { fs, files } = memFs()
    createViewStateStore({ fs, join: (...p) => p.join('/') }).save(WS, { timeline_px_per_sec: 80, track_heights: {}, expanded_tracks: [] })
    expect(files.has(FILE)).toBe(true)
    expect(files.has(FILE + '.tmp')).toBe(false)
  })

  it('tolerates an empty file → defaults', () => {
    expect(store({ [FILE]: '' }).load(WS).timeline_px_per_sec).toBe(80)
  })

  it('tolerates a garbage file → defaults', () => {
    expect(store({ [FILE]: '{ not json' }).load(WS).timeline_px_per_sec).toBe(80)
  })

  it('missing fields inherit defaults', () => {
    const got = store({ [FILE]: '{}' }).load(WS)
    expect(got.timeline_px_per_sec).toBe(80)
    expect(got.track_heights).toEqual({})
    expect(got.expanded_tracks).toEqual([])
  })
})
