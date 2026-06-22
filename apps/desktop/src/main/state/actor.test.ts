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

describe('dispatch: group-membership family', () => {
  function setup() {
    const idGen = seededGen(); const initial = blankProject(idGen, 'g'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const mk = (t0: number, t1: number) => (actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: t0, t_end_us: t1 }) as { ok: true; value: string }).value
    return { actor, mk }
  }
  it('add_members then remove_members (auto-dissolve below 2)', () => {
    const { actor, mk } = setup()
    const l1 = mk(0, 1_000_000), l2 = mk(2_000_000, 3_000_000), l3 = mk(4_000_000, 5_000_000)
    const g = (actor.dispatch('groups_create', { layers: [l1, l2] }) as { ok: true; value: string }).value
    expect(actor.dispatch('groups_add_members', { group: g, layers: [l3] }).ok).toBe(true)
    expect(actor.snapshot().groups[0].members).toEqual([l1, l2, l3].sort())
    expect(actor.dispatch('groups_remove_members', { group: g, layers: [l2, l3] }).ok).toBe(true)
    expect(actor.snapshot().groups.length).toBe(0) // dropped below 2 → auto-dissolved
  })
  it('rename then dissolve', () => {
    const { actor, mk } = setup()
    const l1 = mk(0, 1_000_000), l2 = mk(2_000_000, 3_000_000)
    const g = (actor.dispatch('groups_create', { layers: [l1, l2] }) as { ok: true; value: string }).value
    expect(actor.dispatch('groups_rename', { group: g, label: 'scene' }).ok).toBe(true)
    expect(actor.snapshot().groups[0].label).toBe('scene')
    expect(actor.dispatch('groups_dissolve', { group: g }).ok).toBe(true)
    expect(actor.snapshot().groups.length).toBe(0)
  })
})

describe('dispatch: update_marker + remove_marker', () => {
  it('updates then removes a marker', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 'm')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const m = (actor.dispatch('add_marker', { t_us: 1_000_000 }) as { ok: true; value: string }).value
    expect(actor.dispatch('update_marker', { marker: m, patch: { label: 'chapter', end_t_us: 2_000_000 } }).ok).toBe(true)
    const snap = actor.snapshot()
    expect(snap.markers[0].label).toBe('chapter'); expect(snap.markers[0].end_t_us).toBe(2_000_000)
    expect(actor.dispatch('remove_marker', { marker: m }).ok).toBe(true)
    expect(actor.snapshot().markers.length).toBe(0)
  })
})

describe('dispatch: update_layer + fit_composition_to_layers', () => {
  it('update_layer patches the envelope; fit refits duration', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 'd'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const l = actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    expect(l.ok).toBe(true)
    const lid = (l as { ok: true; value: unknown }).value as string
    expect(actor.dispatch('update_layer', { layer: lid, patch: { t_end_us: 4_000_000, label: 'x' } }).ok).toBe(true)
    const snap = actor.snapshot()
    const layer = snap.tracks.flatMap((t) => t.layers).find((x) => x.id === lid)!
    expect(layer.t_end_us).toBe(4_000_000); expect(layer.label).toBe('x')
    expect(snap.composition.duration_us).toBe(1_000_000) // update_layer did NOT autofit (stayed at add_layer end)
    expect(actor.dispatch('fit_composition_to_layers', {}).ok).toBe(true)
    expect(actor.snapshot().composition.duration_us).toBe(4_000_000) // fit refit to layer end
  })
})

describe('dispatch: update_track_flags (unrecorded)', () => {
  it('locks a track; later update_layer on it is TrackLocked', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 't'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const l = (actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }) as { ok: true; value: string }).value
    expect(actor.dispatch('update_track_flags', { track: a, patch: { locked: true } }).ok).toBe(true)
    expect(actor.snapshot().tracks[0].locked).toBe(true)
    const r = actor.dispatch('update_layer', { layer: l, patch: { label: 'x' } })
    expect(r.ok).toBe(false); expect((r as { ok: false; error: { error: string } }).error.error).toBe('TrackLocked')
  })
  it('mute persists across undo (unrecorded)', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 't'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 2_000_000, t_end_us: 3_000_000 })
    actor.dispatch('update_track_flags', { track: a, patch: { muted: true } })
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.snapshot().tracks[0].muted).toBe(true) // unrecorded → survives undo
  })
  it('TrackNotFound for a missing track', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 't')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const r = actor.dispatch('update_track_flags', { track: '00000000-0000-0000-0000-000000000000', patch: { locked: true } })
    expect(r.ok).toBe(false); expect((r as { ok: false; error: { error: string } }).error.error).toBe('TrackNotFound')
  })
})

describe('dispatch: effect chain', () => {
  function setup() {
    const idGen = seededGen(); const initial = blankProject(idGen, 'fx'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const l = (actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }) as { ok: true; value: string }).value
    return { actor, l }
  }
  const fx = (actor: ReturnType<typeof createActor>, l: string) =>
    actor.snapshot().tracks[0].layers.find((x) => x.id === l)!.effects

  it('add → update(enabled) → move → remove', () => {
    const { actor, l } = setup()
    const e1 = (actor.dispatch('add_effect', { layer: l, kind: 'blur' }) as { ok: true; value: string }).value
    const e2 = (actor.dispatch('add_effect', { layer: l, kind: 'brightness' }) as { ok: true; value: string }).value
    expect(fx(actor, l).map((e) => e.id)).toEqual([e1, e2])
    expect(actor.dispatch('update_effect', { layer: l, effect: e1, patch: { enabled: false } }).ok).toBe(true)
    expect(fx(actor, l)[0].enabled).toBe(false)
    expect(actor.dispatch('move_effect', { layer: l, effect: e2, new_index: 0 }).ok).toBe(true)
    expect(fx(actor, l).map((e) => e.id)).toEqual([e2, e1])
    expect(actor.dispatch('remove_effect', { layer: l, effect: e1 }).ok).toBe(true)
    expect(fx(actor, l).map((e) => e.id)).toEqual([e2])
  })
  it('add_effect on a missing layer fails LayerNotFound but burns the id', () => {
    const { actor, l } = setup()
    const r = actor.dispatch('add_effect', { layer: '00000000-0000-0000-0000-000000000000', kind: 'blur' })
    expect(r.ok).toBe(false); expect((r as { ok: false; error: { error: string } }).error.error).toBe('LayerNotFound')
    // the burned id shifts the next add_effect's id forward by one.
    const eAfter = (actor.dispatch('add_effect', { layer: l, kind: 'blur' }) as { ok: true; value: string }).value
    expect(fx(actor, l)).toHaveLength(1); expect(fx(actor, l)[0].id).toBe(eAfter)
  })
})

describe('dispatch: delete_track + move_track', () => {
  it('move_track no-op does NOT record (later entity ids unshifted)', () => {
    const idGenA = seededGen(); const a1 = createActor({ initial: blankProject(idGenA, 't'), idGen: idGenA, clock: () => '<TS>' })
    a1.dispatch('move_track', { track: a1.snapshot().tracks[0].id, new_position: 0 }) // no-op
    const idA = (a1.dispatch('add_layer', { track: a1.snapshot().tracks[0].id, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }) as { ok: true; value: string }).value
    // A control actor that skips the no-op entirely must allocate the SAME layer id.
    const idGenB = seededGen(); const a2 = createActor({ initial: blankProject(idGenB, 't'), idGen: idGenB, clock: () => '<TS>' })
    const idB = (a2.dispatch('add_layer', { track: a2.snapshot().tracks[0].id, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }) as { ok: true; value: string }).value
    expect(idA).toBe(idB) // no-op move burned no op_id
  })
  it('delete_track removes a custom track; move_track reorders', () => {
    const idGen = seededGen(); const actor = createActor({ initial: blankProject(idGen, 't'), idGen, clock: () => '<TS>' })
    const t = (actor.dispatch('add_track', { label: 'x' }) as { ok: true; value: string }).value
    expect(actor.dispatch('move_track', { track: t, new_position: 0 }).ok).toBe(true)
    expect(actor.snapshot().tracks[0].id).toBe(t)
    expect(actor.dispatch('delete_track', { track: t, force: false }).ok).toBe(true)
    expect(actor.snapshot().tracks.find((x) => x.id === t)).toBeUndefined()
  })
})
