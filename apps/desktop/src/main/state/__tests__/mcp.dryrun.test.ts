import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { createActor } from '../actor'

function actor() {
  const idGen = seededGen()
  const initial = blankProject(idGen, 't')
  const a = createActor({ initial, idGen, clock: () => '<TS>' })
  return { a, aRoll: initial.tracks[0].id }
}

describe('dry_run halt/error (TS-only; the differential gate uses succeeding ops)', () => {
  it('halts at the first failing op and reports halted_at + status:error', () => {
    const { a, aRoll } = actor()
    const r = a.mcpCall('dry_run', JSON.stringify({ operations: [
      { kind: 'add_color_layer', track_id: aRoll, t_start_us: 0, t_end_us: 1000000, color: { r: 0, g: 0, b: 0, a: 255 } },
      { kind: 'delete_layer', layer_id: '00000000-0000-0000-0000-0000000000ff' }, // LayerNotFound → halt
      { kind: 'add_color_layer', track_id: aRoll, t_start_us: 2000000, t_end_us: 3000000, color: { r: 0, g: 0, b: 0, a: 255 } },
    ] }))
    expect(r.ok).toBe(true)
    const body = JSON.parse((r as { result: { content: Array<{ text: string }> } }).result.content[0].text)
    expect(body.halted_at).toBe(1)
    expect(body.results.length).toBe(2)            // stops after the failing op (3rd never runs)
    expect(body.results[0].status).toBe('ok')
    expect(body.results[1].status).toBe('error')
  })
  it('bad operation spec → invalid_params (no dry run executed)', () => {
    const { a } = actor()
    const r = a.mcpCall('dry_run', JSON.stringify({ operations: [{ kind: 'delete_layer', layer_id: 'not-a-uuid' }] }))
    expect(r.ok).toBe(false)
    expect((r as { error: { code: string } }).error.code).toBe('invalid_params')
  })
})
