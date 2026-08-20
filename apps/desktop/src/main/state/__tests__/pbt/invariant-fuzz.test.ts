import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { freshActor, wireSnapshot, canonicalSnapshot, aRollId, bRollId, PBT_SEED, PBT_RUNS } from './harness'
import { checkAllInvariants } from './invariants'

// ── Seeded media ──────────────────────────────────────────────────────────────
// Finite durations make video/audio layers — and add/update_transition's
// tail-handle math (media duration minus src_out) — reachable from the pool.
// add_media is UNRECORDED (replaceMediaPoolEverywhere), so it must run BEFORE
// any undo-baseline capture: the pool survives a full unwind by design.
const VIDEO_MEDIA = 'fuzz-media-video'
const AUDIO_MEDIA = 'fuzz-media-audio'
const VIDEO_MEDIA_DUR = 1_000_000 // layers ≤ 900k leave a 100k..900k tail handle
const AUDIO_MEDIA_DUR = 2_000_000

function seededActor() {
  const actor = freshActor()
  actor.dispatch('add_media', { id: VIDEO_MEDIA, kind: 'Video', duration_us: VIDEO_MEDIA_DUR, with_audio: false })
  actor.dispatch('add_media', { id: AUDIO_MEDIA, kind: 'Audio', duration_us: AUDIO_MEDIA_DUR, with_audio: true })
  return actor
}
type ActorT = ReturnType<typeof freshActor>

/** Recorded base timeline so transition ops have plausible targets from op #1:
 *  three visual cuts on A-roll (two with REAL tail-handle limits, two free-
 *  duration) and one audio cut on B-roll (the rejection path with realistic
 *  geometry). Undo can unwind these — that's churn, not a problem; the
 *  undo-unwind baseline is captured BEFORE this runs. */
function seedTimeline(actor: ActorT) {
  const a = aRollId(actor), b = bRollId(actor)
  actor.dispatch('add_layer', { track: a, kind: 'video', media: VIDEO_MEDIA, src_in_us: 0, src_out_us: 500_000, t_start_us: 0, t_end_us: 500_000 })
  actor.dispatch('add_layer', { track: a, kind: 'video', media: VIDEO_MEDIA, src_in_us: 0, src_out_us: 500_000, t_start_us: 500_000, t_end_us: 1_000_000 })
  actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 1_000_000, t_end_us: 1_600_000 })
  actor.dispatch('add_layer', { track: a, kind: 'color', t_start_us: 1_600_000, t_end_us: 2_400_000 })
  actor.dispatch('add_layer', { track: b, kind: 'audio', media: AUDIO_MEDIA, src_in_us: 0, src_out_us: 600_000, t_start_us: 0, t_end_us: 600_000 })
  actor.dispatch('add_layer', { track: b, kind: 'audio', media: AUDIO_MEDIA, src_in_us: 0, src_out_us: 600_000, t_start_us: 600_000, t_end_us: 1_200_000 })
  return actor
}

// ── Op records ────────────────────────────────────────────────────────────────
// Self-contained records targeting layers/tracks/transitions by index into the
// CURRENT snapshot (resolved at apply time — metamorphic.test.ts idiom) so
// targets are always valid-or-cleanly-rejected.
type KindArg = { kind?: string; direction?: string }
type Op =
  | { t: 'add'; kind: 'color' | 'video' | 'audio'; track: number; start: number; len: number }
  | { t: 'addTrack' }
  | { t: 'deleteTrack'; n: number; force: boolean }
  | { t: 'duplicate'; n: number; off: number }
  | { t: 'split'; n: number; at: number }
  | { t: 'move'; n: number; track: number; start: number }
  | { t: 'trim'; n: number; edge: 'in' | 'out'; to: number }
  | { t: 'delete'; n: number }
  | { t: 'group'; n: number; m: number }
  | { t: 'addTransition'; pick: 'adjacent' | 'any'; n: number; m: number; dur: number; kindArg: KindArg; placement: 'overlap' | 'extend' | undefined }
  | { t: 'updateTransition'; n: number; unknownId: boolean; dur: number | undefined; ext: number | undefined; kindArg: KindArg | undefined }
  | { t: 'removeTransition'; n: number; unknownId: boolean }
  | { t: 'undo' } | { t: 'redo' }

const tu = (max: number) => fc.integer({ min: 0, max }).map((n) => n * 100_000)
const DIRS = ['left', 'right', 'up', 'down'] as const

// (kind, direction) args: mostly valid pairings, hostile tail of pairing
// violations (Crossfade+direction, directional kind without one, unknown enum
// members, direction alone) — the strict parse boundary is under test too.
const validKindArb: fc.Arbitrary<KindArg> = fc.oneof(
  fc.constant<KindArg>({ kind: 'Crossfade' }),
  fc.record({ kind: fc.constantFrom('Wipe', 'Slide'), direction: fc.constantFrom(...DIRS) }),
)
const hostileKindArb: fc.Arbitrary<KindArg> = fc.oneof(
  fc.record({ kind: fc.constant('Crossfade'), direction: fc.constantFrom(...DIRS) }),
  fc.record({ kind: fc.constantFrom('Wipe', 'Slide') }),
  fc.constant<KindArg>({ kind: 'Wipe', direction: 'diagonal' }),
  fc.constant<KindArg>({ kind: 'Dissolve' }),
  fc.constant<KindArg>({ direction: 'left' }),
)
const kindArb = fc.oneof({ arbitrary: validKindArb, weight: 4 }, { arbitrary: hostileKindArb, weight: 1 })

// Durations: frame-ish plausible values, hostile tail (zero, negative,
// off-grid, absurd) so both the accept and structured-error paths run.
const durArb = fc.oneof(
  { arbitrary: fc.integer({ min: 1, max: 5 }).map((x) => x * 100_000), weight: 4 },
  { arbitrary: fc.constantFrom(0, -100_000, 7_777, 60_000_000), weight: 1 },
)
// extended_us patch values: mostly small plausible borrows (0 included — the
// give-it-all-back edge), plus a tail of negative (a LEGAL explicit tail trim
// now — spec D6 — that must land e = 0 or refuse atomically), off-grid, and
// over-any-plausible-duration values so the e′ ≤ d′ gate and the routing run.
const extArb = fc.oneof(
  { arbitrary: fc.integer({ min: 0, max: 5 }).map((x) => x * 100_000), weight: 4 },
  { arbitrary: fc.constantFrom(-100_000, 7_777, 60_000_000), weight: 1 },
)
const rareTrue = fc.oneof({ arbitrary: fc.constant(false), weight: 7 }, { arbitrary: fc.constant(true), weight: 1 })

// Weights keep the pool productive: layer edits (the reconcile stressors) and
// transition ops dominate; track churn and undo/redo stay a spicy minority so
// the timeline retains layers for transitions to ride.
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: fc.record({ t: fc.constant('add' as const),
    kind: fc.oneof({ arbitrary: fc.constant('color' as const), weight: 2 }, { arbitrary: fc.constantFrom('video' as const, 'audio' as const), weight: 2 }),
    track: fc.nat({ max: 5 }), start: tu(9), len: fc.integer({ min: 1, max: 9 }).map((n) => n * 100_000) }), weight: 3 },
  fc.record({ t: fc.constant('addTrack' as const) }),
  fc.record({ t: fc.constant('deleteTrack' as const), n: fc.nat({ max: 5 }), force: fc.boolean() }),
  fc.record({ t: fc.constant('duplicate' as const), n: fc.nat({ max: 20 }), off: tu(12) }),
  // split is the adjacency factory — every successful split mints a new cut.
  { arbitrary: fc.record({ t: fc.constant('split' as const), n: fc.nat({ max: 20 }), at: tu(12) }), weight: 2 },
  { arbitrary: fc.record({ t: fc.constant('move' as const), n: fc.nat({ max: 20 }), track: fc.nat({ max: 5 }), start: tu(12) }), weight: 2 },
  { arbitrary: fc.record({ t: fc.constant('trim' as const), n: fc.nat({ max: 20 }), edge: fc.constantFrom('in', 'out') as fc.Arbitrary<'in' | 'out'>, to: tu(12) }), weight: 2 },
  fc.record({ t: fc.constant('delete' as const), n: fc.nat({ max: 20 }) }),
  fc.record({ t: fc.constant('group' as const), n: fc.nat({ max: 20 }), m: fc.nat({ max: 20 }) }),
  // Transition ops get extra weight: reconcile — the feature's most bug-prone
  // part — only churns when live transitions meet the layer edits above.
  { arbitrary: fc.record({ t: fc.constant('addTransition' as const),
    pick: fc.oneof({ arbitrary: fc.constant('adjacent' as const), weight: 3 }, { arbitrary: fc.constant('any' as const), weight: 1 }),
    n: fc.nat({ max: 20 }), m: fc.nat({ max: 20 }), dur: durArb, kindArg: kindArb,
    // Both placements plus the absent-field default (= overlap), so the fuzz
    // mixes B-moving adds, tail-borrowing adds, and the flipped default.
    placement: fc.constantFrom<'overlap' | 'extend' | undefined>('overlap', 'extend', undefined) }), weight: 4 },
  { arbitrary: fc.record({ t: fc.constant('updateTransition' as const), n: fc.nat({ max: 8 }), unknownId: rareTrue,
    dur: fc.option(durArb, { nil: undefined }), ext: fc.option(extArb, { nil: undefined }), kindArg: fc.option(kindArb, { nil: undefined }) }), weight: 3 },
  { arbitrary: fc.record({ t: fc.constant('removeTransition' as const), n: fc.nat({ max: 8 }), unknownId: rareTrue }), weight: 2 },
  fc.record({ t: fc.constant('undo' as const) }), fc.record({ t: fc.constant('redo' as const) }),
)

/** Apply one op. Returns the DispatchResult, or null when the op had no
 *  possible target and was skipped. Never throws — that's part of the
 *  property (dispatch returns structured errors for every hostile input). */
function applyOp(actor: ActorT, op: Op): { ok: boolean } | null {
  const snap = wireSnapshot(actor)
  const trackIds = snap.tracks.map((t) => t.id)
  const layers = snap.tracks.flatMap((t) => t.layers.map((l) => l.id))
  const transitions = snap.transitions.map((tr) => tr.id)
  const pickLayer = (i: number) => layers[i % layers.length]
  const pickTrack = (i: number) => trackIds[i % trackIds.length]
  switch (op.t) {
    case 'add': {
      const args: Record<string, unknown> = { track: pickTrack(op.track), kind: op.kind, t_start_us: op.start, t_end_us: op.start + op.len }
      if (op.kind !== 'color') { args.media = op.kind === 'video' ? VIDEO_MEDIA : AUDIO_MEDIA; args.src_in_us = 0; args.src_out_us = op.len }
      return actor.dispatch('add_layer', args)
    }
    case 'addTrack': return actor.dispatch('add_track', { label: null })
    case 'deleteTrack': return actor.dispatch('delete_track', { track: pickTrack(op.n), force: op.force })
    case 'duplicate': return layers.length ? actor.dispatch('duplicate_layer', { layer: pickLayer(op.n), t_offset_us: op.off }) : null
    case 'split': return layers.length ? actor.dispatch('split_layer', { layer: pickLayer(op.n), at_t_us: op.at, escape_group: false }) : null
    case 'move': return layers.length ? actor.dispatch('move_layer', { layer: pickLayer(op.n), to_track: pickTrack(op.track), t_start_us: op.start, escape_group: false }) : null
    case 'trim': return layers.length ? actor.dispatch('trim_layer', { layer: pickLayer(op.n), edge: op.edge, new_t_us: op.to, escape_group: false }) : null
    case 'delete': return layers.length ? actor.dispatch('delete_layer', { layer: pickLayer(op.n) }) : null
    case 'group': return layers.length >= 2 ? actor.dispatch('groups_create', { layers: [pickLayer(op.n), pickLayer(op.m)], label: null, reassign: false }) : null
    case 'addTransition': {
      if (layers.length < 2) return null
      let from = pickLayer(op.n), to = pickLayer(op.m)
      if (op.pick === 'adjacent') {
        // Plausible bias: adjacent same-track pairs (fromEnd === toStart) — the
        // geometry both placements accept. Audio pairs stay in deliberately:
        // realistic geometry into the audio-rejection path. Falls back to the
        // hostile arbitrary pick (cross-track / non-adjacent / self) when the
        // timeline has no cuts.
        const pairs: Array<[string, string]> = []
        for (const t of snap.tracks) for (const a of t.layers) for (const b of t.layers)
          if (a.id !== b.id && a.t_end_us === b.t_start_us) pairs.push([a.id, b.id])
        if (pairs.length) [from, to] = pairs[op.n % pairs.length]
      }
      const placementArg = op.placement === undefined ? {} : { placement: op.placement }
      return actor.dispatch('add_transition', { from, to, duration_us: op.dur, ...op.kindArg, ...placementArg })
    }
    case 'updateTransition': {
      const target = op.unknownId ? 'no-such-transition' : transitions.length ? transitions[op.n % transitions.length] : null
      if (target === null) return null
      const args: Record<string, unknown> = { transition: target }
      if (op.dur !== undefined) args.duration_us = op.dur
      if (op.ext !== undefined) args.extended_us = op.ext
      if (op.kindArg !== undefined) Object.assign(args, op.kindArg)
      return actor.dispatch('update_transition', args)
    }
    case 'removeTransition': {
      const target = op.unknownId ? 'no-such-transition' : transitions.length ? transitions[op.n % transitions.length] : null
      if (target === null) return null
      return actor.dispatch('remove_transition', { transition: target })
    }
    case 'undo': return actor.dispatch('undo', {})
    case 'redo': return actor.dispatch('redo', {})
  }
}

const isTransitionOp = (op: Op) => op.t === 'addTransition' || op.t === 'updateTransition' || op.t === 'removeTransition'

describe('broad-op invariant fuzz', () => {
  // Load-bearing property (spec § Testing Decisions): reconcile runs in EVERY
  // commit, so after ANY op — success or structured failure — every surviving
  // transition satisfies the re-derived invariant (checkAllInvariants includes
  // invTransitionsWellFormed). Also: rejected transition commands are atomic —
  // no partial geometry (extend/shrink) may leak out of a failed commit.
  it('no op interleaving ever breaks an invariant or throws; failed transition ops are atomic', () => {
    // size:'max' biases toward LONG sequences — short ones leave the pool too
    // sparse for transitions to ever exist (probed; default sizing averaged
    // ~4 ops and produced zero live transitions across 200 runs).
    fc.assert(fc.property(fc.array(opArb, { maxLength: 40, size: 'max' }), (ops) => {
      const actor = seedTimeline(seededActor())
      for (const op of ops) {
        const before = isTransitionOp(op) ? canonicalSnapshot(actor) : null
        const res = applyOp(actor, op)
        // dispatch must always return a structured result, never throw.
        if (res !== null) expect(typeof res.ok).toBe('boolean')
        if (before !== null && res !== null && !res.ok) expect(canonicalSnapshot(actor)).toBe(before)
        // invariants hold after every step regardless of ok/err.
        checkAllInvariants(wireSnapshot(actor))
      }
    }), { seed: PBT_SEED, numRuns: PBT_RUNS })
  })

  // Undo unwinds transition-bearing histories completely (reconcile drops land
  // in the SAME snapshot as the edit, so one undo restores both). Termination
  // is on the dispatch contract (ok:false = NothingToUndo), not a canonical
  // fixpoint — adjacent history entries CAN be canonically equal (e.g. a
  // zero-delta move re-splices), which would stall a fixpoint probe early.
  it('undo fully unwinds to the seeded initial state with transitions in history', () => {
    fc.assert(fc.property(fc.array(opArb, { maxLength: 30, size: 'max' }), (ops) => {
      const actor = seededActor()
      const start = canonicalSnapshot(actor) // after media seeding (unrecorded) — BEFORE the recorded seed layers
      seedTimeline(actor)
      for (const op of ops) applyOp(actor, op)
      const bound = ops.length + 12 // ops + the 6 recorded seed commits, with slack
      for (let i = 0; i < bound && actor.dispatch('undo', {}).ok; i++) { /* unwind */ }
      return canonicalSnapshot(actor) === start
    }), { seed: PBT_SEED, numRuns: PBT_RUNS })
  })

  // Round-trip: undo × n then redo × n must land back on the exact state —
  // including transition geometry (the outgoing layer's auto-extension).
  // n redos, not redo-to-top: a trailing undo op in the sequence legitimately
  // leaves the cursor mid-stack.
  it('undo×n then redo×n returns to the exact final state (transitions included)', () => {
    fc.assert(fc.property(fc.array(opArb, { maxLength: 30, size: 'max' }), (ops) => {
      const actor = seedTimeline(seededActor())
      for (const op of ops) applyOp(actor, op)
      const final = canonicalSnapshot(actor)
      let undos = 0
      while (undos < ops.length + 12 && actor.dispatch('undo', {}).ok) undos++
      for (let i = 0; i < undos; i++) actor.dispatch('redo', {})
      return canonicalSnapshot(actor) === final
    }), { seed: PBT_SEED, numRuns: PBT_RUNS })
  })
})

describe('rejected transition commands burn no ids (pre-mint failure paths)', () => {
  // applyAddTransition mints its id AFTER the handle/kind/adjacency checks, so
  // these rejections must consume NOTHING — replaying the same script without the
  // failing calls yields byte-identical state AND the same next minted id.
  // (Deliberately NOT covered: a downstream ValidationFailed burns one id by
  // design — the known keystone landmine, gated elsewhere.)
  it('insufficient handle / audio participant / bad pairing / non-adjacent / shared group / zero-cross / over-length / unknown id consume no id', () => {
    type DispatchRes = ReturnType<ActorT['dispatch']>
    const err = (r: DispatchRes) => (r.ok ? null : r.error.error)
    const val = (r: DispatchRes) => (r.ok ? r.value : null) as string
    const run = (withFailures: boolean) => {
      const actor = seededActor()
      const vTrack = aRollId(actor), aTrack = bRollId(actor)
      const v1 = actor.dispatch('add_layer', { track: vTrack, kind: 'video', media: VIDEO_MEDIA, src_in_us: 0, src_out_us: 900_000, t_start_us: 0, t_end_us: 900_000 })
      const v2 = actor.dispatch('add_layer', { track: vTrack, kind: 'video', media: VIDEO_MEDIA, src_in_us: 0, src_out_us: 900_000, t_start_us: 900_000, t_end_us: 1_800_000 })
      const a1 = actor.dispatch('add_layer', { track: aTrack, kind: 'audio', media: AUDIO_MEDIA, src_in_us: 0, src_out_us: 500_000, t_start_us: 0, t_end_us: 500_000 })
      const a2 = actor.dispatch('add_layer', { track: aTrack, kind: 'audio', media: AUDIO_MEDIA, src_in_us: 0, src_out_us: 500_000, t_start_us: 500_000, t_end_us: 1_000_000 })
      // Fixtures for the overlap-placement refusals, seeded in BOTH runs: a color
      // cut whose incoming layer is grouped with a near-origin audio sibling
      // (zero-cross), and the v1+v2 pair grouped (shared participants).
      const c1 = actor.dispatch('add_layer', { track: vTrack, kind: 'color', t_start_us: 2_000_000, t_end_us: 3_000_000 })
      const c2 = actor.dispatch('add_layer', { track: vTrack, kind: 'color', t_start_us: 3_000_000, t_end_us: 4_000_000 })
      const tExtra = actor.dispatch('add_track', { label: null })
      const aud = actor.dispatch('add_layer', { track: val(tExtra), kind: 'audio', media: AUDIO_MEDIA, src_in_us: 0, src_out_us: 500_000, t_start_us: 200_000, t_end_us: 700_000 })
      const g1 = actor.dispatch('groups_create', { layers: [val(v1), val(v2)], label: null, reassign: false })
      const g2 = actor.dispatch('groups_create', { layers: [val(c2), val(aud)], label: null, reassign: false })
      expect([v1.ok, v2.ok, a1.ok, a2.ok, c1.ok, c2.ok, tExtra.ok, aud.ok, g1.ok, g2.ok]).toEqual([true, true, true, true, true, true, true, true, true, true])
      if (withFailures) {
        const [fv1, fv2, fa1, fa2, fc1, fc2] = [v1, v2, a1, a2, c1, c2].map(val)
        // tail handle = 1_000_000 - 900_000 = 100_000 < 200_000 requested (extend-only check)
        const insufficient = actor.dispatch('add_transition', { from: fv1, to: fv2, duration_us: 200_000, placement: 'extend' })
        expect(err(insufficient)).toBe('TransitionInsufficientHandle')
        if (!insufficient.ok && insufficient.error.error === 'TransitionInsufficientHandle') expect(insufficient.error.available_us).toBe(100_000)
        // Overlap default on the same grouped pair: participants share a group.
        expect(err(actor.dispatch('add_transition', { from: fv1, to: fv2, duration_us: 100_000 }))).toBe('TransitionParticipantsShareGroup')
        // c2's audio sibling would cross t = 0 (200k − 1M) → pre-mint ValidationFailed(NegativeLayerStart).
        expect(err(actor.dispatch('add_transition', { from: fc1, to: fc2, duration_us: 1_000_000 }))).toBe('ValidationFailed')
        // d > min(len_A, len_B) → pre-mint ValidationFailed(TransitionDurationOutOfRange, transition: null).
        expect(err(actor.dispatch('add_transition', { from: fc1, to: fc2, duration_us: 1_500_000 }))).toBe('ValidationFailed')
        expect(err(actor.dispatch('add_transition', { from: fa1, to: fa2, duration_us: 100_000 }))).toBe('TransitionUnsupportedLayerKind')
        expect(err(actor.dispatch('add_transition', { from: fv1, to: fv2, duration_us: 100_000, kind: 'Wipe' }))).toBe('InvalidArgument') // direction missing
        expect(err(actor.dispatch('add_transition', { from: fv1, to: fv2, duration_us: 100_000, placement: 'diagonal' }))).toBe('InvalidArgument') // bad placement enum
        expect(err(actor.dispatch('add_transition', { from: fv2, to: fv1, duration_us: 100_000 }))).toBe('TransitionLayersNotAdjacent')
        expect(err(actor.dispatch('add_transition', { from: fv1, to: fa1, duration_us: 100_000 }))).toBe('LayerNotFound') // cross-track: `to` not on from's track
        expect(err(actor.dispatch('update_transition', { transition: 'no-such-transition', duration_us: 100_000 }))).toBe('TransitionNotFound')
        expect(err(actor.dispatch('remove_transition', { transition: 'no-such-transition' }))).toBe('TransitionNotFound')
      }
      // The next mint reveals any burned id.
      const probe = actor.dispatch('add_layer', { track: vTrack, kind: 'color', t_start_us: 5_000_000, t_end_us: 5_400_000 })
      expect(probe.ok).toBe(true)
      return { id: val(probe), canon: canonicalSnapshot(actor) }
    }
    const a = run(true), b = run(false)
    expect(a.id).toBe(b.id)
    expect(a.canon).toBe(b.canon)
  })
})
