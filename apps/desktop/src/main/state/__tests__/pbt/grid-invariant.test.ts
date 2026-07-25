// The frame-grid invariant as a property of the ACTOR, not of any one mutator:
// after every successful command, no layer endpoint, composition duration or
// marker time sits off the composition grid, and every surviving transition's
// duration still equals its geometric overlap — at every rate in the spec's rate
// matrix, including the three fractional ones where `canonical(a) + canonical(b)
// != canonical(a + b)`.
//
// Two halves, and the second is the load-bearing one:
//   1. the state check (would catch a mutator that persisted an off-grid value);
//   2. no command may come back with an OFF-GRID validation failure. Once
//      validate carries the backstop, a mutator that forgets to snap turns into a
//      rejected edit rather than a corrupt snapshot, so a state-only property
//      would pass vacuously. Half 2 is what fails when a snap goes missing.
//
// Deliberately NOT checked: keyframe times (rebased by a delta — see
// validate.ts's validateLayerParams note) and `src_in_us`/`src_out_us` (source
// media time, never snapped).
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { seededGen } from '../../ids'
import { blankProject } from '../../model'
import { createActor } from '../../actor'
import { serializeProject } from '../../serialize'
import { frameIndexRound, timeUsAtFrame } from '../../snap'
import { PBT_SEED, PBT_RUNS } from './harness'

// spec § Gates and test assets — the rate matrix every ticket in this round runs.
const RATES: ReadonlyArray<[number, number]> = [
  [24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [50, 1], [60000, 1001], [60, 1],
]

const VIDEO_MEDIA = 'grid-media-video'
const AUDIO_MEDIA = 'grid-media-audio'
const VIDEO_MEDIA_DUR = 4_000_000
const AUDIO_MEDIA_DUR = 8_000_000

type ActorT = ReturnType<typeof createActor>
interface WireLayer { id: string; t_start_us: number; t_end_us: number; params: { kind: string } }
interface WireProject {
  composition: { duration_us: number; fps: { num: number; den: number } }
  tracks: Array<{ id: string; layers: WireLayer[] }>
  markers: Array<{ id: string; t_us: number; end_t_us: number | null }>
  transitions: Array<{ id: string; from_layer: string; to_layer: string; duration_us: number }>
}

function actorAt(num: number, den: number): ActorT {
  const idGen = seededGen()
  const initial = blankProject(idGen, 'grid')
  initial.composition.fps = { num, den }
  const actor = createActor({ initial, idGen, clock: () => '<TS>' })
  actor.dispatch('add_media', { id: VIDEO_MEDIA, kind: 'Video', duration_us: VIDEO_MEDIA_DUR, with_audio: false })
  actor.dispatch('add_media', { id: AUDIO_MEDIA, kind: 'Audio', duration_us: AUDIO_MEDIA_DUR, with_audio: true })
  return actor
}
const wire = (a: ActorT) => serializeProject(a.snapshot()) as unknown as WireProject

/** Two visual cuts on A-roll (real tail handles) plus two free-duration cuts and
 *  an audio pair, so transition/group/trim ops have plausible targets from op #1.
 *  Requested times are deliberately raw µs — off grid at the fractional rates —
 *  so the seeding itself exercises the mutators' snap. */
function seedTimeline(a: ActorT): ActorT {
  const [aRoll, bRoll] = a.snapshot().tracks.map((t) => t.id)
  a.dispatch('add_layer', { track: aRoll, kind: 'video', media: VIDEO_MEDIA, src_in_us: 0, src_out_us: 500_001, t_start_us: 0, t_end_us: 500_001 })
  a.dispatch('add_layer', { track: aRoll, kind: 'video', media: VIDEO_MEDIA, src_in_us: 0, src_out_us: 499_999, t_start_us: 500_001, t_end_us: 1_000_000 })
  a.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 1_100_003, t_end_us: 1_700_003 })
  a.dispatch('add_layer', { track: aRoll, kind: 'color', t_start_us: 1_800_007, t_end_us: 2_400_007 })
  a.dispatch('add_layer', { track: bRoll, kind: 'audio', media: AUDIO_MEDIA, src_in_us: 0, src_out_us: 600_001, t_start_us: 0, t_end_us: 600_001 })
  a.dispatch('add_layer', { track: bRoll, kind: 'audio', media: AUDIO_MEDIA, src_in_us: 0, src_out_us: 599_999, t_start_us: 700_001, t_end_us: 1_300_000 })
  return a
}

// ── Half 1: the state check ───────────────────────────────────────────────────
// Canonical is re-derived from the two leaf policies (index → time) rather than
// through `snapFrameRound`, so this is not a restatement of validate's predicate.
function isCanonical(tUs: number, num: number, den: number): boolean {
  return timeUsAtFrame(frameIndexRound(tUs, num, den), num, den) === tUs
}

function offGridFields(p: WireProject): string[] {
  const { num, den } = p.composition.fps
  const bad: string[] = []
  const check = (what: string, t: number) => { if (!isCanonical(t, num, den)) bad.push(`${what}=${t}`) }
  check('composition.duration_us', p.composition.duration_us)
  const geometry = new Map<string, WireLayer>()
  for (const t of p.tracks) for (const l of t.layers) {
    geometry.set(l.id, l)
    check(`layer ${l.id} (${l.params.kind}).t_start_us`, l.t_start_us)
    check(`layer ${l.id} (${l.params.kind}).t_end_us`, l.t_end_us)
  }
  for (const m of p.markers) {
    check(`marker ${m.id}.t_us`, m.t_us)
    if (m.end_t_us !== null) check(`marker ${m.id}.end_t_us`, m.end_t_us)
  }
  // A duration is a DISTANCE between two canonical boundaries, so it is checked as
  // the overlap relation, never as a canonical time of its own.
  for (const tr of p.transitions) {
    const from = geometry.get(tr.from_layer), to = geometry.get(tr.to_layer)
    if (!from || !to) continue
    const overlap = Math.min(from.t_end_us, to.t_end_us) - Math.max(from.t_start_us, to.t_start_us)
    if (overlap !== tr.duration_us) bad.push(`transition ${tr.id} duration=${tr.duration_us} but overlap=${overlap}`)
  }
  return bad
}

// ── Half 2: no command may fail on the backstop ───────────────────────────────
type Res = ReturnType<ActorT['dispatch']> | null
function offGridRejection(res: Res): string | null {
  if (res === null || res.ok) return null
  const e = res.error
  if (e.error !== 'ValidationFailed') return null
  const rule = e.detail.rule
  return rule === 'OffGridLayerBoundary' || rule === 'OffGridTime' ? JSON.stringify(e.detail) : null
}

// ── Op matrix ─────────────────────────────────────────────────────────────────
// Targets resolve against the CURRENT snapshot at apply time, so every op is
// valid-or-cleanly-rejected. Times are raw µs on purpose.
type Op =
  | { t: 'add'; kind: 'color' | 'video' | 'audio'; track: number; start: number; len: number }
  | { t: 'move'; n: number; track: number; start: number }
  | { t: 'trim'; n: number; edge: 'in' | 'out'; to: number }
  | { t: 'split'; n: number; at: number }
  | { t: 'splitMulti'; n: number; ats: number[] }
  | { t: 'duplicate'; n: number; off: number }
  | { t: 'paste'; n: number; start: number }
  | { t: 'group'; n: number; m: number }
  | { t: 'addTransition'; n: number; dur: number }
  | { t: 'updateTransition'; n: number; dur: number }
  | { t: 'removeTransition'; n: number }
  | { t: 'addMarker'; at: number; span: number | null }
  | { t: 'updateMarker'; n: number; at: number }
  | { t: 'setDuration'; d: number }
  | { t: 'undo' } | { t: 'redo' }

const rawUs = (max: number) => fc.integer({ min: 0, max })
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: fc.record({ t: fc.constant('add' as const),
    kind: fc.constantFrom('color' as const, 'video' as const, 'audio' as const),
    track: fc.nat({ max: 4 }), start: rawUs(3_000_000), len: fc.integer({ min: 1, max: 900_000 }) }), weight: 3 },
  { arbitrary: fc.record({ t: fc.constant('move' as const), n: fc.nat({ max: 20 }), track: fc.nat({ max: 4 }), start: rawUs(3_000_000) }), weight: 2 },
  { arbitrary: fc.record({ t: fc.constant('trim' as const), n: fc.nat({ max: 20 }), edge: fc.constantFrom('in' as const, 'out' as const), to: rawUs(3_000_000) }), weight: 3 },
  { arbitrary: fc.record({ t: fc.constant('split' as const), n: fc.nat({ max: 20 }), at: rawUs(3_000_000) }), weight: 2 },
  fc.record({ t: fc.constant('splitMulti' as const), n: fc.nat({ max: 20 }), ats: fc.array(rawUs(3_000_000), { maxLength: 3 }).map((xs) => [...xs].sort((a, b) => a - b)) }),
  fc.record({ t: fc.constant('duplicate' as const), n: fc.nat({ max: 20 }), off: rawUs(4_000_000) }),
  fc.record({ t: fc.constant('paste' as const), n: fc.nat({ max: 20 }), start: rawUs(4_000_000) }),
  fc.record({ t: fc.constant('group' as const), n: fc.nat({ max: 20 }), m: fc.nat({ max: 20 }) }),
  { arbitrary: fc.record({ t: fc.constant('addTransition' as const), n: fc.nat({ max: 20 }), dur: fc.integer({ min: 1, max: 400_000 }) }), weight: 3 },
  { arbitrary: fc.record({ t: fc.constant('updateTransition' as const), n: fc.nat({ max: 6 }), dur: fc.integer({ min: 1, max: 400_000 }) }), weight: 2 },
  fc.record({ t: fc.constant('removeTransition' as const), n: fc.nat({ max: 6 }) }),
  fc.record({ t: fc.constant('addMarker' as const), at: rawUs(3_000_000), span: fc.option(fc.integer({ min: 1, max: 500_000 }), { nil: null }) }),
  fc.record({ t: fc.constant('updateMarker' as const), n: fc.nat({ max: 6 }), at: rawUs(3_000_000) }),
  fc.record({ t: fc.constant('setDuration' as const), d: rawUs(6_000_000) }),
  fc.record({ t: fc.constant('undo' as const) }), fc.record({ t: fc.constant('redo' as const) }),
)

function applyOp(a: ActorT, op: Op): Res {
  const snap = wire(a)
  const trackIds = snap.tracks.map((t) => t.id)
  const layers = snap.tracks.flatMap((t) => t.layers.map((l) => l.id))
  const markers = snap.markers.map((m) => m.id)
  const transitions = snap.transitions.map((tr) => tr.id)
  const pickLayer = (i: number) => layers[i % layers.length]
  const pickTrack = (i: number) => trackIds[i % trackIds.length]
  switch (op.t) {
    case 'add': {
      const args: Record<string, unknown> = { track: pickTrack(op.track), kind: op.kind, t_start_us: op.start, t_end_us: op.start + op.len }
      if (op.kind !== 'color') { args.media = op.kind === 'video' ? VIDEO_MEDIA : AUDIO_MEDIA; args.src_in_us = 0; args.src_out_us = op.len }
      return a.dispatch('add_layer', args)
    }
    case 'move': return layers.length ? a.dispatch('move_layer', { layer: pickLayer(op.n), to_track: pickTrack(op.track), t_start_us: op.start, escape_group: false }) : null
    case 'trim': return layers.length ? a.dispatch('trim_layer', { layer: pickLayer(op.n), edge: op.edge, new_t_us: op.to, escape_group: false }) : null
    case 'split': return layers.length ? a.dispatch('split_layer', { layer: pickLayer(op.n), at_t_us: op.at, escape_group: false }) : null
    case 'splitMulti': return layers.length ? a.dispatch('split_layer_multi', { layer: pickLayer(op.n), at_t_us_list: op.ats }) : null
    case 'duplicate': return layers.length ? a.dispatch('duplicate_layer', { layer: pickLayer(op.n), t_offset_us: op.off }) : null
    // paste is a production `command` channel (camelCase wire args), not dispatch.
    case 'paste': return layers.length ? a.command('paste_layer', { layerId: pickLayer(op.n), tStartUs: op.start }) : null
    case 'group': return layers.length >= 2 ? a.dispatch('groups_create', { layers: [pickLayer(op.n), pickLayer(op.m)], label: null, reassign: false }) : null
    case 'addTransition': {
      if (layers.length < 2) return null
      // Bias to adjacent same-track pairs — the geometry the extend path accepts,
      // and the one whose auto-extension can push t_end_us off the grid.
      const pairs: Array<[string, string]> = []
      for (const t of snap.tracks) for (const x of t.layers) for (const y of t.layers)
        if (x.id !== y.id && x.t_end_us === y.t_start_us) pairs.push([x.id, y.id])
      const [from, to] = pairs.length ? pairs[op.n % pairs.length] : [pickLayer(op.n), pickLayer(op.n + 1)]
      return a.dispatch('add_transition', { from, to, duration_us: op.dur })
    }
    case 'updateTransition': return transitions.length ? a.dispatch('update_transition', { transition: transitions[op.n % transitions.length], duration_us: op.dur }) : null
    case 'removeTransition': return transitions.length ? a.dispatch('remove_transition', { transition: transitions[op.n % transitions.length] }) : null
    case 'addMarker': return a.dispatch('add_marker', { t_us: op.at, end_t_us: op.span === null ? null : op.at + op.span, label: 'm' })
    case 'updateMarker': return markers.length ? a.dispatch('update_marker', { marker: markers[op.n % markers.length], patch: { t_us: op.at } }) : null
    case 'setDuration': return a.dispatch('set_composition', { duration_us: op.d })
    case 'undo': return a.dispatch('undo', {})
    case 'redo': return a.dispatch('redo', {})
  }
}

describe('frame-grid invariant over the actor command matrix', () => {
  // One property over all eight rates: the rate is part of the arbitrary so the
  // shrinker can report the rate that broke, and the deterministic sweep below
  // guarantees every rate is visited regardless of how the runs distribute.
  it('no command sequence leaves an off-grid field, at any rate in the matrix', () => {
    fc.assert(fc.property(fc.constantFrom(...RATES), fc.array(opArb, { maxLength: 30, size: 'max' }), ([num, den], ops) => {
      const actor = seedTimeline(actorAt(num, den))
      for (const op of ops) {
        const res = applyOp(actor, op)
        const rejected = offGridRejection(res)
        if (rejected !== null) throw new Error(`${num}/${den}: ${op.t} was rejected by the grid backstop — a mutator failed to snap: ${rejected}`)
        const bad = offGridFields(wire(actor))
        if (bad.length > 0) throw new Error(`${num}/${den}: after ${op.t}: ${bad.join('; ')}`)
      }
      return true
    }), { seed: PBT_SEED, numRuns: PBT_RUNS })
  })

  // Every command in the matrix, at every rate, with off-grid arguments — so no
  // rate/op cell can be missed by the fuzz's run distribution.
  it.each(RATES)('every command lands on the %s/%s grid with deliberately off-grid arguments', (num, den) => {
    const actor = seedTimeline(actorAt(num, den))
    const script: Op[] = [
      { t: 'add', kind: 'color', track: 2, start: 2_500_001, len: 300_007 },
      { t: 'add', kind: 'video', track: 3, start: 3_100_003, len: 400_001 },
      { t: 'add', kind: 'audio', track: 4, start: 2_700_009, len: 500_003 },
      { t: 'trim', n: 0, edge: 'out', to: 470_003 },
      { t: 'trim', n: 1, edge: 'in', to: 480_007 },
      { t: 'split', n: 2, at: 1_300_001 },
      { t: 'splitMulti', n: 3, ats: [1_900_001, 2_100_003] },
      { t: 'duplicate', n: 4, off: 3_700_009 },
      { t: 'paste', n: 0, start: 4_100_001 },
      { t: 'move', n: 5, track: 1, start: 2_900_007 },
      { t: 'group', n: 0, m: 1 },
      { t: 'move', n: 0, track: 0, start: 100_001 },  // grouped move — siblings follow by a delta
      { t: 'trim', n: 0, edge: 'out', to: 300_003 },  // grouped trim
      { t: 'addTransition', n: 0, dur: 133_337 },
      { t: 'updateTransition', n: 0, dur: 66_669 },
      { t: 'addMarker', at: 1_234_567, span: 89_999 },
      { t: 'addMarker', at: 2_345_671, span: null },
      { t: 'updateMarker', n: 0, at: 987_653 },
      { t: 'setDuration', d: 5_555_551 },
      { t: 'removeTransition', n: 0 },
      { t: 'undo' }, { t: 'undo' }, { t: 'redo' },
    ]
    for (const op of script) {
      const res = applyOp(actor, op)
      expect(offGridRejection(res), `${op.t} @ ${num}/${den}`).toBeNull()
      expect(offGridFields(wire(actor)), `after ${op.t} @ ${num}/${den}`).toEqual([])
    }
  })

  // `set_composition { fps }` re-snaps every layer endpoint AND every marker onto
  // the new grid inside one commit. Miss either and the backstop rejects the fps
  // change outright, which is how a structural rule turns into a broken feature.
  it.each(RATES)('changing fps to %s/%s re-snaps layers and markers in the same commit', (num, den) => {
    const actor = seedTimeline(actorAt(30, 1))
    expect(actor.dispatch('add_marker', { t_us: 100_000, end_t_us: 400_000, label: 'm' }).ok).toBe(true)
    expect(actor.dispatch('add_marker', { t_us: 1_700_000, end_t_us: null, label: 'n' }).ok).toBe(true)
    const res = actor.dispatch('set_composition', { fps: { num, den } })
    expect(offGridRejection(res)).toBeNull()
    expect(res.ok).toBe(true)
    const after = wire(actor)
    expect(after.composition.fps).toEqual({ num, den })
    expect(offGridFields(after)).toEqual([])
    // Region markers stay non-degenerate: an fps change must not collapse one.
    for (const m of after.markers) if (m.end_t_us !== null) expect(m.end_t_us).toBeGreaterThan(m.t_us)
  })

  // commit() order is recipe → reconcileTransitions → validate (actor.ts), so a
  // trim that invalidates a transition drops it inside the SAME snapshot the
  // backstop then inspects. The dropped transition must not leave the shortened
  // layer's endpoint behind off the grid.
  it.each(RATES)('a trim that makes reconcile DROP a transition leaves no off-grid endpoint at %s/%s', (num, den) => {
    const actor = actorAt(num, den)
    const track = actor.snapshot().tracks[0].id
    const first = actor.dispatch('add_layer', { track, kind: 'video', media: VIDEO_MEDIA, src_in_us: 0, src_out_us: 1_000_001, t_start_us: 0, t_end_us: 1_000_001 })
    const second = actor.dispatch('add_layer', { track, kind: 'video', media: VIDEO_MEDIA, src_in_us: 0, src_out_us: 1_000_001, t_start_us: 1_000_001, t_end_us: 2_000_003 })
    expect([first.ok, second.ok]).toEqual([true, true])
    const from = first.ok ? (first.value as string) : ''
    const to = second.ok ? (second.value as string) : ''
    expect(actor.dispatch('add_transition', { from, to, duration_us: 200_003 }).ok).toBe(true)
    expect(wire(actor).transitions).toHaveLength(1)

    // Pull the outgoing layer's Out edge back — the overlap no longer equals the
    // stored duration, so reconcile drops the transition on this very commit.
    const trimmed = actor.dispatch('trim_layer', { layer: from, edge: 'out', new_t_us: 700_009, escape_group: false })
    expect(offGridRejection(trimmed)).toBeNull()
    expect(trimmed.ok).toBe(true)
    const after = wire(actor)
    expect(after.transitions).toHaveLength(0)
    expect(offGridFields(after)).toEqual([])
  })
})
