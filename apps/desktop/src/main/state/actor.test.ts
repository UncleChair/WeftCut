// apps/desktop/src/main/state/actor.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject } from './model'
import { colorParams } from './mutations/add'
import { createActor } from './actor'

function fresh() {
  const idGen = seededGen()
  const initial = blankProject(idGen, 'replay') // ids 1,2,3
  const actor = createActor({ initial, idGen, clock: () => '<TS>' })
  return { actor, idGen, aRoll: initial.tracks[0].id, bRoll: initial.tracks[1].id }
}

describe('actor commit pipeline', () => {
  it('seeds the initial history entry with one id (#4); first add_layer is #5', () => {
    const { actor, aRoll } = fresh()
    const r = actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    expect(r).toEqual({ ok: true, value: '00000000-0000-0000-0000-000000000005' })
  })

  it('rejects an overlapping add via ValidationFailed and leaves state + history untouched', () => {
    const { actor, aRoll } = fresh()
    actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    const before = actor.snapshot()
    const r = actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 500_000, t_end_us: 1_500_000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.error).toBe('ValidationFailed')
    expect(actor.snapshot().tracks[0].layers).toHaveLength(1) // unchanged
    expect(actor.historyStatus().len).toBe(before ? 2 : 2) // only the seed + 1 successful add
  })

  it('undo/redo move the snapshot and report boundaries', () => {
    const { actor, aRoll } = fresh()
    actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.snapshot().tracks[0].layers).toHaveLength(0)
    expect(actor.dispatch('undo', {})).toEqual({ ok: false, error: { error: 'NothingToUndo' } })
    expect(actor.dispatch('redo', {}).ok).toBe(true)
    expect(actor.snapshot().tracks[0].layers).toHaveLength(1)
  })

  it('emits a ChangeEvent on each successful commit', () => {
    const { actor, aRoll } = fresh()
    const events: string[] = []
    actor.subscribe((e) => events.push(e.summary))
    actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    expect(events.length).toBe(1)
  })

  it('dry_run applies+validates each op without committing, halting at the first error', () => {
    const { actor, aRoll } = fresh()
    const out = actor.dryRun([
      { kind: 'AddLayer', track_id: aRoll, params: colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), t_start_us: 0, t_end_us: 1_000_000 },
      { kind: 'AddLayer', track_id: aRoll, params: colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), t_start_us: 500_000, t_end_us: 1_500_000 },
    ])
    expect(out[0].ok).toBe(true)
    expect(out[1].ok).toBe(false)
    expect(actor.snapshot().tracks[0].layers).toHaveLength(0) // never committed
  })

  it('lock blocks undo with HistoryLocked', () => {
    const { actor, aRoll } = fresh()
    actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    actor.lockHistory('agent')
    expect(actor.dispatch('undo', {})).toEqual({ ok: false, error: { error: 'HistoryLocked', reason: 'agent' } })
  })
})

describe('dispatch: split + groups', () => {
  it('groups_create then split_layer through dispatch produce ok results', () => {
    const idGen = seededGen()
    const initial = blankProject(idGen, 'd')
    const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const l1 = actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    expect(l1.ok).toBe(true)
    const l2 = actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 2_000_000, t_end_us: 3_000_000 })
    expect(l2.ok).toBe(true)
    // l1.ok/l2.ok asserted true above; cast to narrow for test fixture access
    const l1v = (l1 as { ok: true; value: unknown }).value
    const l2v = (l2 as { ok: true; value: unknown }).value
    const g = actor.dispatch('groups_create', { layers: [l1v, l2v], reassign: false })
    expect(g.ok).toBe(true)
    expect(actor.snapshot().groups.length).toBe(1)
    const s = actor.dispatch('split_layer', { layer: l1v, at_t_us: 400_000, escape_group: false })
    expect(s.ok).toBe(true)
  })
  it('groups_create with < 2 layers returns a GroupCreateNeedsTwoLayers error', () => {
    const idGen = seededGen()
    const initial = blankProject(idGen, 'd')
    const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const l1 = actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    const l1v = (l1 as { ok: true; value: unknown }).value
    const g = actor.dispatch('groups_create', { layers: [l1v], reassign: false })
    expect(g.ok).toBe(false)
    expect(g.ok === false && g.error.error).toBe('GroupCreateNeedsTwoLayers')
  })
})
