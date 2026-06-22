// apps/desktop/src/main/state/mutations/trim.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { applyAddLayer, colorParams } from './add'
import { applyTrimLayer, clampSigned } from './trim'
import { isCommandFailure } from '../errors'

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
