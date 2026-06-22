// apps/desktop/src/main/state/mutations/move.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { applyAddLayer, colorParams } from './add'
import { applyMoveLayer } from './move'
import { isCommandFailure } from '../errors'

describe('applyMoveLayer', () => {
  it('moves within a track, snapping both edges and preserving duration', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const a = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    applyMoveLayer(p, a, p.tracks[0].id, 2_000_000, false)
    const l = p.tracks[0].layers[0]
    expect(l.t_start_us).toBe(2_000_000)
    expect(l.t_end_us - l.t_start_us).toBe(1_000_000) // duration preserved
  })
  it('moves across tracks', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const a = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    applyMoveLayer(p, a, p.tracks[1].id, 0, false)
    expect(p.tracks[0].layers).toHaveLength(0)
    expect(p.tracks[1].layers[0].id).toBe(a)
  })
  it('rejects a missing layer and a locked source track', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    try { applyMoveLayer(p, 'ghost', p.tracks[0].id, 0, false); throw new Error('x') } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('LayerNotFound') }
    const a = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    p.tracks[0].locked = true
    try { applyMoveLayer(p, a, p.tracks[0].id, 1_000_000, false); throw new Error('x') } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('TrackLocked') }
  })
})
