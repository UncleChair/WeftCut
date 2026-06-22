import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Project } from '../model'
import { applyAddMarker } from './add'
import { applyUpdateMarker, applyRemoveMarker } from './markers'
import { isCommandFailure } from '../errors'

function withMarkers(specs: Array<[number, number | null]>): { p: Project; ids: string[] } {
  const gen = seededGen(); const p = blankProject(gen, 't'); const ids: string[] = []
  for (const [t0, end] of specs) ids.push(applyAddMarker(p, gen, t0, end, 'm', { r: 0, g: 128, b: 255, a: 255 }))
  return { p, ids }
}
function expectCmd(fn: () => void, code: string) { try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) } }

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
