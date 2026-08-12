// apps/desktop/src/main/state/__tests__/history-navigation.test.ts
// The actor half of the history panel's backend: random-access cursor movement
// (`jump_to`) and the User-actor checkpoint surface (create / delete), both
// reached through the renderer's `project_*` command channels.
import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject } from '../model'
import { createActor, type ChangeEvent, type DispatchResult } from '../actor'

/** An IdGen that reports how many ids it has handed out — the id-burn convention
 *  (a rejected path consumes ZERO op_ids) is otherwise invisible. */
function countingGen(): { gen: IdGen; burned: () => number } {
  const inner = seededGen()
  let n = 0
  return { gen: () => { n += 1; return inner() }, burned: () => n }
}

function setup() {
  const { gen, burned } = countingGen()
  const initial = blankProject(gen, 'hn')
  const actor = createActor({ initial, idGen: gen, clock: () => '<TS>' })
  const track = initial.tracks[0].id
  let at = 0
  /** One recorded edit — a color layer laid end to end with the previous. */
  function edit(): void {
    const t0 = at * 1_000_000
    at += 1
    const r = actor.dispatch('add_layer', { track, kind: 'color', t_start_us: t0, t_end_us: t0 + 1_000_000 })
    if (!r.ok) throw new Error(`edit failed: ${JSON.stringify(r.error)}`)
  }
  return { actor, edit, burned }
}

const err = (r: DispatchResult): string => (r.ok ? 'ok' : r.error.error)
const layerCount = (a: ReturnType<typeof createActor>): number =>
  a.snapshot().tracks.reduce((n, t) => n + t.layers.length, 0)

describe('jump_to — random access over the stack', () => {
  it('moves the cursor backward and forward, swapping in that entry\'s state', () => {
    const { actor, edit } = setup()
    edit(); edit(); edit()
    expect(layerCount(actor)).toBe(3)
    expect(actor.dispatch('jump_to', { index: 1 }).ok).toBe(true)
    expect(layerCount(actor)).toBe(1)          // state AFTER op 1
    expect(actor.historyView(50).cursor).toBe(1)
    expect(actor.dispatch('jump_to', { index: 3 }).ok).toBe(true)
    expect(layerCount(actor)).toBe(3)          // forward again — the tail survived
    expect(actor.dispatch('jump_to', { index: 0 }).ok).toBe(true)
    expect(layerCount(actor)).toBe(0)          // the seed entry
  })

  /// Cursor-only, exactly like undo/redo: the generalization of a cursor move is
  /// still a cursor move (docs/features.md #undo-stack-scope).
  it('records no entry', () => {
    const { actor, edit } = setup()
    edit(); edit()
    const before = actor.historyView(50)
    actor.dispatch('jump_to', { index: 0 })
    actor.dispatch('jump_to', { index: 2 })
    const after = actor.historyView(50)
    expect(after.len).toBe(before.len)
    expect(after.ops.map((o) => o.op_id)).toEqual(before.ops.map((o) => o.op_id))
  })

  it('jumping to the CURRENT index succeeds and leaves everything where it is', () => {
    const { actor, edit } = setup()
    edit(); edit()
    const cursor = actor.historyView(50).cursor
    expect(actor.dispatch('jump_to', { index: cursor }).ok).toBe(true)
    expect(actor.historyView(50).cursor).toBe(cursor)
    expect(layerCount(actor)).toBe(2)
  })

  it('an edit after a jump truncates the tail (resume-from-the-past)', () => {
    const { actor, edit } = setup()
    edit(); edit(); edit()
    actor.dispatch('jump_to', { index: 1 })
    edit()
    const v = actor.historyView(50)
    expect(v.len).toBe(3)                       // Initial, op1, the new edit
    expect(v.cursor).toBe(2)
    expect(actor.dispatch('redo', {})).toEqual({ ok: false, error: { error: 'NothingToRedo' } })
  })

  it('broadcasts an unrecorded change event so subscribers refetch', () => {
    const { actor, edit } = setup()
    edit()
    const seen: ChangeEvent[] = []
    actor.subscribe((e) => seen.push(e))
    actor.dispatch('jump_to', { index: 0 })
    expect(seen).toHaveLength(1)
    expect(seen[0].summary).toBe('Jump to history entry')
    expect(seen[0].affected).toEqual([])
  })

  describe('rejections burn zero op_ids', () => {
    it('rejects an out-of-range or non-integer index with InvalidArgument', () => {
      const { actor, edit, burned } = setup()
      edit(); edit()
      const cursorBefore = actor.historyView(50).cursor
      const idsBefore = burned()
      for (const index of [3, 99, -1, 1.5]) {
        const r = actor.dispatch('jump_to', { index })
        expect(err(r), `index ${index}`).toBe('InvalidArgument')
      }
      expect(actor.dispatch('jump_to', {})).toMatchObject({ ok: false, error: { error: 'InvalidArgument' } })
      expect(burned()).toBe(idsBefore)                       // nothing minted
      expect(actor.historyView(50).cursor).toBe(cursorBefore) // cursor untouched
      expect(layerCount(actor)).toBe(2)
    })

    /// Without this check jump_to would be a back door straight around the
    /// agent's revert lock — it reaches every state undo can reach, in one call.
    it('rejects with HistoryLocked while the agent holds the lock', () => {
      const { actor, edit, burned } = setup()
      edit(); edit()
      actor.lockHistory('agent batch')
      const idsBefore = burned()
      const r = actor.dispatch('jump_to', { index: 0 })
      expect(r).toEqual({ ok: false, error: { error: 'HistoryLocked', reason: 'agent batch' } })
      expect(burned()).toBe(idsBefore)
      expect(actor.historyView(50).cursor).toBe(2)
      expect(layerCount(actor)).toBe(2) // state never moved
      actor.unlockHistory()
      expect(actor.dispatch('jump_to', { index: 0 }).ok).toBe(true) // released
    })

    /// The lock is checked BEFORE the range check, so a locked history never
    /// leaks "that index doesn't exist" either.
    it('reports the lock, not the range, when both would fail', () => {
      const { actor } = setup()
      actor.lockHistory('agent batch')
      expect(err(actor.dispatch('jump_to', { index: 999 }))).toBe('HistoryLocked')
    })
  })

  it('is reachable through the renderer channel (project_jump_to → jump_to)', () => {
    const { actor, edit } = setup()
    edit(); edit()
    expect(actor.command('project_jump_to', { index: 0 }).ok).toBe(true)
    expect(layerCount(actor)).toBe(0)
    expect(actor.historyView(50).cursor).toBe(0)
  })

  it('the ActorHandle method throws where dispatch returns the error', () => {
    const { actor, edit } = setup()
    edit()
    actor.jumpTo(0)
    expect(layerCount(actor)).toBe(0)
    expect(() => actor.jumpTo(42)).toThrow(/InvalidArgument/)
  })
})

describe('checkpoints — the User-actor create / delete surface', () => {
  it('create → list → restore → delete round trip over the renderer channels', () => {
    const { actor, edit } = setup()
    edit() // one layer, then checkpoint here
    const created = actor.command('project_create_checkpoint', { label: 'before the risky bit' })
    expect(created.ok).toBe(true)
    const id = (created as { ok: true; value: string }).value

    // list: the checkpoint is stamped User (the MCP tool path stamps Agent).
    expect(actor.listCheckpoints()).toEqual([
      { id, label: 'before the risky bit', actor: { kind: 'User' }, created_at: '<TS>' },
    ])
    expect(actor.historyView(50).checkpoints).toEqual([
      { id, label: 'before the risky bit', actor: { kind: 'User' }, created_at: '<TS>' },
    ])

    edit(); edit()
    expect(layerCount(actor)).toBe(3)

    // restore: records a new entry (it introduces state from OUTSIDE the stack).
    const lenBefore = actor.historyView(50).len
    expect(actor.command('project_restore_checkpoint', { checkpointId: id }).ok).toBe(true)
    expect(layerCount(actor)).toBe(1)
    expect(actor.historyView(50).len).toBe(lenBefore + 1)

    // delete: the checkpoint goes, the restored state stays.
    expect(actor.command('project_delete_checkpoint', { checkpointId: id }).ok).toBe(true)
    expect(actor.listCheckpoints()).toEqual([])
    expect(layerCount(actor)).toBe(1)
    // …and it is genuinely gone: a second restore can no longer find it.
    expect(err(actor.command('project_restore_checkpoint', { checkpointId: id }))).toBe('CheckpointNotFound')
  })

  it('delete of an absent checkpoint reports CheckpointNotFound and burns zero op_ids', () => {
    const { actor, burned } = setup()
    const idsBefore = burned()
    const r = actor.command('project_delete_checkpoint', { checkpointId: '00000000-0000-0000-0000-0000000000ee' })
    expect(r).toEqual({ ok: false, error: { error: 'CheckpointNotFound', checkpoint: '00000000-0000-0000-0000-0000000000ee' } })
    expect(burned()).toBe(idsBefore)
  })

  it('delete records nothing and broadcasts nothing — no project state changed', () => {
    const { actor, edit } = setup()
    edit()
    const id = (actor.command('project_create_checkpoint', { label: 'cp' }) as { ok: true; value: string }).value
    const seen: ChangeEvent[] = []
    actor.subscribe((e) => seen.push(e))
    const lenBefore = actor.historyView(50).len
    actor.command('project_delete_checkpoint', { checkpointId: id })
    expect(seen).toEqual([])
    expect(actor.historyView(50).len).toBe(lenBefore)
  })

  it('create rejects an empty label, burning zero op_ids', () => {
    const { actor, burned } = setup()
    const idsBefore = burned()
    expect(err(actor.command('project_create_checkpoint', { label: '   ' }))).toBe('InvalidArgument')
    expect(err(actor.command('project_create_checkpoint', { label: 42 }))).toBe('InvalidArgument')
    expect(burned()).toBe(idsBefore)
    expect(actor.listCheckpoints()).toEqual([])
  })

  it('delete leaves the OTHER checkpoints and their snapshots intact', () => {
    const { actor, edit } = setup()
    const early = (actor.command('project_create_checkpoint', { label: 'early' }) as { ok: true; value: string }).value
    edit(); edit()
    const late = (actor.command('project_create_checkpoint', { label: 'late' }) as { ok: true; value: string }).value
    expect(actor.command('project_delete_checkpoint', { checkpointId: late }).ok).toBe(true)
    expect(actor.listCheckpoints().map((c) => c.label)).toEqual(['early'])
    expect(actor.command('project_restore_checkpoint', { checkpointId: early }).ok).toBe(true)
    expect(layerCount(actor)).toBe(0)
  })
})

describe('evicted on the actor-served view', () => {
  /// replace_state resets History wholesale (the old project's snapshots are
  /// incoherent against a new project_id), so the eviction count resets with it —
  /// a fresh stack has discarded nothing.
  it('zeroes on replace_state', () => {
    const { gen } = countingGen()
    const initial = blankProject(gen, 'ev')
    const actor = createActor({ initial, idGen: gen, clock: () => '<TS>' })
    const track = initial.tracks[0].id
    for (let i = 0; i < 205; i++)
      actor.dispatch('add_layer', { track, kind: 'color', t_start_us: i * 1_000_000, t_end_us: i * 1_000_000 + 500_000 })
    const overflowed = actor.historyView(200)
    expect(overflowed.evicted).toBeGreaterThan(0)
    expect(overflowed.len).toBe(200)

    actor.dispatch('replace_state', { name: 'fresh' })
    expect(actor.historyView(200)).toMatchObject({ evicted: 0, len: 1 })
  })
})
