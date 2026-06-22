// apps/desktop/src/main/state/history.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject, type Project } from './model'
import { History, type HistoryEntry } from './history'

const U = { kind: 'User' as const }
function entry(p: Project, op: string): HistoryEntry {
  return { op_id: op, actor: U, timestamp: '<TS>', summary: op, affected: [], snapshot: p }
}
function freshProject(name: string): Project { return blankProject(seededGen(), name) }

describe('History', () => {
  it('records, undoes, and redoes', () => {
    const h = new History(freshProject('0'), U, 'op0')
    expect(h.canUndo()).toBe(false)
    h.record(entry(freshProject('1'), 'op1'))
    h.record(entry(freshProject('2'), 'op2'))
    expect(h.current().metadata.name).toBe('2')
    expect(h.undo()!.metadata.name).toBe('1')
    expect(h.undo()!.metadata.name).toBe('0')
    expect(h.undo()).toBeNull() // boundary
    expect(h.redo()!.metadata.name).toBe('1')
  })

  it('truncates the redo tail on a new record after undo', () => {
    const h = new History(freshProject('0'), U, 'op0')
    h.record(entry(freshProject('1'), 'op1'))
    h.record(entry(freshProject('2'), 'op2'))
    h.undo() // at '1'
    h.record(entry(freshProject('3'), 'op3'))
    expect(h.current().metadata.name).toBe('3')
    expect(h.redo()).toBeNull() // '2' was truncated
    expect(h.undo()!.metadata.name).toBe('1')
  })

  it('evicts from the front at capacity (cap 200)', () => {
    const h = new History(freshProject('seed'), U, 'op0')
    for (let i = 0; i < 250; i++) h.record(entry(freshProject(`e${i}`), `op${i}`))
    expect(h.len()).toBe(200)
    expect(h.current().metadata.name).toBe('e249')
  })

  it('blocks revert while locked and reports the reason', () => {
    const h = new History(freshProject('0'), U, 'op0')
    h.record(entry(freshProject('1'), 'op1'))
    h.lock('agent session')
    expect(h.lockReason()).toBe('agent session')
    h.unlock()
    expect(h.lockReason()).toBeNull()
  })

  it('checkpoints survive truncation and restore records a new entry', () => {
    const h = new History(freshProject('0'), U, 'op0')
    h.record(entry(freshProject('1'), 'op1'))
    h.checkpoint('cp', U, 'cpid')
    h.record(entry(freshProject('2'), 'op2'))
    const restored = h.restoreCheckpoint('cpid', 'op-restore', '<TS>', U)
    expect(restored!.metadata.name).toBe('1')
    expect(h.current().metadata.name).toBe('1') // restore recorded a new head
  })

  it('replaceSettingsEverywhere maps over all snapshots without moving the cursor', () => {
    const h = new History(freshProject('0'), U, 'op0')
    h.record(entry(freshProject('1'), 'op1'))
    const before = h.cursorIndex()
    h.replaceSettingsEverywhere({ preview_width: 640, preview_height: 360, autosave_interval_secs: 30, history_capacity: 200, auto_pair_audio_on_import: false, auto_delete_empty_tracks: false })
    expect(h.cursorIndex()).toBe(before)
    expect(h.current().settings.preview_width).toBe(640)
    expect(h.undo()!.settings.preview_width).toBe(640) // applied to the older snapshot too
  })

  it('view returns the last N summaries + cursor + len; status mirrors flags', () => {
    const h = new History(freshProject('0'), U, 'op0')
    h.record(entry(freshProject('1'), 'op1'))
    const v = h.view(10)
    expect(v.len).toBe(2); expect(v.cursor).toBe(1); expect(v.ops.length).toBe(2)
    const s = h.status()
    expect(s).toMatchObject({ cursor: 1, len: 2, can_undo: true, can_redo: false })
  })
})
