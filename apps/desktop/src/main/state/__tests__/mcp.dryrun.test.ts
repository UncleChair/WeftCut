import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { createActor, type ActorLogEntry } from '../actor'

function actor() {
  const idGen = seededGen()
  const initial = blankProject(idGen, 't')
  const logged: ActorLogEntry[] = []
  const a = createActor({ initial, idGen, clock: () => '<TS>', emitLog: (e) => logged.push(e) })
  return { a, logged, aRoll: initial.tracks[0].id, bRoll: initial.tracks[1].id }
}

function body(r: ReturnType<ReturnType<typeof createActor>['mcpCall']>): { halted_at: number | null; results: Array<{ index: number; status: string; output?: Record<string, unknown>; error?: string }> } {
  expect(r.ok).toBe(true)
  return JSON.parse((r as { result: { content: Array<{ text: string }> } }).result.content[0].text)
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

describe('dry_run add_transition parity (same apply as the wet command, produce-and-discard)', () => {
  const val = (r: { ok: boolean }) => (r as { ok: true; value: string }).value
  /** Two adjacent color layers on the A roll. */
  function withCut() {
    const ctx = actor()
    const a1 = val(ctx.a.dispatch('add_layer', { track: ctx.aRoll, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 }))
    const a2 = val(ctx.a.dispatch('add_layer', { track: ctx.aRoll, kind: 'color', t_start_us: 2_000_000, t_end_us: 4_000_000 }))
    return { ...ctx, a1, a2 }
  }

  it('a dry-run overlap add predicts the success, mutates NOTHING, and the wet run then lands the same geometry', () => {
    const { a, a1, a2 } = withCut()
    const before = a.snapshot()
    const out = body(a.mcpCall('dry_run', JSON.stringify({ operations: [
      { kind: 'add_transition', from_layer_id: a1, to_layer_id: a2, duration_us: 1_000_000 },
    ] })))
    expect(out.halted_at).toBeNull()
    expect(out.results[0].status).toBe('ok')
    expect(out.results[0].output).toMatchObject({ kind: 'add_transition', bounces: [] })
    expect(a.snapshot()).toBe(before) // dry-run committed nothing — no move, no transition
    // Wet parity: the real command succeeds with the geometry the dry run walked.
    expect(a.dispatch('add_transition', { from: a1, to: a2, duration_us: 1_000_000 }).ok).toBe(true)
    expect(a.snapshot().tracks[0].layers.find((l) => l.id === a2)!.t_start_us).toBe(1_000_000)
    expect(a.snapshot().transitions[0].extended_us).toBe(0)
  })

  it('a dry-run overlap add predicts the SAME refusal as the wet run (shared group), and mutates nothing', () => {
    const { a, a1, a2 } = withCut()
    expect(a.dispatch('groups_create', { layers: [a1, a2], label: null, reassign: false }).ok).toBe(true)
    const before = a.snapshot()
    const out = body(a.mcpCall('dry_run', JSON.stringify({ operations: [
      { kind: 'add_transition', from_layer_id: a1, to_layer_id: a2, duration_us: 1_000_000 },
    ] })))
    expect(out.halted_at).toBe(0)
    expect(out.results[0].status).toBe('error')
    expect(out.results[0].error).toContain('share a group')
    expect(a.snapshot()).toBe(before)
    const wet = a.dispatch('add_transition', { from: a1, to: a2, duration_us: 1_000_000 })
    expect(wet.ok).toBe(false)
    if (!wet.ok) expect(wet.error.error).toBe('TransitionParticipantsShareGroup')
  })

  it("placement 'extend' rides the op spec: the dry run predicts extend's handle refusal that overlap would not hit", () => {
    const { a, aRoll } = actor()
    expect(a.dispatch('add_media', { id: 'm-v', kind: 'Video', duration_us: 2_000_000, with_audio: false }).ok).toBe(true)
    const v1 = val(a.dispatch('add_layer', { track: aRoll, kind: 'video', media: 'm-v', src_in_us: 0, src_out_us: 2_000_000, t_start_us: 0, t_end_us: 2_000_000 }))
    const c2 = val(a.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 2_000_000, t_end_us: 4_000_000 }))
    const extend = body(a.mcpCall('dry_run', JSON.stringify({ operations: [
      { kind: 'add_transition', from_layer_id: v1, to_layer_id: c2, duration_us: 1_000_000, placement: 'extend' },
    ] })))
    expect(extend.results[0].status).toBe('error')
    expect(extend.results[0].error).toContain('insufficient tail media')
    const overlap = body(a.mcpCall('dry_run', JSON.stringify({ operations: [
      { kind: 'add_transition', from_layer_id: v1, to_layer_id: c2, duration_us: 1_000_000, placement: 'overlap' },
    ] })))
    expect(overlap.results[0].status).toBe('ok')
  })

  it('the dry run predicts the bounce (layer + spawned) the wet run then performs and logs', () => {
    const { a, logged, aRoll, bRoll } = actor()
    const a1 = val(a.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 }))
    const a2 = val(a.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 2_000_000, t_end_us: 4_000_000 }))
    expect(a.dispatch('add_media', { id: 'm-a', kind: 'Audio', duration_us: 10_000_000, with_audio: true }).ok).toBe(true)
    val(a.dispatch('add_layer', { track: bRoll, kind: 'audio', media: 'm-a', src_in_us: 0, src_out_us: 1_000_000, t_start_us: 1_000_000, t_end_us: 2_000_000 })) // blocker
    const aud = val(a.dispatch('add_layer', { track: bRoll, kind: 'audio', media: 'm-a', src_in_us: 0, src_out_us: 2_000_000, t_start_us: 2_000_000, t_end_us: 4_000_000 }))
    expect(a.dispatch('groups_create', { layers: [a2, aud], label: null, reassign: false }).ok).toBe(true)
    const out = body(a.mcpCall('dry_run', JSON.stringify({ operations: [
      { kind: 'add_transition', from_layer_id: a1, to_layer_id: a2, duration_us: 1_000_000 },
    ] })))
    expect(out.results[0].status).toBe('ok')
    const predicted = (out.results[0].output as { bounces: Array<{ layer: string; from_track: string; spawned: boolean }> }).bounces
    expect(predicted).toHaveLength(1)
    expect(predicted[0]).toMatchObject({ layer: aud, from_track: bRoll, spawned: true })
    expect(a.snapshot().transitions).toEqual([]) // nothing committed, nothing logged
    expect(logged).toEqual([])
    // Wet run: same bounce, now performed and logged (spawned-track ids differ —
    // the dry run consumed deterministic ids of its own).
    expect(a.dispatch('add_transition', { from: a1, to: a2, duration_us: 1_000_000 }).ok).toBe(true)
    expect(logged).toHaveLength(1)
    expect(logged[0].details).toMatchObject({ kind: 'TransitionPlacementBounce', layer: aud, from_track: bRoll, spawned: true })
  })
})
