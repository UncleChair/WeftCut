// apps/desktop/src/main/state/mutations/helpers.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Project } from '../model'
import { applyDurationAutofit, dropLayerFromGroups, locateLayer, pruneEmptiedTrack, checkTrackLock } from './helpers'
import { isCommandFailure } from '../errors'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}

describe('helpers', () => {
  it('locateLayer finds (trackIdx, layerIdx)', () => {
    const p = blankProject(seededGen(), 't'); p.tracks[1].layers = [color('a', 0, 1)]
    expect(locateLayer(p, 'a')).toEqual([1, 0]); expect(locateLayer(p, 'nope')).toBeNull()
  })
  it('applyDurationAutofit grows+shrinks unpinned, grow-only when pinned', () => {
    const p = blankProject(seededGen(), 't'); p.tracks[0].layers = [color('a', 0, 5_000_000)]
    applyDurationAutofit(p); expect(p.composition.duration_us).toBe(5_000_000)
    p.tracks[0].layers = [color('a', 0, 2_000_000)]
    applyDurationAutofit(p); expect(p.composition.duration_us).toBe(2_000_000) // shrank
    p.composition.duration_pinned = true; p.composition.duration_us = 9_000_000
    p.tracks[0].layers = [color('a', 0, 2_000_000)]
    applyDurationAutofit(p); expect(p.composition.duration_us).toBe(9_000_000) // pinned: no shrink
    p.tracks[0].layers = [color('a', 0, 12_000_000)]
    applyDurationAutofit(p); expect(p.composition.duration_us).toBe(12_000_000) // pinned: overflow grows
  })
  it('pruneEmptiedTrack removes only empty+transient+unlocked tracks', () => {
    const p = blankProject(seededGen(), 't')
    // A-roll belongs to the reserved skeleton (transient:false) → survives empty.
    expect(pruneEmptiedTrack(p, p.tracks[0].id)).toBeNull()
    const lane = (id: string, over: Partial<Project['tracks'][number]>) => ({
      id, label: null, enabled: true, locked: false, muted: false, solo: false,
      removable: true, role: null, transient: true, height_px: 64, layers: [], ...over,
    } as Project['tracks'][number])
    p.tracks.push(lane('tlocked', { locked: true }), lane('tfull', { layers: [color('a', 0, 1)] }), lane('tx', {}))
    expect(pruneEmptiedTrack(p, 'tlocked')).toBeNull() // lock out-ranks cleanup
    expect(pruneEmptiedTrack(p, 'tfull')).toBeNull()   // still holds a layer
    expect(pruneEmptiedTrack(p, 'gone')).toBeNull()    // unknown id
    expect(pruneEmptiedTrack(p, 'tx')).toBe('tx')
    expect(p.tracks.find((t) => t.id === 'tx')).toBeUndefined()
  })
  it('dropLayerFromGroups removes the member and auto-dissolves below 2', () => {
    const p = blankProject(seededGen(), 't')
    p.groups = [{ id: 'g', members: ['a', 'b'] }]
    dropLayerFromGroups(p, 'a')
    expect(p.groups.length).toBe(0) // dropped to 1 → dissolved
  })
  it('checkTrackLock throws TrackLocked / LayerNotFound', () => {
    const p = blankProject(seededGen(), 't'); p.tracks[0].locked = true; p.tracks[0].layers = [color('a', 0, 1)]
    try { checkTrackLock(p, 'a'); throw new Error('expected throw') } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('TrackLocked') }
    try { checkTrackLock(p, 'ghost'); throw new Error('expected throw') } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('LayerNotFound') }
  })
})
