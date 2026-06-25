import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { createActor } from '../actor'

function setup() {
  const idGen = seededGen()
  const initial = blankProject(idGen, 't') // mints A#1, B#2, project#3
  const actor = createActor({ initial, idGen, clock: () => '<TS>' }) // Initial op_id #4
  const aRoll = initial.tracks[0].id
  let colorOffset = 0
  function addColor() {
    const start = colorOffset * 2_000_000
    colorOffset += 1
    const r = actor.dispatch('add_layer', { kind: 'color', track: aRoll, t_start_us: start, t_end_us: start + 1_000_000 })
    return r.ok ? (r.value as string) : ''
  }
  return { actor, addColor }
}

describe('actor checkpoint surface', () => {
  it('checkpoint returns an id that appears in the projected list shape', () => {
    // (The exact id-burn count is corpus-gated in Task 2 via the trailing-op
    // technique; this test pins the return value + the {id,label,actor,created_at} shape.)
    const { actor } = setup()
    const cp = actor.checkpoint('cp1')
    expect(actor.listCheckpoints()).toEqual([{ id: cp, label: 'cp1', actor: { kind: 'User' }, created_at: '<TS>' }])
  })

  it('restore reverts state to the checkpoint snapshot', () => {
    const { actor, addColor } = setup()
    addColor()
    const cp = actor.checkpoint('cp1')
    const snapAtCp = JSON.stringify(actor.snapshot())
    addColor() // diverge
    expect(JSON.stringify(actor.snapshot())).not.toBe(snapAtCp)
    actor.restoreCheckpoint(cp)
    expect(JSON.stringify(actor.snapshot())).toBe(snapAtCp)
  })

  it('restore of an unknown checkpoint throws CheckpointNotFound', () => {
    const { actor } = setup()
    expect(() => actor.restoreCheckpoint('00000000-0000-0000-0000-0000000000ee')).toThrow(/CheckpointNotFound/)
  })

  it('restore while history is locked throws HistoryLocked (before the presence check)', () => {
    const { actor } = setup()
    const cp = actor.checkpoint('cp1')
    actor.lockHistory('agent batch')
    expect(() => actor.restoreCheckpoint(cp)).toThrow(/HistoryLocked/)
  })
})
