import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { createActor } from '../actor'
import type { MotifParams } from '../model'

function setup() {
  const idGen = seededGen()
  const initial = blankProject(idGen, 't') // mints A#1, B#2, project#3
  const actor = createActor({ initial, idGen, clock: () => '<TS>' })
  const aRoll = initial.tracks[0].id
  return { actor, aRoll }
}

describe('rebind_motif dispatch', () => {
  it('rebinds a single motif layer to a new motif_id/version/props', () => {
    const { actor, aRoll } = setup()

    // add a Motif layer — needs the Motif kind arm in add_layer
    const addR = actor.dispatch('add_layer', {
      track: aRoll, kind: 'Motif', motif_id: 'motif-x', motif_version: 1,
      props: { a: 1 }, t_start_us: 0, t_end_us: 1_000_000,
    })
    expect(addR.ok, 'add_layer Motif should succeed').toBe(true)
    const layerId = addR.value as string

    // rebind it
    const r = actor.dispatch('rebind_motif', {
      updates: [{ layer_id: layerId, motif_id: 'motif-y', motif_version: 2, props: { b: 2 } }],
    })
    expect(r.ok, 'rebind_motif should succeed').toBe(true)

    // verify the layer state
    const snap = actor.snapshot()
    const layer = snap.tracks.flatMap((t) => t.layers).find((l) => l.id === layerId)
    expect(layer).toBeDefined()
    const p = layer!.params as MotifParams
    expect(p.kind).toBe('Motif')
    expect(p.motif_id).toBe('motif-y')
    expect(p.motif_version).toBe(2)
    expect(p.props).toEqual({ b: 2 })

    // one history entry was recorded for rebind_motif
    const hist = actor.historyView(10)
    const rebindEntry = hist.ops.find((e) => e.summary === 'Rebound motif layers')
    expect(rebindEntry).toBeDefined()
  })

  it('skips non-Motif layers silently', () => {
    const { actor, aRoll } = setup()

    // add a color layer
    const colorR = actor.dispatch('add_layer', {
      track: aRoll, kind: 'color', t_start_us: 0, t_end_us: 1_000_000,
    })
    const colorId = colorR.value as string

    // rebind pointing at a color layer — should succeed (skip silently)
    const r = actor.dispatch('rebind_motif', {
      updates: [{ layer_id: colorId, motif_id: 'motif-y', motif_version: 2, props: {} }],
    })
    expect(r.ok).toBe(true)

    // color layer params unchanged
    const snap = actor.snapshot()
    const layer = snap.tracks.flatMap((t) => t.layers).find((l) => l.id === colorId)
    expect(layer!.params.kind).toBe('Color')
  })

  it('rebinds multiple motif layers in one commit', () => {
    const { actor, aRoll } = setup()

    const r1 = actor.dispatch('add_layer', {
      track: aRoll, kind: 'Motif', motif_id: 'mx', motif_version: 1,
      props: {}, t_start_us: 0, t_end_us: 1_000_000,
    })
    const r2 = actor.dispatch('add_layer', {
      track: aRoll, kind: 'Motif', motif_id: 'mx', motif_version: 1,
      props: {}, t_start_us: 2_000_000, t_end_us: 3_000_000,
    })
    const id1 = r1.value as string
    const id2 = r2.value as string

    const r = actor.dispatch('rebind_motif', {
      updates: [
        { layer_id: id1, motif_id: 'my', motif_version: 2, props: { x: 1 } },
        { layer_id: id2, motif_id: 'my', motif_version: 2, props: { x: 2 } },
      ],
    })
    expect(r.ok).toBe(true)

    const layers = actor.snapshot().tracks.flatMap((t) => t.layers)
    const l1 = layers.find((l) => l.id === id1)!.params as MotifParams
    const l2 = layers.find((l) => l.id === id2)!.params as MotifParams
    expect(l1.motif_id).toBe('my')
    expect(l2.motif_id).toBe('my')
    expect(l1.props).toEqual({ x: 1 })
    expect(l2.props).toEqual({ x: 2 })

    // only ONE history entry for the whole batch
    const hist = actor.historyView(10)
    const rebindEntries = hist.ops.filter((e) => e.summary === 'Rebound motif layers')
    expect(rebindEntries.length).toBe(1)
  })
})
