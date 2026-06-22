import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Layer, type Project } from '../model'
import { applyAddLayer, colorParams } from './add'
import { extendLayerTEnd, shrinkLayerTEnd, applyAddTransition, applyRemoveTransition } from './transitions'
import { isCommandFailure } from '../errors'

const RED = { r: 255, g: 0, b: 0, a: 255 }
const CROSSFADE = { kind: 'Crossfade' as const }
const color = () => colorParams(RED, 1920, 1080)

/** Two adjacent color layers on @A: A1=[0,2M], A2=[2M,4M]. Returns gen for id-order asserts. */
function twoAdjacent(): { p: Project; gen: IdGen; a1: string; a2: string } {
  const gen = seededGen()
  const p = blankProject(gen, 't') // #1 A #2 B #3 project
  const a1 = applyAddLayer(p, gen, p.tracks[0].id, color(), 0, 2_000_000) // #4
  const a2 = applyAddLayer(p, gen, p.tracks[0].id, color(), 2_000_000, 4_000_000) // #5
  return { p, gen, a1, a2 }
}
function expectCmd(fn: () => void, code: string) {
  try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) }
}
function layerOf(p: Project, id: string): Layer {
  for (const t of p.tracks) { const l = t.layers.find((x) => x.id === id); if (l) return l }
  throw new Error('layer not found')
}

describe('extendLayerTEnd / shrinkLayerTEnd', () => {
  it('extend color layer touches only t_end_us', () => {
    const l: Layer = layerOf(twoAdjacent().p, twoAdjacent().a1)
    const before = l.t_end_us
    extendLayerTEnd(l, 1_000_000)
    expect(l.t_end_us).toBe(before + 1_000_000)
    expect(l.params.kind).toBe('Color') // no src_out_us on color
  })
  it('extend then shrink a VideoClip touches t_end_us AND src_out_us (saturating at 0)', () => {
    const l: Layer = {
      id: 'x', label: null, t_start_us: 0, t_end_us: 2_000_000, enabled: true, locked: false,
      metadata: {}, effects: [],
      params: { kind: 'VideoClip', media: 'm', src_in_us: 0, src_out_us: 2_000_000,
        transform: { x: { mode: 'Static', value: 0 }, y: { mode: 'Static', value: 0 },
          scale_x: { mode: 'Static', value: 1 }, scale_y: { mode: 'Static', value: 1 },
          rotation_deg: { mode: 'Static', value: 0 }, anchor: [0.5, 0.5] },
        opacity: { mode: 'Static', value: 1 }, crop: null, flip_h: false, flip_v: false,
        blend_mode: 'Normal', speed: 1, fade_in_us: 0, fade_out_us: 0 },
    }
    extendLayerTEnd(l, 500_000)
    expect([l.t_end_us, (l.params as { src_out_us: number }).src_out_us]).toEqual([2_500_000, 2_500_000])
    shrinkLayerTEnd(l, 5_000_000) // over-shrink saturates at 0
    expect([l.t_end_us, (l.params as { src_out_us: number }).src_out_us]).toEqual([0, 0])
  })
})

describe('applyAddTransition', () => {
  it('adjacent layers: extends from_layer and adds the transition (id #6)', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE) // #6
    expect(tid).toBe('00000000-0000-0000-0000-000000000006')
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000) // extended by 1M
    expect(p.transitions).toEqual([{ id: tid, from_layer: a1, to_layer: a2, duration_us: 1_000_000, kind: CROSSFADE }])
  })
  it('already overlapping by exactly duration: no extension, just adds (case 2)', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    layerOf(p, a1).t_end_us = 3_000_000 // hand-position a pre-overlap of 1M (unreachable via the API)
    const tid = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000) // unchanged
    expect(p.transitions.map((t) => t.id)).toEqual([tid])
  })
  it('gap or wrong overlap → TransitionLayersNotAdjacent (no id minted)', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    layerOf(p, a2).t_start_us = 3_000_000; layerOf(p, a2).t_end_us = 5_000_000 // gap [2M..3M]
    expectCmd(() => applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE), 'TransitionLayersNotAdjacent')
    expect(applyAddLayer(p, gen, p.tracks[1].id, color(), 0, 1_000_000)).toBe('00000000-0000-0000-0000-000000000006') // #6, not #7 → no burn
  })
  it('missing from/to layer → LayerNotFound (no id minted)', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    expectCmd(() => applyAddTransition(p, gen, 'ghost', a2, 1_000_000, CROSSFADE), 'LayerNotFound')
    expectCmd(() => applyAddTransition(p, gen, a1, 'ghost', 1_000_000, CROSSFADE), 'LayerNotFound')
    expect(applyAddLayer(p, gen, p.tracks[1].id, color(), 0, 1_000_000)).toBe('00000000-0000-0000-0000-000000000006') // #6 → no burn
  })
})

describe('applyRemoveTransition', () => {
  it('shrinks from_layer back and removes the transition', () => {
    const { p, gen, a1, a2 } = twoAdjacent()
    const tid = applyAddTransition(p, gen, a1, a2, 1_000_000, CROSSFADE)
    expect(layerOf(p, a1).t_end_us).toBe(3_000_000)
    applyRemoveTransition(p, tid)
    expect(layerOf(p, a1).t_end_us).toBe(2_000_000) // shrunk back
    expect(p.transitions).toEqual([])
  })
  it('unknown id → TransitionNotFound', () => {
    const { p } = twoAdjacent()
    expectCmd(() => applyRemoveTransition(p, 'ghost'), 'TransitionNotFound')
  })
})
