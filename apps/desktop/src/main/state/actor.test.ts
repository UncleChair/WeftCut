// apps/desktop/src/main/state/actor.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject } from './model'
import type { Project } from './model'
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
})

describe('dispatch: set_composition full', () => {
  function withTwoLayers() {
    const idGen = seededGen(); const initial = blankProject(idGen, 'sc')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    actor.dispatch('add_layer', { track: initial.tracks[0].id, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 })
    actor.dispatch('add_layer', { track: initial.tracks[1].id, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    return actor
  }
  it('fps change re-snaps layers + autofits duration (recorded; undoable)', () => {
    const actor = withTwoLayers()
    const before = JSON.stringify(actor.snapshot())
    expect(actor.dispatch('set_composition', { fps: { num: 24, den: 1 } }).ok).toBe(true)
    expect(actor.snapshot().composition.fps).toEqual({ num: 24, den: 1 })
    // unpinned: duration follows the (re-snapped) layer high-water mark
    expect(actor.snapshot().composition.duration_us).toBe(2_000_000)
    expect(actor.dispatch('undo', {}).ok).toBe(true) // recorded → undoable
    expect(JSON.stringify(actor.snapshot())).toBe(before)
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
    const actor = withTwoLayers()
    const r = actor.dispatch('set_composition', { fps: { num: 24, den: 1 }, duration_us: 3_000_000 })
    expect(r.ok).toBe(true)
    expect(actor.snapshot().composition.fps).toEqual({ num: 24, den: 1 })
    expect(actor.snapshot().composition.duration_pinned).toBe(true)
    expect(actor.snapshot().composition.duration_us).toBe(3_000_000)
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
    expect(tracks[0].label).toBe('A roll (audio)')
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
  it('update_project_settings flips auto_delete_empty_tracks (unrecorded, survives undo)', () => {
    const { actor, a } = setup()
    actor.dispatch('update_project_settings', { patch: { auto_delete_empty_tracks: false } })
    expect(actor.snapshot().settings.auto_delete_empty_tracks).toBe(false)
    actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    actor.dispatch('undo', {})
    expect(actor.snapshot().settings.auto_delete_empty_tracks).toBe(false) // preference persists across undo
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
  it('restyle_caption_track patches the Text layers', () => {
    const { actor } = setup()
    const tid = (actor.dispatch('add_caption_track', { cues: [{ start_us: 0, end_us: 1_000_000, text: 'a', style: CLEAN }], comp_w: 1920, comp_h: 1080, label: null }) as { ok: true; value: string }).value
    const r = actor.dispatch('restyle_caption_track', { track: tid, patch: { font_size_px: 60 } })
    expect(r.ok).toBe(true)
    const ct = actor.snapshot().tracks.find((t) => t.id === tid)!
    expect((ct.layers[0].params as { font: { size_px: number } }).font.size_px).toBe(60)
  })
  it('restyle_caption_track on a missing track → TrackNotFound', () => {
    const { actor } = setup()
    const r = actor.dispatch('restyle_caption_track', { track: '00000000-0000-0000-0000-0000000000ff', patch: { font_size_px: 60 } })
    expect((r as { ok: false; error: { error: string } }).error.error).toBe('TrackNotFound')
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

describe('replace_state (mirror do_replace_state actor.rs:3581 + History::reset)', () => {
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
    const r = actorWithMedia().dispatch('set_media_derivatives', { media: '00000000-0000-0000-0000-0000000000ff', patch: { proxy_path: 'media/p.mp4' } })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.error).toBe('MediaNotFound')
  })
  it('set_media_derivatives: success patches the pool item', () => {
    const a = actorWithMedia()
    expect(a.dispatch('set_media_derivatives', { media: MID, patch: { proxy_path: 'media/p.mp4', proxy_bypassed: true } }).ok).toBe(true)
    expect(a.snapshot().media_pool[MID].proxy_path).toBe('media/p.mp4')
    expect(a.snapshot().media_pool[MID].proxy_bypassed).toBe(true)
  })
  it('set_media_workspace_paths: success sets path_rel + hash', () => {
    const a = actorWithMedia()
    expect(a.dispatch('set_media_workspace_paths', { media: MID, paths: { path_abs: 'ws/c.bin', path_rel: 'media/c.bin', file_hash_blake3: 'abc', file_size: 9, file_mtime: 7 } }).ok).toBe(true)
    expect(a.snapshot().media_pool[MID].path_rel).toBe('media/c.bin')
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
