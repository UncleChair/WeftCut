// apps/desktop/src/main/state/mutations/add.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { applyAddLayer, applyAddMarker, applyAddTrack, colorParams } from './add'
import { isCommandFailure } from '../errors'

describe('additive mutations', () => {
  it('applyAddLayer snaps both edges, inserts t-start-sorted, autofits, returns id', () => {
    const g = seededGen(); const p = blankProject(g, 't') // ids 1,2,3 used
    const a = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 255, g: 0, b: 0, a: 255 }, 1920, 1080), 1_000_000, 2_000_000)
    expect(a).toBe('00000000-0000-0000-0000-000000000004') // first post-blank id
    expect(p.tracks[0].layers).toHaveLength(1)
    expect(p.composition.duration_us).toBe(2_000_000)
    // insert sorted: add an earlier layer, it goes to index 0
    applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 500_000)
    expect(p.tracks[0].layers[0].t_start_us).toBe(0)
  })
  it('applyAddLayer rejects an unknown track BEFORE consuming the layer id', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    try { applyAddLayer(p, g, 'ghost', colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1); throw new Error('x') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('TrackNotFound') }
    // next id is still 4 (none consumed by the rejected add)
    expect(applyAddTrack(p, g, 'L')).toBe('00000000-0000-0000-0000-000000000004')
  })
  it('applyAddTrack uses Track::new defaults (removable, role null, height 64) and stamps transient', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const id = applyAddTrack(p, g, 'Track')
    const t = p.tracks.find((x) => x.id === id)!
    // transient == (role === null): a role-less lane is a cleanup candidate.
    expect(t).toMatchObject({ label: 'Track', enabled: true, locked: false, muted: false, solo: false, removable: true, role: null, transient: true, height_px: 64 })
  })
  it('applyAddMarker inserts t-sorted', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    applyAddMarker(p, g, 2_000_000, null, 'm2', { r: 0, g: 128, b: 255, a: 255 })
    applyAddMarker(p, g, 1_000_000, null, 'm1', { r: 0, g: 128, b: 255, a: 255 })
    expect(p.markers.map((m) => m.t_us)).toEqual([1_000_000, 2_000_000])
  })
  it('applyAddMarker snaps both times to the composition frame grid before inserting', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    p.composition.fps = { num: 30000, den: 1001 }
    applyAddMarker(p, g, 1_000_000, 2_000_000, 'm', { r: 0, g: 128, b: 255, a: 255 })
    // 29.97: frame 30 = 1_001_000 µs, frame 60 = 2_002_000 µs.
    expect([p.markers[0].t_us, p.markers[0].end_t_us]).toEqual([1_001_000, 2_002_000])
  })
  it('applyAddMarker rejects a collapsed region BEFORE consuming the marker id', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    try { applyAddMarker(p, g, 1_000_000, 1_000_001, 'm', { r: 0, g: 128, b: 255, a: 255 }); throw new Error('x') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('InvalidArgument') }
    expect(p.markers).toEqual([])
    expect(applyAddTrack(p, g, 'L')).toBe('00000000-0000-0000-0000-000000000004') // no id consumed
  })
})
