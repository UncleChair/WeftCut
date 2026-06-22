// src/main/state/mutations/composition.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams } from '../model'
import { applyFitComposition } from './composition'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}

describe('applyFitComposition', () => {
  it('unpins and refits duration to the layer high-water mark (shrink)', () => {
    const p = blankProject(seededGen(), 't'); p.tracks[0].layers = [color('a', 0, 2_000_000)]
    p.composition.duration_pinned = true; p.composition.duration_us = 9_000_000
    applyFitComposition(p)
    expect(p.composition.duration_pinned).toBe(false)
    expect(p.composition.duration_us).toBe(2_000_000)
  })
  it('refits to 0 when there are no layers', () => {
    const p = blankProject(seededGen(), 't'); p.composition.duration_pinned = true; p.composition.duration_us = 5_000_000
    applyFitComposition(p)
    expect(p.composition.duration_us).toBe(0)
  })
})
