// apps/desktop/src/main/state/reconcile.test.ts
//
// Reconcile-on-commit (Policy B): ordinary edits stay transition-blind; the
// commit pipeline drops any transition whose invariant the edit broke, inside
// the SAME recorded commit, with one status-log row per drop and NO shrink-back
// of the outgoing layer. Exercised through the real actor dispatch path so the
// full apply → reconcile → validate → record → log order is under test.
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject } from './model'
import type { Layer, Project } from './model'
import { createActor, type ActorLogEntry } from './actor'
import { reconcileTransitions } from './validate'
import { applyAddLayer, colorParams } from './mutations/add'
import { applyAddTransition } from './mutations/transitions'

const RED = { r: 255, g: 0, b: 0, a: 255 }
const color = () => colorParams(RED, 1920, 1080)

function val(r: { ok: true; value: unknown } | { ok: false; error: unknown }): string {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`)
  return r.value as string
}
function layerOf(p: Project, id: string): Layer {
  for (const t of p.tracks) { const l = t.layers.find((x) => x.id === id); if (l) return l }
  throw new Error(`layer ${id} not found`)
}

/** Actor with a captured log seam and A1=[0,2M] → A2=[2M,4M] + a 1M crossfade
 *  on @A (start-at-cut: A1 auto-extends to 3M; overlap [2M,3M] === duration). */
function withTransition() {
  const idGen = seededGen()
  const initial = blankProject(idGen, 'rt')
  const logged: ActorLogEntry[] = []
  const actor = createActor({ initial, idGen, clock: () => '<TS>', emitLog: (e) => logged.push(e) })
  const aRoll = initial.tracks[0].id
  const bRoll = initial.tracks[1].id
  const a1 = val(actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 }))
  const a2 = val(actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 2_000_000, t_end_us: 4_000_000 }))
  const tid = val(actor.dispatch('add_transition', { from: a1, to: a2, duration_us: 1_000_000 }))
  return { actor, logged, aRoll, bRoll, a1, a2, tid }
}

describe('reconcile-on-commit: exemption for the transition commands themselves', () => {
  it('add_transition is not eaten by its own commit (invariant holds by construction); no log row', () => {
    const { actor, logged, a1, a2, tid } = withTransition()
    expect(actor.snapshot().transitions.map((t) => t.id)).toEqual([tid])
    expect(layerOf(actor.snapshot(), a1).t_end_us).toBe(3_000_000)
    expect(layerOf(actor.snapshot(), a2).t_start_us).toBe(2_000_000)
    expect(logged).toEqual([])
  })
})

describe('reconcile-on-commit: drops', () => {
  it('participant delete drops the transition in the same commit; NO shrink-back of the outgoing layer', () => {
    const { actor, logged, a1, a2 } = withTransition()
    expect(actor.dispatch('delete_layer', { layer: a2 }).ok).toBe(true)
    expect(actor.snapshot().transitions).toEqual([])
    // The outgoing layer keeps its extended tail — reconcile removal never
    // shrinks back (only explicit remove_transition does).
    expect(layerOf(actor.snapshot(), a1).t_end_us).toBe(3_000_000)
    expect(logged).toHaveLength(1)
  })

  it('trim of from.t_end drops it; geometry is exactly what the edit made it', () => {
    const { actor, logged, a1, tid } = withTransition()
    expect(actor.dispatch('trim_layer', { layer: a1, edge: 'out', new_t_us: 2_000_000 }).ok).toBe(true)
    expect(actor.snapshot().transitions).toEqual([])
    expect(layerOf(actor.snapshot(), a1).t_end_us).toBe(2_000_000) // trim result, no extra shrink
    expect(logged).toHaveLength(1)
    expect(logged[0].message).toContain('Transition removed: edit broke its overlap')
    expect(logged[0].message).toContain(tid)
    expect(logged[0].details).toMatchObject({ kind: 'TransitionReconcileDrop', transition: tid })
  })

  it('trim of to.t_start (past the overlap) drops it; from-layer untouched', () => {
    const { actor, logged, a1, a2 } = withTransition()
    expect(actor.dispatch('trim_layer', { layer: a2, edge: 'in', new_t_us: 3_000_000 }).ok).toBe(true)
    expect(actor.snapshot().transitions).toEqual([])
    expect(layerOf(actor.snapshot(), a2).t_start_us).toBe(3_000_000)
    expect(layerOf(actor.snapshot(), a1).t_end_us).toBe(3_000_000) // no shrink-back
    expect(logged).toHaveLength(1)
  })

  it('move-apart of the to layer drops it (DurationMismatch reason)', () => {
    const { actor, logged, aRoll, a2 } = withTransition()
    expect(actor.dispatch('move_layer', { layer: a2, to_track: aRoll, t_start_us: 6_000_000 }).ok).toBe(true)
    expect(actor.snapshot().transitions).toEqual([])
    expect(layerOf(actor.snapshot(), a2).t_start_us).toBe(6_000_000)
    expect(logged).toHaveLength(1)
    expect((logged[0].details as { reason: { rule: string } }).reason.rule).toBe('TransitionDurationMismatch')
  })

  it('move of the from layer to another track drops it (CrossTrack reason)', () => {
    const { actor, logged, bRoll, a1 } = withTransition()
    expect(actor.dispatch('move_layer', { layer: a1, to_track: bRoll, t_start_us: 0 }).ok).toBe(true)
    expect(actor.snapshot().transitions).toEqual([])
    expect(logged).toHaveLength(1)
    expect((logged[0].details as { reason: { rule: string } }).reason.rule).toBe('TransitionCrossTrack')
  })

  it('one commit dropping TWO transitions emits one log row per drop', () => {
    const idGen = seededGen()
    const initial = blankProject(idGen, 'rt2')
    const logged: ActorLogEntry[] = []
    const actor = createActor({ initial, idGen, clock: () => '<TS>', emitLog: (e) => logged.push(e) })
    const aRoll = initial.tracks[0].id
    const l1 = val(actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 }))
    const l2 = val(actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 2_000_000, t_end_us: 4_000_000 }))
    const l3 = val(actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 4_000_000, t_end_us: 6_000_000 }))
    const t1 = val(actor.dispatch('add_transition', { from: l1, to: l2, duration_us: 1_000_000 })) // l1 → 3M
    const t2 = val(actor.dispatch('add_transition', { from: l2, to: l3, duration_us: 1_000_000 })) // l2 → 5M
    expect(actor.snapshot().transitions).toHaveLength(2)
    expect(actor.dispatch('delete_layer', { layer: l2 }).ok).toBe(true) // shared participant
    expect(actor.snapshot().transitions).toEqual([])
    expect(logged).toHaveLength(2)
    expect(logged.map((e) => (e.details as { transition: string }).transition).sort()).toEqual([t1, t2].sort())
    for (const e of logged) {
      expect(e.level).toBe('info')
      expect(e.category).toEqual({ kind: 'Project' })
      expect((e.details as { reason: { rule: string } }).reason.rule).toBe('TransitionLayerMissing')
    }
  })
})

describe('reconcile-on-commit: splits', () => {
  it('split of the to participant beyond the overlap: the transition SURVIVES on the left half', () => {
    const { actor, logged, a2, tid } = withTransition()
    const r = actor.dispatch('split_layer', { layer: a2, at_t_us: 3_500_000, escape_group: false })
    expect(r.ok).toBe(true)
    expect(actor.snapshot().transitions.map((t) => t.id)).toEqual([tid])
    expect(layerOf(actor.snapshot(), a2).t_end_us).toBe(3_500_000) // left half keeps the id
    expect(logged).toEqual([])
  })

  it('split of the from participant is rejected atomically: the dropped transition no longer authorizes the residual overlap', () => {
    // Split preserves covered intervals: the right half [1M,3M] still physically
    // overlaps the incoming layer's head by exactly the transition duration, but
    // the transition rides the LEFT half's id, so reconcile drops it and validate
    // then rejects the now-unauthorized overlap → the whole commit rolls back.
    // Honest Policy-B outcome: a from-side split can never be mopped up by a
    // remove-only reconcile (only geometry edits could legalize it).
    const { actor, logged, a1, tid } = withTransition()
    const before = actor.snapshot()
    const r = actor.dispatch('split_layer', { layer: a1, at_t_us: 1_000_000, escape_group: false })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.error).toBe('ValidationFailed')
      expect((r.error as { error: 'ValidationFailed'; detail: { rule: string } }).detail.rule).toBe('LayerOverlap')
    }
    expect(actor.snapshot()).toBe(before) // state untouched — drop never landed
    expect(actor.snapshot().transitions.map((t) => t.id)).toEqual([tid])
    expect(logged).toEqual([]) // rejected commit logs nothing
  })

  it('split of the to participant inside the overlap is likewise rejected atomically', () => {
    const { actor, a2, tid } = withTransition()
    const r = actor.dispatch('split_layer', { layer: a2, at_t_us: 2_500_000, escape_group: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.error).toBe('ValidationFailed')
    expect(actor.snapshot().transitions.map((t) => t.id)).toEqual([tid])
  })
})

describe('reconcile-on-commit: survival + atomic undo', () => {
  it('transition SURVIVES a group move of both participants (overlap preserved)', () => {
    const { actor, logged, aRoll, a1, a2, tid } = withTransition()
    expect(actor.dispatch('groups_create', { layers: [a1, a2], label: null, reassign: false }).ok).toBe(true)
    expect(actor.dispatch('move_layer', { layer: a1, to_track: aRoll, t_start_us: 5_000_000, escape_group: false }).ok).toBe(true)
    expect(layerOf(actor.snapshot(), a1).t_start_us).toBe(5_000_000)
    expect(layerOf(actor.snapshot(), a1).t_end_us).toBe(8_000_000)
    expect(layerOf(actor.snapshot(), a2).t_start_us).toBe(7_000_000) // sibling shifted by the same delta
    expect(actor.snapshot().transitions.map((t) => t.id)).toEqual([tid]) // overlap still 1M
    expect(logged).toEqual([])
  })

  it('ONE undo restores both the edit and the transition (drop rides the same snapshot)', () => {
    const { actor, a1, tid } = withTransition()
    expect(actor.dispatch('trim_layer', { layer: a1, edge: 'out', new_t_us: 2_000_000 }).ok).toBe(true)
    expect(actor.snapshot().transitions).toEqual([])
    expect(actor.dispatch('undo', {}).ok).toBe(true) // single step
    expect(actor.snapshot().transitions.map((t) => t.id)).toEqual([tid])
    expect(layerOf(actor.snapshot(), a1).t_end_us).toBe(3_000_000)
    // and redo re-applies edit + drop together
    expect(actor.dispatch('redo', {}).ok).toBe(true)
    expect(actor.snapshot().transitions).toEqual([])
    expect(layerOf(actor.snapshot(), a1).t_end_us).toBe(2_000_000)
  })

  it('an actor without a log seam still reconciles (emitLog optional)', () => {
    const idGen = seededGen()
    const initial = blankProject(idGen, 'rt3')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const aRoll = initial.tracks[0].id
    const a1 = val(actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 }))
    const a2 = val(actor.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 2_000_000, t_end_us: 4_000_000 }))
    val(actor.dispatch('add_transition', { from: a1, to: a2, duration_us: 1_000_000 }))
    expect(actor.dispatch('delete_layer', { layer: a2 }).ok).toBe(true)
    expect(actor.snapshot().transitions).toEqual([])
  })
})

describe('reconcileTransitions (direct, plain object)', () => {
  it('removes in place, returns {id, from, to, reason} per drop, keeps healthy transitions', () => {
    const gen = seededGen()
    const p = blankProject(gen, 't')
    const track = p.tracks[0].id
    const l1 = applyAddLayer(p, gen, track, color(), 0, 2_000_000)
    const l2 = applyAddLayer(p, gen, track, color(), 2_000_000, 4_000_000)
    const l3 = applyAddLayer(p, gen, track, color(), 4_000_000, 6_000_000)
    const t1 = applyAddTransition(p, gen, l1, l2, 1_000_000, { kind: 'Crossfade' }) // l1 → 3M
    const t2 = applyAddTransition(p, gen, l2, l3, 1_000_000, { kind: 'Crossfade' }) // l2 → 5M
    expect(reconcileTransitions(p)).toEqual([]) // both healthy → no-op
    // Break t1 only: hand-shrink l1's tail (edit-shaped geometry change).
    const l1Obj = p.tracks[0].layers.find((l) => l.id === l1)!
    l1Obj.t_end_us = 2_000_000
    const drops = reconcileTransitions(p)
    expect(drops).toEqual([{
      id: t1, from_layer: l1, to_layer: l2,
      reason: { rule: 'TransitionDurationMismatch', transition: t1, duration: 1_000_000, overlap: 0 },
    }])
    expect(p.transitions.map((t) => t.id)).toEqual([t2]) // t2 untouched
    expect(l1Obj.t_end_us).toBe(2_000_000) // no shrink-back
  })
})
