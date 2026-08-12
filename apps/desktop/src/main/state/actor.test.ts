// apps/desktop/src/main/state/actor.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject } from './model'
import type { Project } from './model'
import { colorParams } from './mutations/add'
import { createActor, type DispatchResult } from './actor'

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
  it('split_layer_multi splits at every cut in ONE commit (one undo reverts all), returns segment ids', () => {
    const idGen = seededGen()
    const initial = blankProject(idGen, 'd')
    const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const VID = '00000000-0000-0000-0000-0000000000cc'
    actor.dispatch('add_media', { id: VID, kind: 'Video', duration_us: 6_000_000 })
    const add = actor.dispatch('add_layer', { track: a, kind: 'video', media: VID, src_in_us: 0, src_out_us: 6_000_000, t_start_us: 0, t_end_us: 6_000_000 })
    const layer = (add as { ok: true; value: unknown }).value as string
    const before = JSON.stringify(actor.snapshot())
    const lenBefore = actor.historyStatus().len
    const r = actor.dispatch('split_layer_multi', { layer, at_t_us_list: [2_000_000, 4_000_000], drop_short_us: null })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.value as string[]).length).toBe(3) // 2 cuts → 3 segments
    expect(actor.historyStatus().len - lenBefore).toBe(1) // ONE recorded commit
    const track = actor.snapshot().tracks.find((t) => t.id === a)!
    expect(track.layers.map((l) => [l.t_start_us, l.t_end_us])).toEqual([[0, 2_000_000], [2_000_000, 4_000_000], [4_000_000, 6_000_000]])
    expect(actor.dispatch('undo', {}).ok).toBe(true) // single commit → one undo restores all
    expect(JSON.stringify(actor.snapshot())).toBe(before)
  })
  it('split_layer_multi with drop_short_us deletes sub-threshold segments in the same commit', () => {
    const idGen = seededGen()
    const initial = blankProject(idGen, 'd')
    const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const VID = '00000000-0000-0000-0000-0000000000cc'
    actor.dispatch('add_media', { id: VID, kind: 'Video', duration_us: 6_000_000 })
    const add = actor.dispatch('add_layer', { track: a, kind: 'video', media: VID, src_in_us: 0, src_out_us: 6_000_000, t_start_us: 0, t_end_us: 6_000_000 })
    const layer = (add as { ok: true; value: unknown }).value as string
    const r = actor.dispatch('split_layer_multi', { layer, at_t_us_list: [2_000_000, 2_300_000], drop_short_us: 500_000 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.value as string[]).length).toBe(2) // the ~0.3s middle segment was dropped
    expect(actor.snapshot().tracks.find((t) => t.id === a)!.layers).toHaveLength(2)
  })
  it('add_markers drops every marker in ONE commit (one undo reverts all)', () => {
    const idGen = seededGen()
    const initial = blankProject(idGen, 'd')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const before = JSON.stringify(actor.snapshot())
    const r = actor.dispatch('add_markers', { markers: [{ t_us: 2_000_000, label: 'Cut 1' }, { t_us: 4_000_000, label: 'Cut 2' }] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.value as string[]).length).toBe(2)
    expect(actor.snapshot().markers.map((m) => m.t_us)).toEqual([2_000_000, 4_000_000])
    expect(actor.dispatch('undo', {}).ok).toBe(true) // single commit → one undo
    expect(JSON.stringify(actor.snapshot())).toBe(before)
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
  it('one move_effect dispatch records exactly one history entry (pointer drop = one undo)', () => {
    const { actor, l } = setup()
    const e1 = (actor.dispatch('add_effect', { layer: l, kind: 'blur' }) as { ok: true; value: string }).value
    actor.dispatch('add_effect', { layer: l, kind: 'brightness' })
    const before = actor.historyStatus().len
    expect(actor.dispatch('move_effect', { layer: l, effect: e1, new_index: 1 }).ok).toBe(true)
    expect(actor.historyStatus().len).toBe(before + 1)
  })
})

describe('dispatch: transitions', () => {
  function setup() {
    const idGen = seededGen(); const initial = blankProject(idGen, 'tr'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const a1 = (actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 }) as { ok: true; value: string }).value
    const a2 = (actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 2_000_000, t_end_us: 4_000_000 }) as { ok: true; value: string }).value
    return { actor, a1, a2 }
  }
  const fromEnd = (actor: ReturnType<typeof createActor>, id: string) =>
    actor.snapshot().tracks[0].layers.find((l) => l.id === id)!.t_end_us

  it('add_transition extends from_layer + records it; remove_transition shrinks back', () => {
    const { actor, a1, a2 } = setup()
    const t = actor.dispatch('add_transition', { from: a1, to: a2, duration_us: 1_000_000 })
    expect(t.ok).toBe(true)
    const tid = (t as { ok: true; value: string }).value
    expect(fromEnd(actor, a1)).toBe(3_000_000)
    expect(actor.snapshot().transitions.map((x) => x.id)).toEqual([tid])
    expect(actor.dispatch('remove_transition', { transition: tid }).ok).toBe(true)
    expect(fromEnd(actor, a1)).toBe(2_000_000)
    expect(actor.snapshot().transitions).toEqual([])
  })
  it('add_transition with cross-track to-layer fails LayerNotFound (no id burned)', () => {
    const { actor, a1 } = setup()
    const far = (actor.dispatch('add_layer', { track: actor.snapshot().tracks[1].id, kind: 'color', t_start_us: 9_000_000, t_end_us: 10_000_000 }) as { ok: true; value: string }).value
    const r = actor.dispatch('add_transition', { from: a1, to: far, duration_us: 1_000_000 })
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: { error: string } }).error.error).toBe('LayerNotFound') // far is on a different track → not found on a1's track
  })
  it('remove_transition unknown id → TransitionNotFound', () => {
    const { actor } = setup()
    const r = actor.dispatch('remove_transition', { transition: '00000000-0000-0000-0000-000000000000' })
    expect(r.ok).toBe(false); expect((r as { ok: false; error: { error: string } }).error.error).toBe('TransitionNotFound')
  })

  // ── kind + direction parsing ──
  const errOf = (r: ReturnType<ReturnType<typeof createActor>['dispatch']>) =>
    (r as { ok: false; error: { error: string; field?: string } }).error

  it('add_transition without kind defaults to Crossfade (pre-04 behavior)', () => {
    const { actor, a1, a2 } = setup()
    expect(actor.dispatch('add_transition', { from: a1, to: a2, duration_us: 1_000_000 }).ok).toBe(true)
    expect(actor.snapshot().transitions[0].kind).toEqual({ kind: 'Crossfade' })
  })
  it('add_transition parses all three kinds (Wipe/Slide carry direction)', () => {
    for (const [kind, direction, expected] of [
      ['Crossfade', undefined, { kind: 'Crossfade' }],
      ['Wipe', 'left', { kind: 'Wipe', direction: 'left' }],
      ['Slide', 'up', { kind: 'Slide', direction: 'up' }],
    ] as const) {
      const { actor, a1, a2 } = setup()
      const r = actor.dispatch('add_transition', { from: a1, to: a2, duration_us: 1_000_000, kind, direction })
      expect(r.ok, `kind ${kind}`).toBe(true)
      expect(actor.snapshot().transitions[0].kind).toEqual(expected)
    }
  })
  it('add_transition Wipe/Slide without direction → InvalidArgument(direction)', () => {
    for (const kind of ['Wipe', 'Slide']) {
      const { actor, a1, a2 } = setup()
      const r = actor.dispatch('add_transition', { from: a1, to: a2, duration_us: 1_000_000, kind })
      expect(r.ok).toBe(false)
      expect([errOf(r).error, errOf(r).field]).toEqual(['InvalidArgument', 'direction'])
      expect(actor.snapshot().transitions).toEqual([])
    }
  })
  it('add_transition Crossfade WITH direction → InvalidArgument(direction) (strict pairing)', () => {
    const { actor, a1, a2 } = setup()
    const r = actor.dispatch('add_transition', { from: a1, to: a2, duration_us: 1_000_000, kind: 'Crossfade', direction: 'left' })
    expect(r.ok).toBe(false)
    expect([errOf(r).error, errOf(r).field]).toEqual(['InvalidArgument', 'direction'])
  })
  it('add_transition unknown kind / bad direction string → InvalidArgument', () => {
    const { actor, a1, a2 } = setup()
    const badKind = actor.dispatch('add_transition', { from: a1, to: a2, duration_us: 1_000_000, kind: 'Dissolve' })
    expect([errOf(badKind).error, errOf(badKind).field]).toEqual(['InvalidArgument', 'kind'])
    const badDir = actor.dispatch('add_transition', { from: a1, to: a2, duration_us: 1_000_000, kind: 'Wipe', direction: 'sideways' })
    expect([errOf(badDir).error, errOf(badDir).field]).toEqual(['InvalidArgument', 'direction'])
    expect(actor.snapshot().transitions).toEqual([])
  })

  // ── update_transition dispatch ──
  function withCrossfade() {
    const s = setup()
    const tid = (s.actor.dispatch('add_transition', { from: s.a1, to: s.a2, duration_us: 1_000_000 }) as { ok: true; value: string }).value
    return { ...s, tid } // a1 extended to 3M; overlap [2M,3M]
  }
  it('update_transition duration patch moves the outgoing tail; ONE recorded entry (one undo)', () => {
    const { actor, a1, tid } = withCrossfade()
    const before = actor.historyStatus().len
    expect(actor.dispatch('update_transition', { transition: tid, duration_us: 500_000 }).ok).toBe(true)
    expect(actor.snapshot().transitions[0].duration_us).toBe(500_000)
    expect(fromEnd(actor, a1)).toBe(2_500_000) // shrink rides the same commit
    expect(actor.historyStatus().len).toBe(before + 1)
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.snapshot().transitions[0].duration_us).toBe(1_000_000)
    expect(fromEnd(actor, a1)).toBe(3_000_000)
  })
  it('update_transition kind patch (+direction) swaps kind without touching geometry', () => {
    const { actor, a1, tid } = withCrossfade()
    expect(actor.dispatch('update_transition', { transition: tid, kind: 'Wipe', direction: 'right' }).ok).toBe(true)
    expect(actor.snapshot().transitions[0].kind).toEqual({ kind: 'Wipe', direction: 'right' })
    expect(fromEnd(actor, a1)).toBe(3_000_000) // untouched
  })
  it('update_transition duration + kind together in one commit', () => {
    const { actor, a1, tid } = withCrossfade()
    const before = actor.historyStatus().len
    expect(actor.dispatch('update_transition', { transition: tid, duration_us: 1_500_000, kind: 'Slide', direction: 'down' }).ok).toBe(true)
    expect(actor.snapshot().transitions[0]).toMatchObject({ duration_us: 1_500_000, kind: { kind: 'Slide', direction: 'down' } })
    expect(fromEnd(actor, a1)).toBe(3_500_000)
    expect(actor.historyStatus().len).toBe(before + 1)
  })
  it('update_transition direction without kind → InvalidArgument(direction)', () => {
    const { actor, tid } = withCrossfade()
    const r = actor.dispatch('update_transition', { transition: tid, direction: 'left' })
    expect([errOf(r).error, errOf(r).field]).toEqual(['InvalidArgument', 'direction'])
  })
  it('update_transition unknown id → TransitionNotFound', () => {
    const { actor } = withCrossfade()
    const r = actor.dispatch('update_transition', { transition: '00000000-0000-0000-0000-000000000000', duration_us: 500_000 })
    expect([errOf(r).error]).toEqual(['TransitionNotFound'])
  })

  // ── dryRun ↔ commit alignment ──
  it('dryRun runs reconcile like commit: a trim over a transition edge predicts succeed-with-drop, not ValidationFailed', () => {
    const { actor, a2 } = withCrossfade()
    const out = actor.dryRun([{ kind: 'TrimLayer', id: a2, edge: 'In', new_t_us: 3_000_000, escape_group: false }])
    expect(out[0].ok, 'dry-run must match the real succeed-with-drop outcome').toBe(true)
    expect(actor.snapshot().transitions).toHaveLength(1) // dry-run committed nothing
    // parity: the real command also succeeds and drops the transition
    expect(actor.dispatch('trim_layer', { layer: a2, edge: 'in', new_t_us: 3_000_000 }).ok).toBe(true)
    expect(actor.snapshot().transitions).toEqual([])
  })
})

describe('dispatch: set_composition full', () => {
  function withTwoLayers() {
    const idGen = seededGen(); const initial = blankProject(idGen, 'sc')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    actor.dispatch('add_layer', { track: initial.tracks[0].id, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 })
    actor.dispatch('add_layer', { track: initial.tracks[1].id, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    return actor
  }
  // ── The rate lock (spec R2-D1/R2-D2) ─────────────────────────────────────────
  it('fps is locked once any track holds a layer', () => {
    const actor = withTwoLayers()
    const before = JSON.stringify(actor.snapshot())
    const historyBefore = actor.historyStatus().len
    const events: string[] = []
    actor.subscribe((e) => events.push(e.summary))

    const r = actor.dispatch('set_composition', { fps: { num: 24, den: 1 } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // Structured, self-correcting: the caller learns the rate it is stuck with,
      // what it asked for, and WHY — without a second round trip.
      expect(r.error).toEqual({
        error: 'FpsLockedByContent',
        current: { num: 30, den: 1 },
        requested: { num: 24, den: 1 },
        layer_count: 2,
        locked_by: 'current',
      })
    }
    // Mints no op_id, records nothing, emits nothing, changes nothing.
    expect(JSON.stringify(actor.snapshot())).toBe(before)
    expect(actor.historyStatus().len).toBe(historyBefore)
    expect(events).toEqual([])
  })

  // ── The lock's history scope ─────────────────────────────────────────────────
  // The whole point: an unrecorded rate change lands in EVERY snapshot, so judging
  // the lock on the current state alone would leave undo as a backdoor that hands
  // back old-grid layers at the new rate.
  it('fps stays locked after the layers are deleted — undo could still resurrect them', () => {
    const actor = withTwoLayers()
    for (const t of actor.snapshot().tracks) {
      for (const l of t.layers) expect(actor.dispatch('delete_layer', { layer: l.id }).ok).toBe(true)
    }
    expect(actor.snapshot().tracks.every((t) => t.layers.length === 0)).toBe(true)

    const r = actor.dispatch('set_composition', { fps: { num: 24, den: 1 } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // layer_count is the LIVE count and is honestly 0; locked_by is what carries
      // the real reason, so a caller must not read 0 as "nothing is blocking".
      expect(r.error).toEqual({
        error: 'FpsLockedByContent',
        current: { num: 30, den: 1 },
        requested: { num: 24, den: 1 },
        layer_count: 0,
        locked_by: 'history',
      })
    }
    // And the undo path it protects still returns the layers at the ORIGINAL rate.
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.snapshot().composition.fps).toEqual({ num: 30, den: 1 })
  })

  it('a checkpoint holding a layer locks the rate even with an empty stack head', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 'sc-cp')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const layer = actor.dispatch('add_layer', { track: initial.tracks[0].id, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    expect(layer.ok).toBe(true)
    actor.checkpoint('before the purge')
    expect(actor.dispatch('delete_layer', { layer: layer.ok ? layer.value : '' }).ok).toBe(true)

    const r = actor.dispatch('set_composition', { fps: { num: 24, den: 1 } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatchObject({ error: 'FpsLockedByContent', locked_by: 'history' })
  })

  it('a project that has never held a layer is freely re-rateable', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 'sc-virgin')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    // Markers and a pinned duration are stored history too, but neither locks (R2-D2).
    expect(actor.dispatch('add_marker', { t_us: 100_000, end_t_us: 400_000, label: 'm' }).ok).toBe(true)
    expect(actor.dispatch('set_composition', { duration_us: 5_000_000 }).ok).toBe(true)
    expect(actor.dispatch('set_composition', { fps: { num: 24, den: 1 } }).ok).toBe(true)
    expect(actor.snapshot().composition.fps).toEqual({ num: 24, den: 1 })
  })

  it('a locked fps patch consumes no op_id', () => {
    // The seeded idGen makes this directly observable: run the same script with and
    // without the rejected patch in the middle. If the failure had reached commit()
    // — or minted an id anywhere else — the ids would diverge from here on.
    const nextLayerId = (withFailedPatch: boolean): string => {
      const actor = withTwoLayers()
      if (withFailedPatch) {
        expect(actor.dispatch('set_composition', { fps: { num: 24, den: 1 } }).ok).toBe(false)
      }
      const r = actor.dispatch('add_layer', { track: actor.snapshot().tracks[0].id, kind: 'color', t_start_us: 2_000_000, t_end_us: 3_000_000 })
      expect(r.ok).toBe(true)
      return r.ok ? (r.value as string) : ''
    }
    expect(nextLayerId(true)).toBe(nextLayerId(false))
  })

  it('fps change on a LAYER-LESS project re-snaps markers + duration in EVERY snapshot, unrecorded', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 'sc-empty')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    // Markers and a pinned duration do NOT lock the rate (R2-D2) — and both must
    // land canonical on the new grid or the grid backstop rejects the whole change.
    // TWO recorded marker adds, so the stack holds an intermediate snapshot with a
    // marker in it — that older snapshot is what the per-snapshot re-snap is for.
    expect(actor.dispatch('add_marker', { t_us: 100_000, end_t_us: 400_000, label: 'm1' }).ok).toBe(true)
    expect(actor.dispatch('add_marker', { t_us: 700_000, label: 'm2' }).ok).toBe(true)
    expect(actor.dispatch('set_composition', { duration_us: 5_000_000 }).ok).toBe(true)
    const historyBefore = actor.historyStatus().len

    expect(actor.dispatch('set_composition', { fps: { num: 30_000, den: 1001 } }).ok).toBe(true)
    const after = actor.snapshot()
    expect(after.composition.fps).toEqual({ num: 30_000, den: 1001 })
    expect(after.composition.duration_pinned).toBe(true)
    // 5_000_000 µs at 29.97 → frame 149.85 → 150 → 150 * 1e6 * 1001 / 30000.
    expect(after.composition.duration_us).toBe(5_005_000)
    expect(after.markers[0].t_us).toBe(100_100) // frame 3
    expect(after.markers[0].end_t_us).toBe(400_400) // frame 12
    expect(actor.historyStatus().len).toBe(historyBefore) // unrecorded — no new entry

    // Undo back over the second marker add. The rate persists (patched into that
    // snapshot too) and — the reason the re-snap must be per-snapshot — the marker
    // it restores is canonical on the NEW grid, not the rate it was authored at.
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    const older = actor.snapshot()
    expect(older.markers).toHaveLength(1)
    expect(older.composition.fps).toEqual({ num: 30_000, den: 1001 })
    expect(older.markers[0].t_us).toBe(100_100)
    expect(older.markers[0].end_t_us).toBe(400_400)
    expect(actor.dispatch('undo', {}).ok).toBe(true) // back to Initial
    expect(actor.snapshot().composition.fps).toEqual({ num: 30_000, den: 1001 })
    expect(actor.snapshot().markers).toEqual([])
  })

  it('a pinned duration is unrecorded and floored per snapshot at that snapshot\'s own content end', () => {
    // Snapshot A holds a 10 s layer; the head trims it to 2 s. Pinning 3 s must NOT
    // copy 3 s into A — that would leave A's own layer stranded 7 s past the end.
    const idGen = seededGen(); const initial = blankProject(idGen, 'sc-guard')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const added = actor.dispatch('add_layer', { track: initial.tracks[0].id, kind: 'color', t_start_us: 0, t_end_us: 10_000_000 })
    expect(added.ok).toBe(true)
    const layerId = added.ok ? (added.value as string) : ''
    expect(actor.dispatch('trim_layer', { layer: layerId, edge: 'out', new_t_us: 2_000_000 }).ok).toBe(true)
    const historyBefore = actor.historyStatus().len

    expect(actor.dispatch('set_composition', { duration_us: 3_000_000 }).ok).toBe(true)
    expect(actor.snapshot().composition.duration_us).toBe(3_000_000)
    expect(actor.snapshot().composition.duration_pinned).toBe(true)
    expect(actor.historyStatus().len).toBe(historyBefore) // unrecorded

    // Undo back to the 10 s-layer snapshot: pin survives (unrecorded), but the value
    // is that snapshot's own content end, so nothing is stranded.
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    const back = actor.snapshot()
    expect(back.tracks[0].layers[0].t_end_us).toBe(10_000_000)
    expect(back.composition.duration_pinned).toBe(true)
    expect(back.composition.duration_us).toBe(10_000_000)
    // The invariant this all exists to protect, asserted directly.
    const maxEnd = Math.max(...back.tracks.flatMap((t) => t.layers.map((l) => l.t_end_us)))
    expect(back.composition.duration_us).toBeGreaterThanOrEqual(maxEnd)
  })

  it('fit_composition_to_layers is unrecorded and refits each snapshot to its own high-water mark', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 'sc-fit')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const added = actor.dispatch('add_layer', { track: initial.tracks[0].id, kind: 'color', t_start_us: 0, t_end_us: 4_000_000 })
    const layerId = added.ok ? (added.value as string) : ''
    expect(actor.dispatch('trim_layer', { layer: layerId, edge: 'out', new_t_us: 1_000_000 }).ok).toBe(true)
    expect(actor.dispatch('set_composition', { duration_us: 9_000_000 }).ok).toBe(true)
    const historyBefore = actor.historyStatus().len

    expect(actor.dispatch('fit_composition_to_layers', {}).ok).toBe(true)
    expect(actor.snapshot().composition.duration_pinned).toBe(false)
    expect(actor.snapshot().composition.duration_us).toBe(1_000_000) // head's own content end
    expect(actor.historyStatus().len).toBe(historyBefore) // unrecorded

    expect(actor.dispatch('undo', {}).ok).toBe(true) // the 4 s-layer snapshot
    expect(actor.snapshot().composition.duration_pinned).toBe(false) // unpin survived
    expect(actor.snapshot().composition.duration_us).toBe(4_000_000) // ITS own mark, not 1 s
  })
  it('canvas-only change is unrecorded and survives undo of a prior edit', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 'sc2')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    actor.dispatch('add_layer', { track: initial.tracks[0].id, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    expect(actor.dispatch('set_composition', { width: 1280, height: 720 }).ok).toBe(true)
    expect(actor.snapshot().composition.width).toBe(1280)
    actor.dispatch('undo', {}) // back to Initial — canvas must persist (replace-everywhere)
    expect(actor.snapshot().composition.width).toBe(1280)
    expect(actor.snapshot().tracks[0].layers).toHaveLength(0)
  })
  it('pins duration on explicit duration write; autofit overflow guard holds', () => {
    const actor = withTwoLayers()
    expect(actor.dispatch('set_composition', { duration_us: 10_000_000 }).ok).toBe(true)
    expect(actor.snapshot().composition.duration_us).toBe(10_000_000)
    expect(actor.snapshot().composition.duration_pinned).toBe(true)
  })
  it('valid mixed canvas + duration', () => {
    const actor = withTwoLayers()
    const r = actor.dispatch('set_composition', { width: 1280, height: 720, duration_us: 5_000_000 })
    expect(r.ok).toBe(true)
    expect(actor.snapshot().composition.width).toBe(1280)
    expect(actor.snapshot().composition.height).toBe(720)
    expect(actor.snapshot().composition.duration_us).toBe(5_000_000)
    expect(actor.snapshot().composition.duration_pinned).toBe(true)
  })
  it('atomicity rollback: invalid canvas blocks duration from being applied', () => {
    const actor = withTwoLayers()
    const preDuration = actor.snapshot().composition.duration_us
    const r = actor.dispatch('set_composition', { width: 0, duration_us: 5_000_000 })
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: { error: string } }).error.error).toBe('ValidationFailed')
    expect(actor.snapshot().composition.width).toBe(1920)
    expect(actor.snapshot().composition.duration_us).toBe(preDuration)
    expect(actor.snapshot().composition.duration_pinned).toBe(false)
  })
  it('fps + duration combined pins duration at the frame-snapped value', () => {
    // Layer-less: the rate lock rejects a combined patch too, and it rejects the
    // WHOLE patch — so the duration half must not land either (tested below).
    const idGen = seededGen(); const initial = blankProject(idGen, 'sc-fps-dur')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const r = actor.dispatch('set_composition', { fps: { num: 24, den: 1 }, duration_us: 3_000_000 })
    expect(r.ok).toBe(true)
    expect(actor.snapshot().composition.fps).toEqual({ num: 24, den: 1 })
    expect(actor.snapshot().composition.duration_pinned).toBe(true)
    expect(actor.snapshot().composition.duration_us).toBe(3_000_000)
  })

  it('the lock rejects the whole patch — a bundled duration/canvas write does not slip through', () => {
    const actor = withTwoLayers()
    const before = actor.snapshot().composition
    const r = actor.dispatch('set_composition', { fps: { num: 24, den: 1 }, duration_us: 9_000_000, width: 1280 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.error).toBe('FpsLockedByContent')
    expect(actor.snapshot().composition.duration_us).toBe(before.duration_us)
    expect(actor.snapshot().composition.duration_pinned).toBe(before.duration_pinned)
    expect(actor.snapshot().composition.width).toBe(before.width)
  })
})

describe('dispatch: media pool + media layers', () => {
  const VID = '00000000-0000-0000-0000-0000000000aa'
  function setup() {
    const idGen = seededGen(); const initial = blankProject(idGen, 'm'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    return { actor, a }
  }
  it('add_media inserts into the pool (unrecorded) and survives undo of a later edit', () => {
    const { actor, a } = setup()
    expect(actor.dispatch('add_media', { id: VID, kind: 'Video', duration_us: 4_000_000 }).ok).toBe(true)
    expect(Object.keys(actor.snapshot().media_pool)).toEqual([VID])
    actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }) // recorded
    actor.dispatch('undo', {})
    expect(actor.snapshot().tracks[0].layers).toHaveLength(0) // edit undone
    expect(Object.keys(actor.snapshot().media_pool)).toEqual([VID]) // pool persists (replace-everywhere)
  })
  it('add_layer video referencing pooled media succeeds', () => {
    const { actor, a } = setup()
    actor.dispatch('add_media', { id: VID, kind: 'Video', duration_us: 4_000_000 })
    const r = actor.dispatch('add_layer', { track: a, kind: 'video', media: VID, src_in_us: 0, src_out_us: 4_000_000, t_start_us: 0, t_end_us: 4_000_000 })
    expect(r.ok).toBe(true)
    expect(actor.snapshot().tracks[0].layers[0].params.kind).toBe('VideoClip')
  })
  it('add_layer video with media NOT in the pool → ValidationFailed(MissingMedia)', () => {
    const { actor, a } = setup()
    const r = actor.dispatch('add_layer', { track: a, kind: 'video', media: VID, src_in_us: 0, src_out_us: 4_000_000, t_start_us: 0, t_end_us: 4_000_000 })
    expect(r.ok).toBe(false)
    const err = (r as { ok: false; error: { error: string; detail?: { rule: string } } }).error
    expect([err.error, err.detail?.rule]).toEqual(['ValidationFailed', 'MissingMedia'])
  })
  it('add_layer video whose src_out exceeds the media duration → SrcRangeExceedsMedia', () => {
    const { actor, a } = setup()
    actor.dispatch('add_media', { id: VID, kind: 'Video', duration_us: 2_000_000 })
    const r = actor.dispatch('add_layer', { track: a, kind: 'video', media: VID, src_in_us: 0, src_out_us: 5_000_000, t_start_us: 0, t_end_us: 5_000_000 })
    expect((r as { ok: false; error: { detail?: { rule: string } } }).error.detail?.rule).toBe('SrcRangeExceedsMedia')
  })
})

describe('dispatch: separate_audio', () => {
  const AID = '00000000-0000-0000-0000-0000000000bb'
  it('separate_audio lifts the audio layer onto a new track', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 'sa'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    actor.dispatch('add_media', { id: AID, kind: 'Audio', duration_us: 3_000_000 })
    const l = (actor.dispatch('add_layer', { track: a, kind: 'audio', media: AID, src_in_us: 0, src_out_us: 3_000_000, t_start_us: 0, t_end_us: 3_000_000 }) as { ok: true; value: string }).value
    const r = actor.dispatch('separate_audio', { layer: l })
    expect(r.ok).toBe(true)
    const tracks = actor.snapshot().tracks
    expect(tracks[0].id).toBe((r as { ok: true; value: string }).value) // new track inserted before A
    expect(tracks[0].layers.map((x) => x.id)).toEqual([l])
    // A-roll carries no stored label of its own, so there is no source name to
    // quote — the lifted lane derives one (mutations/media.test.ts covers both
    // halves of the exception).
    expect(tracks[0].label).toBeNull()
  })
  it('separate_audio on a color layer → WrongLayerKind', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 'sa2'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const l = (actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }) as { ok: true; value: string }).value
    const r = actor.dispatch('separate_audio', { layer: l })
    expect((r as { ok: false; error: { error: string } }).error.error).toBe('WrongLayerKind')
  })
  it('separate_audio on a missing layer → LayerNotFound', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 'sa3')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const r = actor.dispatch('separate_audio', { layer: '00000000-0000-0000-0000-000000000000' })
    expect((r as { ok: false; error: { error: string } }).error.error).toBe('LayerNotFound')
  })
})

describe('dispatch: params', () => {
  function textActor() {
    const idGen = seededGen(); const initial = blankProject(idGen, 'pp')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const id = (actor.dispatch('add_layer', { track: initial.tracks[1].id, kind: 'text', t_start_us: 0, t_end_us: 2_000_000 }) as { ok: true; value: string }).value
    return { actor, id }
  }
  it('update_layer_params merges fields (recorded; undoable)', () => {
    const { actor, id } = textActor()
    const before = JSON.stringify(actor.snapshot())
    expect(actor.dispatch('update_layer_params', { layer: id, patch: { kind: 'Text', opacity: 0.25, content: 'z' } }).ok).toBe(true)
    const t = actor.snapshot().tracks[1].layers[0].params as Extract<ReturnType<typeof actor.snapshot>['tracks'][0]['layers'][0]['params'], { kind: 'Text' }>
    expect([t.opacity, t.content]).toEqual([{ mode: 'Static', value: 0.25 }, 'z'])
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(JSON.stringify(actor.snapshot())).toBe(before)
  })
  it('update_layer_params kind mismatch → LayerParamsKindMismatch', () => {
    const { actor, id } = textActor()
    const r = actor.dispatch('update_layer_params', { layer: id, patch: { kind: 'Color', width: 1 } })
    expect((r as { ok: false; error: { error: string } }).error.error).toBe('LayerParamsKindMismatch')
  })
  it('update_layer_param_track writes opacity keyframes', () => {
    const { actor, id } = textActor()
    const track = { mode: 'Keyframed', value: [
      { id: '00000000-0000-0000-0000-0000000000f1', t_us: 0, value: 0, interp: { kind: 'Linear' } },
      { id: '00000000-0000-0000-0000-0000000000f2', t_us: 1_000_000, value: 1, interp: { kind: 'Linear' } }] }
    expect(actor.dispatch('update_layer_param_track', { layer: id, param_key: 'opacity', track }).ok).toBe(true)
    expect((actor.snapshot().tracks[1].layers[0].params as { opacity: { mode: string } }).opacity.mode).toBe('Keyframed')
  })
  it('update_layer_param_tracks applies a batch in one commit (one undo reverts all)', () => {
    const { actor, id } = textActor()
    const before = JSON.stringify(actor.snapshot())
    const kf = (v: number) => ({ mode: 'Keyframed', value: [{ id: '00000000-0000-0000-0000-0000000000f1', t_us: 0, value: v, interp: { kind: 'Linear' } }, { id: '00000000-0000-0000-0000-0000000000f2', t_us: 1_000_000, value: v, interp: { kind: 'Linear' } }] })
    expect(actor.dispatch('update_layer_param_tracks', { layer: id, entries: [['x', kf(0)], ['opacity', kf(1)]] }).ok).toBe(true)
    expect(actor.dispatch('undo', {}).ok).toBe(true) // single commit → one undo
    expect(JSON.stringify(actor.snapshot())).toBe(before)
  })
})

describe('dispatch: role gain + flags + project settings', () => {
  function setup() {
    const idGen = seededGen(); const initial = blankProject(idGen, 'r'); const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    return { actor, a }
  }
  it('set_role_gain inserts a role bus and is undoable (recorded)', () => {
    const { actor } = setup()
    expect(actor.dispatch('set_role_gain', { role: 'music', gain_db: 6 }).ok).toBe(true)
    expect(actor.snapshot().audio_roles.music).toEqual({ gain_db: 6, muted: false, solo: false })
    actor.dispatch('undo', {})
    expect(actor.snapshot().audio_roles).toEqual({}) // recorded → undo clears the bus
  })
  it('reset (set_role_gain to 0) restores neutral gain and is undoable back to the prior gain', () => {
    const { actor } = setup()
    actor.dispatch('set_role_gain', { role: 'music', gain_db: 6 })
    expect(actor.dispatch('set_role_gain', { role: 'music', gain_db: 0 }).ok).toBe(true) // reset = 0 dB
    expect(actor.snapshot().audio_roles.music).toEqual({ gain_db: 0, muted: false, solo: false })
    actor.dispatch('undo', {})
    expect(actor.snapshot().audio_roles.music).toEqual({ gain_db: 6, muted: false, solo: false }) // recorded → undo restores
  })
  it('set_role_gain then update_role_flags: flags preserve the gain', () => {
    const { actor } = setup()
    actor.dispatch('set_role_gain', { role: 'music', gain_db: 6 })
    actor.dispatch('update_role_flags', { role: 'music', patch: { muted: true } })
    expect(actor.snapshot().audio_roles.music).toEqual({ gain_db: 6, muted: true, solo: false })
  })
  it('update_role_flags toggles mute (unrecorded) and survives undo of a later edit', () => {
    const { actor, a } = setup()
    actor.dispatch('update_role_flags', { role: 'dialogue', patch: { muted: true } })
    expect(actor.snapshot().audio_roles.dialogue).toEqual({ gain_db: 0, muted: true, solo: false })
    actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    actor.dispatch('undo', {})
    expect(actor.snapshot().tracks[0].layers).toHaveLength(0) // edit undone
    expect(actor.snapshot().audio_roles.dialogue).toEqual({ gain_db: 0, muted: true, solo: false }) // flag persists
  })
  it('update_role_flags toggles solo (unrecorded) and survives undo of a later edit', () => {
    const { actor, a } = setup()
    actor.dispatch('update_role_flags', { role: 'music', patch: { solo: true } })
    expect(actor.snapshot().audio_roles.music).toEqual({ gain_db: 0, muted: false, solo: true })
    actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    actor.dispatch('undo', {})
    expect(actor.snapshot().tracks[0].layers).toHaveLength(0) // edit undone
    expect(actor.snapshot().audio_roles.music).toEqual({ gain_db: 0, muted: false, solo: true }) // flag persists
  })
  it('update_project_settings sets prefer_proxies + proxy_overrides (unrecorded, survives undo)', () => {
    const { actor, a } = setup()
    actor.dispatch('update_project_settings', { patch: { prefer_proxies: true } })
    actor.dispatch('update_project_settings', { patch: { proxy_override: { media_id: 'm1', value: false } } })
    expect(actor.snapshot().settings.prefer_proxies).toBe(true)
    expect(actor.snapshot().settings.proxy_overrides).toEqual({ m1: false })
    // clearing an override removes the key (Auto = follow global)
    actor.dispatch('update_project_settings', { patch: { proxy_override: { media_id: 'm1', value: null } } })
    expect(actor.snapshot().settings.proxy_overrides).toEqual({})
    // preference survives undo
    actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    actor.dispatch('undo', {})
    expect(actor.snapshot().settings.prefer_proxies).toBe(true)
  })
})

describe('dispatch: caption tracks', () => {
  const CLEAN = { size_px: 54, outline_px: 3, shadow_px: 2 }
  function setup() {
    const idGen = seededGen(); const initial = blankProject(idGen, 'cap')
    const actor = createActor({ idGen, initial, clock: () => '<TS>' })
    return { actor, a: initial.tracks[0].id }
  }
  it('add_caption_track creates a Caption track and returns its id', () => {
    const { actor } = setup()
    const r = actor.dispatch('add_caption_track', { cues: [{ start_us: 0, end_us: 1_000_000, text: 'a', style: CLEAN }], comp_w: 1920, comp_h: 1080, label: 'Captions' })
    expect(r.ok).toBe(true)
    const tid = (r as { ok: true; value: string }).value
    const ct = actor.snapshot().tracks.find((t) => t.id === tid)!
    expect([ct.role, ct.layers[0].params.kind]).toEqual(['Caption', 'Text'])
  })
  it('add_caption_track is recorded → undo removes it', () => {
    const { actor } = setup()
    actor.dispatch('add_caption_track', { cues: [{ start_us: 0, end_us: 1_000_000, text: 'a', style: CLEAN }], comp_w: 1920, comp_h: 1080, label: null })
    expect(actor.snapshot().tracks.some((t) => t.role === 'Caption')).toBe(true)
    actor.dispatch('undo', {})
    expect(actor.snapshot().tracks.some((t) => t.role === 'Caption')).toBe(false)
  })
  // Project-wide restyle over overlapping caption lanes: two cues that overlap
  // lane-pack into TWO caption tracks, so this exercises the cross-track corpus.
  function setupTwoCaptionLanes() {
    const { actor } = setup()
    actor.dispatch('add_caption_track', { cues: [
      { start_us: 0, end_us: 2_000_000, text: 'a', style: CLEAN },
      { start_us: 1_000_000, end_us: 3_000_000, text: 'b', style: CLEAN },
    ], comp_w: 1920, comp_h: 1080, label: null })
    const caps = actor.snapshot().tracks.filter((t) => t.role === 'Caption')
    expect(caps).toHaveLength(2)
    return { actor }
  }
  const sizeOf = (t: { layers: Array<{ params: unknown }> }) =>
    (t.layers[0].params as { font: { size_px: number } }).font.size_px

  it('restyle_captions patches Text layers on EVERY caption track in one entry', () => {
    const { actor } = setupTwoCaptionLanes()
    const lenBefore = actor.historyStatus().len
    const r = actor.dispatch('restyle_captions', { patch: { font_size_px: 72 } })
    expect(r.ok).toBe(true)
    for (const t of actor.snapshot().tracks.filter((t) => t.role === 'Caption')) expect(sizeOf(t)).toBe(72)
    // One atomic command ⇒ exactly one new recorded history entry.
    expect(actor.historyStatus().len).toBe(lenBefore + 1)
  })

  it('restyle_captions is one undo entry that reverts all caption tracks together', () => {
    const { actor } = setupTwoCaptionLanes()
    actor.dispatch('restyle_captions', { patch: { font_size_px: 72 } })
    actor.dispatch('undo', {})
    for (const t of actor.snapshot().tracks.filter((t) => t.role === 'Caption')) expect(sizeOf(t)).toBe(54)
  })

  it('restyle_captions with no caption tracks records nothing (no-op guard)', () => {
    const { actor } = setup()
    const lenBefore = actor.historyStatus().len
    const r = actor.dispatch('restyle_captions', { patch: { font_size_px: 72 } })
    expect(r.ok).toBe(true)
    expect(actor.historyStatus().len).toBe(lenBefore)
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

describe('replace_state (wholesale swap + history reset)', () => {
  it('resets history to a fresh single-entry stack and clears redo/checkpoints/lock', () => {
    const gen = seededGen()
    const actor = createActor({ initial: blankProject(gen, 'orig'), idGen: gen, clock: () => '<TS>' })
    actor.dispatch('add_track', { label: 'x' })            // cursor 1, len 2
    actor.lockHistory('busy')
    actor.replaceState(blankProject(gen, 'replaced'))
    const s = actor.historyStatus()
    expect([s.cursor, s.len, s.can_undo, s.can_redo]).toEqual([0, 1, false, false])
    expect(s.lock_reason).toBeUndefined()                  // reset clears the lock
    expect(actor.snapshot().metadata.name).toBe('replaced')
  })
  it('a validate-failure leaves history untouched (validate runs first, mints no id)', () => {
    const gen = seededGen()
    const actor = createActor({ initial: blankProject(gen, 'orig'), idGen: gen, clock: () => '<TS>' })
    actor.dispatch('add_track', { label: 'x' })
    const before = actor.snapshot()
    // A group with <2 members violates the group-size invariant (§2.4) → the
    // simplest deterministic ValidationFailed without constructing layer params.
    const bad: Project = blankProject(seededGen(), 'bad')
    bad.groups = [{ id: '00000000-0000-0000-0000-0000000000b1', members: ['00000000-0000-0000-0000-0000000000a1'] }]
    expect(() => actor.replaceState(bad)).toThrow()
    expect(actor.snapshot()).toEqual(before)               // history + state unchanged
  })
  it('does not touch modified_at (loading a project is not a dirty edit)', () => {
    const gen = seededGen()
    const actor = createActor({ initial: blankProject(gen, 'orig'), idGen: gen, clock: () => '<TS>' })
    const next = blankProject(gen, 'on-disk')
    next.metadata.modified_at = '2026-01-02T03:04:05Z'
    actor.replaceState(next)
    expect(actor.snapshot().metadata.modified_at).toBe('2026-01-02T03:04:05Z')
  })
})

describe('media-pool mutations dispatch (Phase 3c-i)', () => {
  const MID = '00000000-0000-0000-0000-0000000000aa'
  function actorWithMedia() {
    const gen = seededGen()
    const a = createActor({ initial: blankProject(gen, 'm'), idGen: gen, clock: () => '<TS>' })
    a.dispatch('add_media', { id: MID, kind: 'Video', duration_us: 4_000_000 })
    return a
  }

  it('set_media_derivatives: MediaNotFound on bad id', () => {
    const r = actorWithMedia().dispatch('set_media_derivatives', { media: '00000000-0000-0000-0000-0000000000ff', patch: { set_route: { route: 'bypass' } } })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.error).toBe('MediaNotFound')
  })
  it('set_media_derivatives: success folds the route on the pool item', () => {
    const a = actorWithMedia()
    // set_route promotes the bypass default to Proxied, then a full master folds in.
    expect(a.dispatch('set_media_derivatives', { media: MID, patch: { set_route: { route: 'proxied', quick_proxy: null, full_proxy: null, format_version: 0 } } }).ok).toBe(true)
    expect(a.dispatch('set_media_derivatives', { media: MID, patch: { full_proxy_landed: { path: 'media/p.mp4', format_version: 7 } } }).ok).toBe(true)
    expect(a.snapshot().media_pool[MID].decode_route)
      .toEqual({ route: 'proxied', quick_proxy: null, full_proxy: 'media/p.mp4', format_version: 7 })
  })
  it('set_media_workspace_paths: success sets path_rel + hash', () => {
    const a = actorWithMedia()
    expect(a.dispatch('set_media_workspace_paths', { media: MID, paths: { path_abs: 'ws/c.bin', path_rel: 'media/c.bin', file_hash_blake3: 'abc', file_size: 9, file_mtime: 7 } }).ok).toBe(true)
    expect(a.snapshot().media_pool[MID].path_rel).toBe('media/c.bin')
  })
  it('set_media_hash: replaces the pool item hash (unrecorded); MediaNotFound for absent id', () => {
    const a = actorWithMedia()
    expect(a.dispatch('set_media_hash', { media: MID, file_hash_blake3: 'realhash-abc' }).ok).toBe(true)
    expect(a.snapshot().media_pool[MID].file_hash_blake3).toBe('realhash-abc')
    expect(a.dispatch('set_media_hash', { media: '00000000-0000-0000-0000-0000000000ff', file_hash_blake3: 'x' }).ok).toBe(false)
  })
  it('remove_media: MediaInUse when referenced and !force; lists the layer', () => {
    const a = actorWithMedia()
    const lid = (a.dispatch('add_layer', { track: a.snapshot().tracks[0].id, kind: 'video', media: MID, src_in_us: 0, src_out_us: 4_000_000, t_start_us: 0, t_end_us: 4_000_000 }) as { ok: true; value: unknown }).value as string
    const r = a.dispatch('remove_media', { media: MID, force: false })
    expect(!r.ok && r.error.error).toBe('MediaInUse')
    expect(!r.ok && r.error.error === 'MediaInUse' && r.error.referenced_by).toEqual([lid])
  })
  it('remove_media unused: removes from pool, durable across undo', () => {
    const a = actorWithMedia()
    expect(a.dispatch('remove_media', { media: MID, force: false }).ok).toBe(true)
    expect(a.snapshot().media_pool[MID]).toBeUndefined()
    a.dispatch('add_track', {})           // a recorded op to have something to undo
    a.dispatch('undo', {})
    expect(a.snapshot().media_pool[MID], 'unrecorded remove is durable across undo').toBeUndefined()
  })
  it('remove_media force: cascade-deletes referencing layers, recorded (undoable)', () => {
    const a = actorWithMedia()
    const tA = a.snapshot().tracks[0].id
    a.dispatch('add_layer', { track: tA, kind: 'video', media: MID, src_in_us: 0, src_out_us: 4_000_000, t_start_us: 0, t_end_us: 4_000_000 })
    expect(a.dispatch('remove_media', { media: MID, force: true }).ok).toBe(true)
    expect(a.snapshot().tracks[0].layers.length).toBe(0)
    expect(a.snapshot().media_pool[MID]).toBeUndefined()
    a.dispatch('undo', {})
    expect(a.snapshot().tracks[0].layers.length, 'force cascade is undoable').toBe(1)
    expect(a.snapshot().media_pool[MID], 'undo restores media').toBeDefined()
  })
})

describe('dispatch: attribute-panel timing/envelope ops', () => {
  // The Attribute panel routes Start edits to move_layer, End/duration edits
  // to trim_layer, and label/enabled/locked edits to update_layer. Each edit
  // must record exactly ONE history entry; snapping and group fan-out happen
  // inside the command, not in the panel.
  function setup() {
    const idGen = seededGen()
    const initial = blankProject(idGen, 'attr')
    const a = initial.tracks[0].id
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const mk = (t0: number, t1: number) =>
      (actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: t0, t_end_us: t1 }) as { ok: true; value: string }).value
    return { actor, a, mk }
  }

  it('move_layer snaps an off-grid Start to the comp frame grid, one undo entry', () => {
    const { actor, a, mk } = setup()
    const l = mk(0, 1_000_000)
    const before = actor.historyStatus().len
    // 500_001 µs sits between frames 15 and 16 at 30 fps; the command snaps.
    const r = actor.dispatch('move_layer', { layer: l, to_track: a, t_start_us: 500_001, escape_group: false })
    expect(r.ok).toBe(true)
    expect(actor.snapshot().tracks[0].layers[0].t_start_us).toBe(500_000)
    expect(actor.snapshot().tracks[0].layers[0].t_end_us).toBe(1_500_000) // duration preserved
    expect(actor.historyStatus().len).toBe(before + 1)
  })

  it('trim_layer Out fans out to an aligned group sibling within the same single undo entry', () => {
    const { actor, mk } = setup()
    const b = actor.snapshot().tracks[1].id
    // Siblings on different tracks sharing the SAME out-edge: the coupled
    // trim fans out (mirrors mutations/trim.test.ts's aligned-set cases).
    const l1 = mk(0, 1_000_000)
    const l2 = (actor.dispatch('add_layer', { track: b, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }) as { ok: true; value: string }).value
    actor.dispatch('groups_create', { layers: [l1, l2], reassign: false })
    const beforeTrim = actor.historyStatus().len
    const r = actor.dispatch('trim_layer', { layer: l1, edge: 'out', new_t_us: 2_000_000, escape_group: false })
    expect(r.ok).toBe(true)
    const tracks = actor.snapshot().tracks
    expect(tracks[0].layers.find((x) => x.id === l1)?.t_end_us).toBe(2_000_000)
    expect(tracks[1].layers.find((x) => x.id === l2)?.t_end_us).toBe(2_000_000)
    expect(actor.historyStatus().len).toBe(beforeTrim + 1)
  })

  it('update_layer (label/enabled/locked) records one undo entry per edit', () => {
    const { actor, mk } = setup()
    const l = mk(0, 1_000_000)
    const before = actor.historyStatus().len
    expect(actor.dispatch('update_layer', { layer: l, patch: { label: 'Card' } }).ok).toBe(true)
    expect(actor.dispatch('update_layer', { layer: l, patch: { enabled: false } }).ok).toBe(true)
    expect(actor.dispatch('update_layer', { layer: l, patch: { locked: true } }).ok).toBe(true)
    const layer = actor.snapshot().tracks[0].layers[0]
    expect(layer.label).toBe('Card')
    expect(layer.enabled).toBe(false)
    expect(layer.locked).toBe(true)
    expect(actor.historyStatus().len).toBe(before + 3)
  })
})

// A track disappears when its last layer leaves it (ADR 0042). Everything here is
// read off the snapshot rather than the prune helper, because a prune that never
// fires passes every helper-level test — which is exactly how the move path spent
// its whole life as a no-op.
describe('dispatch: emptied-track cleanup', () => {
  function setup() {
    const idGen = seededGen(); const initial = blankProject(idGen, 'prune')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    return { actor, aRoll: initial.tracks[0].id, bRoll: initial.tracks[1].id }
  }
  type Actor = ReturnType<typeof createActor>
  function value(r: DispatchResult): string {
    if (!r.ok) throw new Error(`dispatch refused: ${JSON.stringify(r.error)}`)
    return r.value as string
  }
  const lanes = (actor: Actor): string[] => actor.snapshot().tracks.map((t) => t.id)
  const addLane = (actor: Actor): string => value(actor.dispatch('add_track', { label: null }))
  const addClip = (actor: Actor, track: string, t0 = 0, t1 = 1_000_000): string =>
    value(actor.dispatch('add_layer', { track, kind: 'color', t_start_us: t0, t_end_us: t1 }))
  const clipsOn = (actor: Actor, track: string) => actor.snapshot().tracks.find((t) => t.id === track)?.layers ?? []

  it('deleting the last layer removes the lane in the same history entry', () => {
    const { actor } = setup()
    const lane = addLane(actor)
    const clip = addClip(actor, lane)
    const before = actor.historyStatus().len
    expect(actor.dispatch('delete_layer', { layer: clip }).ok).toBe(true)
    expect(lanes(actor)).not.toContain(lane)
    expect(actor.historyStatus().len).toBe(before + 1)
  })

  it('moving the last layer off a lane removes it and leaves the destination standing', () => {
    const { actor, aRoll } = setup()
    const lane = addLane(actor)
    const clip = addClip(actor, lane)
    const before = actor.historyStatus().len
    expect(actor.dispatch('move_layer', { layer: clip, to_track: aRoll, t_start_us: 2_000_000 }).ok).toBe(true)
    expect(lanes(actor)).not.toContain(lane)
    expect(clipsOn(actor, aRoll).map((l) => l.id)).toEqual([clip])
    expect(actor.historyStatus().len).toBe(before + 1) // cleanup rode along, not a second entry
  })

  it('one undo after a move restores the layer to its previous lane and position', () => {
    const { actor, aRoll } = setup()
    const lane = addLane(actor)
    const clip = addClip(actor, lane, 1_000_000, 2_000_000)
    expect(actor.dispatch('move_layer', { layer: clip, to_track: aRoll, t_start_us: 5_000_000 }).ok).toBe(true)
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(lanes(actor)).toContain(lane)
    expect(clipsOn(actor, lane).map((l) => [l.id, l.t_start_us])).toEqual([[clip, 1_000_000]])
    expect(clipsOn(actor, aRoll)).toHaveLength(0)
  })

  it('a move within one lane leaves it standing — it never stopped holding the layer', () => {
    const { actor } = setup()
    const lane = addLane(actor)
    const clip = addClip(actor, lane)
    expect(actor.dispatch('move_layer', { layer: clip, to_track: lane, t_start_us: 3_000_000 }).ok).toBe(true)
    expect(lanes(actor)).toContain(lane)
    expect(clipsOn(actor, lane).map((l) => l.t_start_us)).toEqual([3_000_000])
  })

  it('a lane born empty survives deletions and moves elsewhere in the project', () => {
    const { actor, aRoll, bRoll } = setup()
    const untouched = addLane(actor) // created, never filled
    const doomed = addClip(actor, aRoll)
    const travelling = addClip(actor, bRoll)
    expect(actor.dispatch('delete_layer', { layer: doomed }).ok).toBe(true)
    expect(actor.dispatch('move_layer', { layer: travelling, to_track: aRoll, t_start_us: 0 }).ok).toBe(true)
    expect(lanes(actor)).toContain(untouched)
  })

  it('a locked lane survives — the edit that would empty it is refused first', () => {
    const { actor, aRoll } = setup()
    const lane = addLane(actor)
    const clip = addClip(actor, lane)
    expect(actor.dispatch('update_track_flags', { track: lane, patch: { locked: true } }).ok).toBe(true)
    for (const r of [actor.dispatch('delete_layer', { layer: clip }),
      actor.dispatch('move_layer', { layer: clip, to_track: aRoll, t_start_us: 0 })]) {
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.error).toBe('TrackLocked')
    }
    expect(lanes(actor)).toContain(lane)
    expect(clipsOn(actor, lane)).toHaveLength(1)
  })

  it('reserved A/B-roll lanes survive emptying by either path', () => {
    const { actor, aRoll, bRoll } = setup()
    const onA = addClip(actor, aRoll)
    const onB = addClip(actor, bRoll)
    expect(actor.dispatch('delete_layer', { layer: onA }).ok).toBe(true)
    expect(actor.dispatch('move_layer', { layer: onB, to_track: aRoll, t_start_us: 0 }).ok).toBe(true)
    expect(lanes(actor)).toEqual([aRoll, bRoll])
  })

  it('a coupled move prunes only the lane the target left; the sibling keeps its own', () => {
    const { actor, aRoll } = setup()
    const targetLane = addLane(actor)
    const siblingLane = addLane(actor)
    const target = addClip(actor, targetLane)
    const sibling = addClip(actor, siblingLane)
    expect(actor.dispatch('groups_create', { layers: [target, sibling], label: null, reassign: false }).ok).toBe(true)
    expect(actor.dispatch('move_layer', { layer: target, to_track: aRoll, t_start_us: 2_000_000 }).ok).toBe(true)
    expect(lanes(actor)).not.toContain(targetLane)
    // The sibling is spliced out of its lane and re-inserted on the SAME lane, so
    // a coupled move can only ever empty the target's.
    expect(clipsOn(actor, siblingLane).map((l) => [l.id, l.t_start_us])).toEqual([[sibling, 2_000_000]])
  })

  it('the lane separate_audio lifts an audio layer onto is a cleanup candidate too', () => {
    const { actor, aRoll } = setup()
    const media = '11111111-1111-1111-1111-111111111111'
    expect(actor.dispatch('add_media', { id: media, kind: 'Audio', duration_us: 1_000_000 }).ok).toBe(true)
    const audio = value(actor.dispatch('add_layer', { track: aRoll, kind: 'audio', media, src_in_us: 0, src_out_us: 1_000_000, t_start_us: 0, t_end_us: 1_000_000 }))
    const lifted = value(actor.dispatch('separate_audio', { layer: audio }))
    expect(lanes(actor)).toContain(lifted)
    expect(actor.dispatch('delete_layer', { layer: audio }).ok).toBe(true)
    expect(lanes(actor)).not.toContain(lifted)
  })
})
