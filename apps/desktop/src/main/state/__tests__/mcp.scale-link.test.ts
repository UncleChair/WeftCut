// MCP surface of the scale link: set_scale_linked routes through the SAME
// relink mutation as the UI chain (snap + flag, one commit), and the
// result-based invariant is observable through the update_layer_params path.
// Asserted through mcpCall per the emit-smoke-tests house rule — invoke the
// real tool, don't string-match schemas.
import { describe, it, expect } from 'vitest'
import { freshActor, aRollId, bRollId } from './pbt/harness'
import { layerParamsView } from '../summary'
import type { TextParams } from '../model'

// Factory, not a shared literal: a dispatched track object gets frozen by the
// actor's immer produce, so reusing one instance across dispatches throws.
const KF = () => ({ mode: 'Keyframed', value: [{ id: '00000000-0000-0000-0000-0000000000f1', t_us: 0, value: 2, interp: { kind: 'Linear' } }] })

function addTextLayer(actor: ReturnType<typeof freshActor>): string {
  const r = actor.dispatch('add_layer', { track: bRollId(actor), kind: 'text', t_start_us: 0, t_end_us: 2_000_000 })
  expect(r.ok).toBe(true)
  return (r as { ok: true; value: string }).value
}
const textTransform = (actor: ReturnType<typeof freshActor>, id: string) => {
  for (const t of actor.snapshot().tracks) {
    const l = t.layers.find((x) => x.id === id)
    if (l) return (l.params as TextParams).transform
  }
  throw new Error('layer not found')
}

describe('MCP set_scale_linked', () => {
  it('true on a diverged layer snaps scale_y := scale_x in ONE commit (one undo restores both)', () => {
    const a = freshActor()
    const id = addTextLayer(a)
    expect(a.dispatch('update_layer_param_track', { layer: id, param_key: 'scale_x', track: KF() }).ok).toBe(true)
    expect(textTransform(a, id).scale_linked).toBe(false) // divergent write auto-unlinked
    const before = JSON.stringify(a.snapshot())

    const r = a.mcpCall('set_scale_linked', JSON.stringify({ layer_id: id, linked: true }))
    expect(r.ok).toBe(true)
    const t = textTransform(a, id)
    expect(t.scale_linked).toBe(true)
    expect(t.scale_y.mode).toBe('Keyframed')

    expect(a.dispatch('undo', {}).ok).toBe(true)
    expect(JSON.stringify(a.snapshot())).toBe(before)
  })

  it('a divergent single-axis update_layer_params clears the flag in the same commit', () => {
    const a = freshActor()
    const id = a.mcpCall('add_color_layer', JSON.stringify({ track_id: aRollId(a), color: { r: 1, g: 2, b: 3, a: 255 }, t_start_us: 0, t_end_us: 1_000_000 }))
    expect(id.ok).toBe(true) // Color has no transform — used below for the rejection case
    const text = addTextLayer(a)
    expect(textTransform(a, text).scale_linked).toBe(true)

    const r = a.mcpCall('update_layer_params', JSON.stringify({ layer_id: text, patch: { kind: 'Text', x: 5 } }))
    expect(r.ok).toBe(true)
    expect(textTransform(a, text).scale_linked).toBe(true) // x is not a scale axis — link untouched

    // Text patches carry no scale fields, so drive divergence through the track tool…
    expect(a.dispatch('update_layer_param_track', { layer: text, param_key: 'scale_y', track: KF() }).ok).toBe(true)
    expect(textTransform(a, text).scale_linked).toBe(false)
  })

  it('rejects a kind without a transform (Color) with a structured error', () => {
    const a = freshActor()
    const add = a.mcpCall('add_color_layer', JSON.stringify({ track_id: aRollId(a), color: { r: 1, g: 2, b: 3, a: 255 }, t_start_us: 0, t_end_us: 1_000_000 }))
    expect(add.ok).toBe(true)
    if (!add.ok) return
    const colorId = add.result.content[0].text
    const r = a.mcpCall('set_scale_linked', JSON.stringify({ layer_id: colorId, linked: true }))
    expect(r.ok).toBe(false)
  })

  it('scale_linked rides the layer params view agents read', () => {
    const a = freshActor()
    const id = addTextLayer(a)
    for (const t of a.snapshot().tracks) {
      const l = t.layers.find((x) => x.id === id)
      if (!l) continue
      const view = layerParamsView(l.params, {}) as { scale_linked?: boolean }
      expect(view.scale_linked).toBe(true)
    }
  })
})
