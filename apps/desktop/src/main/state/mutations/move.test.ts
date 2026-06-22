// apps/desktop/src/main/state/mutations/move.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams } from '../model'
import { applyAddLayer, colorParams } from './add'
import { applyMoveLayer } from './move'
import { isCommandFailure } from '../errors'
import { applyGroupsCreate } from './groups'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}

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

describe('move group lock checks (not corpus-gated)', () => {
  it('rejects a coupled move when a group sibling is layer-locked', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [color('a', 0, 100_000)]
    p.tracks[1].layers = [color('b', 0, 100_000)]
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    p.tracks[1].layers[0].locked = true // sibling b locked
    try { applyMoveLayer(p, 'a', p.tracks[0].id, 500_000, false); throw new Error('expected throw') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('GroupLockedMember') }
  })
  it('escape_group bypasses the sibling lock check and moves only the target', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [color('a', 0, 100_000)]
    p.tracks[1].layers = [color('b', 0, 100_000)]
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    p.tracks[1].layers[0].locked = true
    expect(() => applyMoveLayer(p, 'a', p.tracks[0].id, 500_000, true)).not.toThrow()
    expect(p.tracks[1].layers[0].t_start_us).toBe(0) // sibling unmoved
  })
})
