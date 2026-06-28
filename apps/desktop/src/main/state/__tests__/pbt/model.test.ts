import { describe, it } from 'vitest'
import fc from 'fast-check'
import { freshActor, wireSnapshot, aRollId, bRollId, PBT_SEED, PBT_RUNS } from './harness'
import { checkAllInvariants } from './invariants'

type Real = ReturnType<typeof freshActor>
interface MLayer { id: string; track: string; start: number; end: number }
interface Model { layers: Map<string, MLayer>; tracks: [string, string] }

const trackOf = (m: Model, i: 0 | 1) => m.tracks[i]
const idsSorted = (m: Model) => [...m.layers.keys()].sort()
function postcheck(real: Real) { checkAllInvariants(wireSnapshot(real)) }

class AddColor implements fc.Command<Model, Real> {
  constructor(readonly track: 0 | 1, readonly start: number, readonly len: number) {}
  check() { return true }
  run(m: Model, r: Real) {
    const res = r.dispatch('add_layer', { track: trackOf(m, this.track), kind: 'color', t_start_us: this.start, t_end_us: this.start + this.len })
    if (res.ok && typeof res.value === 'string') {
      m.layers.set(res.value, { id: res.value, track: trackOf(m, this.track), start: this.start, end: this.start + this.len })
      const live = wireSnapshot(r).tracks.flatMap((t) => t.layers).find((l) => l.id === res.value)!
      if (live.t_start_us !== this.start || live.t_end_us !== this.start + this.len) throw new Error(`add landed wrong: ${live.t_start_us}..${live.t_end_us}`)
    }
    postcheck(r)
  }
  toString() { return `add(t${this.track}, ${this.start}, +${this.len})` }
}

class Move implements fc.Command<Model, Real> {
  constructor(readonly layerN: number, readonly track: 0 | 1, readonly start: number) {}
  check(m: Model) { return m.layers.size > 0 }
  run(m: Model, r: Real) {
    const id = idsSorted(m)[this.layerN % m.layers.size]
    const before = m.layers.get(id)!
    const res = r.dispatch('move_layer', { layer: id, to_track: trackOf(m, this.track), t_start_us: this.start, escape_group: false })
    if (res.ok) {
      const dur = before.end - before.start
      const next = { id, track: trackOf(m, this.track), start: this.start, end: this.start + dur }
      m.layers.set(id, next)
      const live = wireSnapshot(r).tracks.flatMap((t) => t.layers).find((l) => l.id === id)!
      if (live.t_start_us !== next.start || live.t_end_us !== next.end) throw new Error(`move landed wrong: ${live.t_start_us}..${live.t_end_us} expected ${next.start}..${next.end}`)
    }
    postcheck(r)
  }
  toString() { return `move(#${this.layerN}, t${this.track}, ${this.start})` }
}

class Delete implements fc.Command<Model, Real> {
  constructor(readonly layerN: number) {}
  check(m: Model) { return m.layers.size > 0 }
  run(m: Model, r: Real) {
    const id = idsSorted(m)[this.layerN % m.layers.size]
    const res = r.dispatch('delete_layer', { layer: id })
    if (res.ok) {
      m.layers.delete(id)
      const live = wireSnapshot(r).tracks.flatMap((t) => t.layers).some((l) => l.id === id)
      if (live) throw new Error(`delete left layer ${id} present`)
    }
    postcheck(r)
  }
  toString() { return `delete(#${this.layerN})` }
}

class Undo implements fc.Command<Model, Real> {
  check() { return true }
  run(_m: Model, r: Real) { r.dispatch('undo', {}); postcheck(r) }
  toString() { return 'undo' }
}

const tu = (max: number) => fc.integer({ min: 0, max }).map((n) => n * 100_000)
const commands = [
  fc.tuple(fc.constantFrom(0, 1) as fc.Arbitrary<0 | 1>, tu(9), fc.integer({ min: 1, max: 9 }).map((n) => n * 100_000)).map(([t, s, l]) => new AddColor(t, s, l)),
  fc.tuple(fc.nat({ max: 20 }), fc.constantFrom(0, 1) as fc.Arbitrary<0 | 1>, tu(12)).map(([n, t, s]) => new Move(n, t, s)),
  fc.nat({ max: 20 }).map((n) => new Delete(n)),
  fc.constant(new Undo()),
]

describe('model-based oracle (exact-field intent on success)', () => {
  it('actor matches the simplified model for add/move/delete/undo', () => {
    fc.assert(fc.property(fc.commands(commands, { maxCommands: 30 }), (cmds) => {
      const setup = () => {
        const real = freshActor()
        const model: Model = { layers: new Map(), tracks: [aRollId(real), bRollId(real)] }
        return { model, real }
      }
      fc.modelRun(setup, cmds)
    }), { seed: PBT_SEED, numRuns: PBT_RUNS })
  })
})
