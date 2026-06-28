import { describe, it } from 'vitest'
import fc from 'fast-check'
import { freshActor, canonicalSnapshot, wireSnapshot, aRollId, bRollId, PBT_SEED, PBT_RUNS } from './harness'
import { parseProject, serializeProject } from '../../serialize'
import { canonicalString } from '../../canonical'

// A self-contained op record. Targets layers by index into the CURRENT snapshot
// (resolved at apply time) so no @ref bookkeeping is needed and targets are
// always valid-or-cleanly-rejected.
type Op =
  | { t: 'add'; track: 0 | 1; start: number; len: number }
  | { t: 'move'; layerN: number; track: 0 | 1; start: number }
  | { t: 'trim'; layerN: number; edge: 'start' | 'end'; to: number }
  | { t: 'delete'; layerN: number }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant('add' as const), track: fc.constantFrom(0, 1) as fc.Arbitrary<0 | 1>, start: fc.integer({ min: 0, max: 9 }).map((n) => n * 100_000), len: fc.integer({ min: 1, max: 9 }).map((n) => n * 100_000) }),
  fc.record({ t: fc.constant('move' as const), layerN: fc.nat({ max: 20 }), track: fc.constantFrom(0, 1) as fc.Arbitrary<0 | 1>, start: fc.integer({ min: 0, max: 12 }).map((n) => n * 100_000) }),
  fc.record({ t: fc.constant('trim' as const), layerN: fc.nat({ max: 20 }), edge: fc.constantFrom('start', 'end') as fc.Arbitrary<'start' | 'end'>, to: fc.integer({ min: 0, max: 12 }).map((n) => n * 100_000) }),
  fc.record({ t: fc.constant('delete' as const), layerN: fc.nat({ max: 20 }) }),
)

/** Apply ops to a fresh-or-given actor, resolving layer/track targets against
 *  the live snapshot. Ignored if the target index is out of range; rejected
 *  mutations are simply skipped (the actor stays consistent). Returns the actor. */
export function applyOps(actor: ReturnType<typeof freshActor>, ops: Op[]) {
  const tracks = () => [aRollId(actor), bRollId(actor)]
  for (const op of ops) {
    const layers = wireSnapshot(actor).tracks.flatMap((t) => t.layers.map((l) => l.id))
    switch (op.t) {
      case 'add':
        actor.dispatch('add_layer', { track: tracks()[op.track], kind: 'color', t_start_us: op.start, t_end_us: op.start + op.len })
        break
      case 'move':
        if (layers.length) actor.dispatch('move_layer', { layer: layers[op.layerN % layers.length], to_track: tracks()[op.track], t_start_us: op.start, escape_group: false })
        break
      case 'trim':
        if (layers.length) actor.dispatch('trim_layer', { layer: layers[op.layerN % layers.length], edge: op.edge, new_t_us: op.to, escape_group: false })
        break
      case 'delete':
        if (layers.length) actor.dispatch('delete_layer', { layer: layers[op.layerN % layers.length] })
        break
    }
  }
  return actor
}

describe('metamorphic properties (primary oracle)', () => {
  it('determinism: identical op lists yield byte-identical canonical state', () => {
    fc.assert(fc.property(fc.array(opArb, { maxLength: 25 }), (ops) => {
      const a = canonicalSnapshot(applyOps(freshActor(), ops))
      const b = canonicalSnapshot(applyOps(freshActor(), ops))
      return a === b
    }), { seed: PBT_SEED, numRuns: PBT_RUNS })
  })

  it('serialize round-trip: parse(serialize(s)) is canonical-identical', () => {
    fc.assert(fc.property(fc.array(opArb, { maxLength: 25 }), (ops) => {
      const actor = applyOps(freshActor(), ops)
      const wire = serializeProject(actor.snapshot())
      return canonicalString(serializeProject(parseProject(wire))) === canonicalString(wire)
    }), { seed: PBT_SEED, numRuns: PBT_RUNS })
  })

  it('undo fully unwinds to the initial blank state (coalescing-proof)', () => {
    fc.assert(fc.property(fc.array(opArb, { maxLength: 25 }), (ops) => {
      const actor = freshActor()
      const start = canonicalSnapshot(actor)
      applyOps(actor, ops)
      // Undo until the canonical state stops changing (robust to undo coalescing).
      let prev = ''
      for (let i = 0; i < ops.length + 5; i++) {
        const cur = canonicalSnapshot(actor)
        if (cur === prev) break
        prev = cur
        actor.dispatch('undo', {})
      }
      return canonicalSnapshot(actor) === start
    }), { seed: PBT_SEED, numRuns: PBT_RUNS })
  })
})
