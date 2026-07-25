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

  // ── The zero boundary: a move stops, it does not deform ────────────────────
  // The pre-fix code clamped each member's `t_start_us` independently and never
  // floored the target at all, so dragging toward zero SHORTENED a group sibling
  // (start lifted, end left behind) and let a lone layer land at a negative time.
  // Clamping the shared delta instead is what makes "stops as a set" true.
  it('stops a lone layer at 0 with its duration intact instead of writing a negative start', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [color('a', 1_000_000, 2_000_000)]
    applyMoveLayer(p, 'a', p.tracks[0].id, -5_000_000, false)
    const a = p.tracks[0].layers[0]
    expect(a.t_start_us).toBe(0)
    expect(a.t_end_us).toBe(1_000_000) // NOT clamped-in-place: the duration rides along
  })

  it('stops a group at 0 as a set — earliest member on 0, spacing kept, nobody shortened', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [color('a', 1_000_000, 2_000_000)] // target, 1 s duration
    p.tracks[1].layers = [color('b', 500_000, 600_000)]     // earliest member, 100 ms
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)

    // Asks for -1 000 000; the set can only travel -500 000 before `b` hits zero.
    applyMoveLayer(p, 'a', p.tracks[0].id, 0, false)

    const a = p.tracks[0].layers[0]
    const b = p.tracks[1].layers[0]
    expect(b.t_start_us).toBe(0)                    // earliest member lands exactly on 0
    expect(a.t_start_us).toBe(500_000)              // ...and keeps its 500 ms lead
    expect(b.t_end_us - b.t_start_us).toBe(100_000) // NEGATIVE CONTROL: the pre-fix code
    expect(a.t_end_us - a.t_start_us).toBe(1_000_000) // left b at [0, -400_000)
  })

  it('lets a sample-aligned audio member decide where the group stops', () => {
    // The stop is driven by whichever member is earliest, on WHICHEVER lattice — an
    // `earliestStart` that only scanned the frame grid would walk the audio negative.
    // 999_979 µs is sample 47 999 at 48 kHz; it is not a 30 fps frame boundary.
    const p = blankProject(seededGen(), 't')
    const au = color('au', 999_979, 1_999_979)
    au.params = {
      kind: 'Audio', media: 'm', src_in_us: 0, src_out_us: 1_000_000,
      gain_db: { mode: 'Static', value: 0 }, pan: { mode: 'Static', value: 0 },
      fade_in_us: 0, fade_out_us: 0, mute: false, role: 'dialogue',
    }
    p.tracks[0].layers = [color('v', 1_000_000, 2_000_000)]
    p.tracks[1].layers = [au]
    applyGroupsCreate(p, seededGen(), ['v', 'au'], null, false)

    applyMoveLayer(p, 'v', p.tracks[0].id, -3_000_000, false)

    expect(p.tracks[1].layers[0].t_start_us).toBe(0)
    expect(p.tracks[0].layers[0].t_start_us).toBeGreaterThanOrEqual(0)
  })

  it('cross-track group move changes only the target track and shifts siblings in place', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [
      color('a', 0, 100_000),
      color('b', 200_000, 300_000),
    ]
    p.tracks[1].layers = []
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)

    applyMoveLayer(p, 'a', p.tracks[1].id, 500_000, false)

    expect(p.tracks[1].layers.map((l) => l.id)).toEqual(['a'])
    expect(p.tracks[1].layers[0].t_start_us).toBe(500_000)
    expect(p.tracks[0].layers.map((l) => l.id)).toEqual(['b'])
    expect(p.tracks[0].layers[0].t_start_us).toBe(700_000)
  })
})
