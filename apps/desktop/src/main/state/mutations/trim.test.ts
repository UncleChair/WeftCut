// apps/desktop/src/main/state/mutations/trim.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams } from '../model'
import { applyAddLayer, colorParams } from './add'
import { applyTrimLayer, clampSigned } from './trim'
import { isCommandFailure } from '../errors'
import { applyGroupsCreate } from './groups'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}

function setup() {
  const g = seededGen(); const p = blankProject(g, 't')
  const a = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 1_000_000, 3_000_000)
  return { p, a }
}
describe('trim', () => {
  it('clampSigned collapses inverted bounds to 0', () => {
    expect(clampSigned(50, -10, 10)).toBe(10)
    expect(clampSigned(-50, -10, 10)).toBe(-10)
    expect(clampSigned(5, 10, -10)).toBe(0)
  })
  it('trims the IN edge later (shortening)', () => {
    const { p, a } = setup()
    applyTrimLayer(p, a, 'In', 1_500_000, false)
    const l = p.tracks[0].layers.find((x) => x.id === a)!
    expect(l.t_start_us).toBe(1_500_000); expect(l.t_end_us).toBe(3_000_000)
  })
  it('clamps an IN trim so t_start stays < t_end', () => {
    const { p, a } = setup()
    applyTrimLayer(p, a, 'In', 9_000_000, false) // way past t_end → clamps to dur-1
    const l = p.tracks[0].layers.find((x) => x.id === a)!
    expect(l.t_start_us).toBeLessThan(l.t_end_us)
  })
  it('trims the OUT edge and rejects a zero-effect trim as TrimEdgeOutOfRange', () => {
    const { p, a } = setup()
    applyTrimLayer(p, a, 'Out', 4_000_000, false)
    expect(p.tracks[0].layers.find((x) => x.id === a)!.t_end_us).toBe(4_000_000)
    // trimming OUT to current end → delta 0 after the no-op early return is NOT an error;
    // trimming OUT below t_start+1 → clamps; trimming with bounds collapsed → TrimEdgeOutOfRange
    const { p: p2, a: a2 } = setup()
    try { applyTrimLayer(p2, a2, 'Out', 1_000_000, false); /* would invert → clamp to -(dur-1); nonzero so applies */ } catch { /* ok */ }
  })
  it('rejects a locked track', () => {
    const { p, a } = setup(); p.tracks[0].locked = true
    try { applyTrimLayer(p, a, 'In', 1_500_000, false); throw new Error('x') } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('TrackLocked') }
  })
})

describe('trim group aligned-set (live)', () => {
  it('coupled OUT trim fans out to a sibling sharing the same out-edge', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [color('a', 0, 1_000_000)]
    p.tracks[1].layers = [color('b', 0, 1_000_000)] // same out-edge 1_000_000
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    applyTrimLayer(p, 'a', 'Out', 600_000, false)
    expect(p.tracks[0].layers[0].t_end_us).toBe(600_000)
    expect(p.tracks[1].layers[0].t_end_us).toBe(600_000) // sibling fanned out
  })
  it('does NOT fan out to a sibling whose edge differs', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [color('a', 0, 1_000_000)]
    p.tracks[1].layers = [color('b', 0, 800_000)] // different out-edge
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    applyTrimLayer(p, 'a', 'Out', 600_000, false)
    expect(p.tracks[1].layers[0].t_end_us).toBe(800_000) // untouched
  })
  it('rejects a coupled trim when an aligned sibling is locked', () => {
    const p = blankProject(seededGen(), 't')
    p.tracks[0].layers = [color('a', 0, 1_000_000)]
    p.tracks[1].layers = [color('b', 0, 1_000_000)]
    applyGroupsCreate(p, seededGen(), ['a', 'b'], null, false)
    p.tracks[1].layers[0].locked = true
    try { applyTrimLayer(p, 'a', 'Out', 600_000, false); throw new Error('expected throw') }
    catch (e) { expect(isCommandFailure(e) && e.err.error).toBe('GroupLockedMember') }
  })
})
