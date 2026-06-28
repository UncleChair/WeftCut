import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { freshActor, wireSnapshot, aRollId, bRollId, PBT_SEED, PBT_RUNS } from './harness'
import { checkAllInvariants } from './invariants'

type Op =
  | { t: 'add'; track: 0 | 1; start: number; len: number }
  | { t: 'duplicate'; n: number; off: number }
  | { t: 'split'; n: number; at: number }
  | { t: 'group'; n: number; m: number }
  | { t: 'addTransition'; n: number; m: number; dur: number }
  | { t: 'undo' } | { t: 'redo' }

const tu = (max: number) => fc.integer({ min: 0, max }).map((n) => n * 100_000)
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant('add' as const), track: fc.constantFrom(0, 1) as fc.Arbitrary<0 | 1>, start: tu(9), len: fc.integer({ min: 1, max: 9 }).map((n) => n * 100_000) }),
  fc.record({ t: fc.constant('duplicate' as const), n: fc.nat({ max: 20 }), off: tu(12) }),
  fc.record({ t: fc.constant('split' as const), n: fc.nat({ max: 20 }), at: tu(12) }),
  fc.record({ t: fc.constant('group' as const), n: fc.nat({ max: 20 }), m: fc.nat({ max: 20 }) }),
  fc.record({ t: fc.constant('addTransition' as const), n: fc.nat({ max: 20 }), m: fc.nat({ max: 20 }), dur: fc.integer({ min: 1, max: 5 }).map((x) => x * 100_000) }),
  fc.record({ t: fc.constant('undo' as const) }), fc.record({ t: fc.constant('redo' as const) }),
)

describe('broad-op invariant fuzz', () => {
  it('no op interleaving ever breaks an invariant or throws', () => {
    fc.assert(fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
      const actor = freshActor()
      const tracks = () => [aRollId(actor), bRollId(actor)]
      for (const op of ops) {
        const layers = wireSnapshot(actor).tracks.flatMap((t) => t.layers.map((l) => l.id))
        const pick = (i: number) => layers[i % layers.length]
        let res: { ok: boolean }
        switch (op.t) {
          case 'add': res = actor.dispatch('add_layer', { track: tracks()[op.track], kind: 'color', t_start_us: op.start, t_end_us: op.start + op.len }); break
          case 'duplicate': res = layers.length ? actor.dispatch('duplicate_layer', { layer: pick(op.n), t_offset_us: op.off }) : { ok: true }; break
          case 'split': res = layers.length ? actor.dispatch('split_layer', { layer: pick(op.n), at_t_us: op.at, escape_group: false }) : { ok: true }; break
          case 'group': res = layers.length >= 2 ? actor.dispatch('groups_create', { layers: [pick(op.n), pick(op.m)], label: null, reassign: false }) : { ok: true }; break
          case 'addTransition': res = layers.length >= 2 ? actor.dispatch('add_transition', { from: pick(op.n), to: pick(op.m), duration_us: op.dur }) : { ok: true }; break
          case 'undo': res = actor.dispatch('undo', {}); break
          case 'redo': res = actor.dispatch('redo', {}); break
        }
        // dispatch must always return a structured result, never throw.
        expect(typeof res.ok).toBe('boolean')
        // invariants hold after every step regardless of ok/err.
        checkAllInvariants(wireSnapshot(actor))
      }
    }), { seed: PBT_SEED, numRuns: PBT_RUNS })
  })
})
