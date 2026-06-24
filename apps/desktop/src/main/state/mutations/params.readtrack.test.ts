import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { createActor } from '../actor'
import { readLayerTrack, resolveAnimatedF64 } from './params'

function colorLayerProject() {
  const idGen = seededGen()
  const initial = blankProject(idGen, 't')
  const actor = createActor({ initial, idGen, clock: () => '<TS>' })
  const aRoll = initial.tracks[0].id
  const r = actor.dispatch('add_layer', { kind: 'color', track: aRoll, t_start_us: 500000, t_end_us: 1500000 })
  return { proj: actor.snapshot(), layerId: r.ok ? (r.value as string) : '' }
}

describe('readLayerTrack', () => {
  it('LayerNotFound for an unknown layer id', () => {
    const { proj } = colorLayerProject()
    expect(() => readLayerTrack(proj, '00000000-0000-0000-0000-0000000000ff', 'opacity')).toThrow(/LayerNotFound|Layer/)
  })
  it('UnknownKeyframeParam for a Color layer (no animatable params)', () => {
    const { proj, layerId } = colorLayerProject()
    expect(() => readLayerTrack(proj, layerId, 'opacity')).toThrow(/UnknownKeyframeParam|Unknown/)
  })
  it('resolveAnimatedF64 returns null for Color opacity', () => {
    const { proj, layerId } = colorLayerProject()
    const loc = proj.tracks.flatMap((t) => t.layers).find((l) => l.id === layerId)!
    expect(resolveAnimatedF64(loc, 'opacity')).toBeNull()
  })
})
