import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Project } from '../model'
import { applyAddMarker } from './add'
import { applyUpdateMarker, applyRemoveMarker } from './markers'
import { frameIndexRound, snapFrameRound, timeUsAtFrame } from '../snap'
import { isCommandFailure } from '../errors'

const BLUE = { r: 0, g: 128, b: 255, a: 255 }
function withMarkers(specs: Array<[number, number | null]>): { p: Project; ids: string[] } {
  const gen = seededGen(); const p = blankProject(gen, 't'); const ids: string[] = []
  for (const [t0, end] of specs) ids.push(applyAddMarker(p, gen, t0, end, 'm', BLUE))
  return { p, ids }
}
function expectCmd(fn: () => void, code: string) { try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) } }
function expectCmdErr(fn: () => void): Record<string, unknown> {
  try { fn() } catch (e) { if (isCommandFailure(e)) return e.err as unknown as Record<string, unknown>; throw e }
  throw new Error('expected a CommandFailure')
}

// ── the composition frame grid ───────────────────────────────────────────────
// The spec's full rate matrix; the 1001-denominator rates are where an
// arbitrary-µs marker time is visibly off the grid.
const RATES: Array<[number, number]> = [
  [24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [50, 1], [60000, 1001], [60, 1],
]
function emptyAt(num: number, den: number): { p: Project; gen: IdGen } {
  const gen = seededGen(); const p = blankProject(gen, 't') // #1 A #2 B #3 project
  p.composition.fps = { num, den }
  return { p, gen }
}
const isCanonical = (us: number, num: number, den: number) => timeUsAtFrame(frameIndexRound(us, num, den), num, den) === us

describe('applyUpdateMarker', () => {
  it('patches label/end_t_us/color without touching t_us (no re-sort)', () => {
    const { p, ids } = withMarkers([[1_000_000, null]])
    applyUpdateMarker(p, ids[0], { label: 'chapter', end_t_us: 2_000_000, color: { r: 255, g: 0, b: 0, a: 255 } })
    const m = p.markers[0]
    expect(m.label).toBe('chapter'); expect(m.end_t_us).toBe(2_000_000); expect(m.color.r).toBe(255)
    expect(m.t_us).toBe(1_000_000)
  })
  it('re-sorts markers by t_us when t_us changes (stable)', () => {
    const { p, ids } = withMarkers([[1_000_000, null], [2_000_000, null], [3_000_000, null]])
    applyUpdateMarker(p, ids[0], { t_us: 5_000_000 })
    expect(p.markers.map((m) => m.t_us)).toEqual([2_000_000, 3_000_000, 5_000_000])
  })
  it('null/absent patch fields are "do not touch"', () => {
    const { p, ids } = withMarkers([[1_000_000, null]])
    applyUpdateMarker(p, ids[0], { t_us: null, label: null })
    expect(p.markers[0].t_us).toBe(1_000_000); expect(p.markers[0].label).toBe('m')
  })
  it('throws MarkerNotFound for a missing marker', () => {
    const { p } = withMarkers([[1_000_000, null]])
    expectCmd(() => applyUpdateMarker(p, 'ghost', { label: 'x' }), 'MarkerNotFound')
  })
})

describe('marker times enter the composition frame grid', () => {
  it.each(RATES)('%i/%i: add_marker snaps t_us and end_t_us to canonical times', (num, den) => {
    const { p, gen } = emptyAt(num, den)
    // Arbitrary µs a UI drop or an MCP call can produce, at several phases.
    for (const tUs of [1, 12_345, 1_000_001, 999_999, 40_000_007]) {
      const id = applyAddMarker(p, gen, tUs, tUs + 5_000_003, 'm', BLUE)
      const m = p.markers.find((x) => x.id === id)!
      expect(m.t_us).toBe(snapFrameRound(tUs, num, den))
      expect(m.end_t_us).toBe(snapFrameRound(tUs + 5_000_003, num, den))
      expect(isCanonical(m.t_us, num, den)).toBe(true)
      expect(isCanonical(m.end_t_us!, num, den)).toBe(true)
    }
  })

  it.each(RATES)('%i/%i: 10 min / 1 h / 24 h marker times stay canonical', (num, den) => {
    const { p, gen } = emptyAt(num, den)
    for (const tUs of [600_000_001, 3_600_000_001, 86_400_000_001]) {
      const id = applyAddMarker(p, gen, tUs, null, 'm', BLUE)
      const m = p.markers.find((x) => x.id === id)!
      expect(isCanonical(m.t_us, num, den)).toBe(true)
      expect(Math.abs(m.t_us - tUs)).toBeLessThanOrEqual(timeUsAtFrame(1, num, den))
    }
  })

  it.each(RATES)('%i/%i: the sorted-markers invariant holds on the SNAPPED times', (num, den) => {
    const { p, gen } = emptyAt(num, den)
    for (const tUs of [2_000_003, 999_998, 5_000_001, 1_000_002, 7]) applyAddMarker(p, gen, tUs, null, 'm', BLUE)
    const ts = p.markers.map((m) => m.t_us)
    expect(ts).toEqual([...ts].sort((a, b) => a - b))
  })

  it('a region whose span collapses under the snap fails and mints no id', () => {
    const { p, gen } = emptyAt(30, 1)
    // 1_016_000 snaps back down to 1_000_000 at 30 fps → zero-length region.
    const err = expectCmdErr(() => applyAddMarker(p, gen, 1_000_000, 1_016_000, 'm', BLUE))
    expect([err.error, err.field]).toEqual(['InvalidArgument', 'end_t_us'])
    expectCmd(() => applyAddMarker(p, gen, 1_000_000, 500_000, 'm', BLUE), 'InvalidArgument') // end < t
    expect(p.markers).toEqual([])
    // #4, not #5+ → neither rejection consumed a marker id
    expect(applyAddMarker(p, gen, 0, null, 'm', BLUE)).toBe('00000000-0000-0000-0000-000000000004')
  })

  it('a region one frame long survives the snap', () => {
    const { p, gen } = emptyAt(30, 1)
    const id = applyAddMarker(p, gen, 1_000_000, 1_017_000, 'm', BLUE)
    const m = p.markers.find((x) => x.id === id)!
    expect([m.t_us, m.end_t_us]).toEqual([1_000_000, 1_033_333])
  })

  it('update_marker snaps t_us / end_t_us and re-sorts on the snapped value', () => {
    const { p, ids } = withMarkers([[1_000_000, null], [2_000_000, null]])
    applyUpdateMarker(p, ids[0], { t_us: 2_999_990, end_t_us: 4_000_007 })
    expect(p.markers.map((m) => m.t_us)).toEqual([2_000_000, 3_000_000])
    expect(p.markers[1].end_t_us).toBe(4_000_000)
  })

  it('moving t_us onto or past end_t_us fails; the marker is untouched', () => {
    const { p, ids } = withMarkers([[1_000_000, 2_000_000]])
    expect(expectCmdErr(() => applyUpdateMarker(p, ids[0], { t_us: 2_000_000 })).error).toBe('InvalidArgument')
    expectCmd(() => applyUpdateMarker(p, ids[0], { t_us: 3_000_000 }), 'InvalidArgument')
    expect([p.markers[0].t_us, p.markers[0].end_t_us]).toEqual([1_000_000, 2_000_000])
  })
})

describe('applyRemoveMarker', () => {
  it('removes a marker by id', () => {
    const { p, ids } = withMarkers([[1_000_000, null], [2_000_000, null]])
    applyRemoveMarker(p, ids[0])
    expect(p.markers.map((m) => m.t_us)).toEqual([2_000_000])
  })
  it('throws MarkerNotFound for a missing marker', () => {
    const { p } = withMarkers([[1_000_000, null]])
    expectCmd(() => applyRemoveMarker(p, 'ghost'), 'MarkerNotFound')
  })
})
