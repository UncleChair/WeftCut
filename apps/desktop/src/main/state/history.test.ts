// apps/desktop/src/main/state/history.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject, type Layer, type Project } from './model'
import { colorParams } from './mutations/add'
import { History, type HistoryEntry } from './history'
import type { MediaItem } from './model'

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
    h.replaceSettingsEverywhere({ preview_width: 640, preview_height: 360, autosave_interval_secs: 30, history_capacity: 200, auto_pair_audio_on_import: false, auto_delete_empty_tracks: false, prefer_proxies: false, proxy_overrides: {} })
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

describe('replaceCompositionEverywhere', () => {
  it('runs the transform over every snapshot, leaving the cursor untouched', () => {
    const gen = seededGen()
    const p0 = blankProject(gen, 'h')
    const h = new History(p0, { kind: 'User' }, gen())
    // record a second snapshot that differs (a duration change)
    const p1 = { ...p0, composition: { ...p0.composition, duration_us: 5_000_000, duration_pinned: true } }
    h.record({ op_id: gen(), actor: { kind: 'User' }, timestamp: '<TS>', summary: 's', affected: [], snapshot: p1 })
    const canvas = { width: 1280, height: 720, fps: { num: 24, den: 1 }, background: { r: 10, g: 20, b: 30, a: 255 } }
    h.replaceCompositionEverywhere((p) => ({ ...p, composition: { ...p.composition, ...canvas } }))
    // head (p1): canvas patched, this transform leaves duration alone
    expect(h.current().composition.width).toBe(1280)
    expect(h.current().composition.fps).toEqual({ num: 24, den: 1 })
    expect(h.current().composition.duration_us).toBe(5_000_000)
    expect(h.current().composition.duration_pinned).toBe(true)
    // earlier snapshot (Initial) also patched
    const initial = h.undo()!
    expect(initial.composition.width).toBe(1280)
    expect(initial.composition.duration_us).toBe(0)
  })

  /// A transform, not a value copy, precisely so it can read each snapshot: this is
  /// the shape the actor's duration overflow guard relies on.
  it('the transform sees each snapshot, so per-snapshot results can differ', () => {
    const gen = seededGen()
    const p0 = blankProject(gen, 'h2')
    const h = new History(p0, { kind: 'User' }, gen())
    const p1 = { ...p0, composition: { ...p0.composition, duration_us: 5_000_000 } }
    h.record({ op_id: gen(), actor: { kind: 'User' }, timestamp: '<TS>', summary: 's', affected: [], snapshot: p1 })
    h.replaceCompositionEverywhere((p) => ({
      ...p, composition: { ...p.composition, duration_us: Math.max(p.composition.duration_us, 1_000_000) },
    }))
    expect(h.current().composition.duration_us).toBe(5_000_000) // its own value won
    expect(h.undo()!.composition.duration_us).toBe(1_000_000) // the floor won
  })
})

describe('storedSnapshotsHoldLayer', () => {
  const LAYER: Layer = {
    id: 'layer-1', label: null, t_start_us: 0, t_end_us: 1_000_000,
    enabled: true, locked: false, metadata: {},
    params: colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1920, 1080), effects: [],
  }
  function withLayer(p: Project): Project {
    return { ...p, tracks: p.tracks.map((t, i) => (i === 0 ? { ...t, layers: [LAYER] } : t)) }
  }

  it('is false for a stack that has never held a layer', () => {
    const gen = seededGen(); const p0 = blankProject(gen, 's1')
    expect(new History(p0, { kind: 'User' }, gen()).storedSnapshotsHoldLayer()).toBe(false)
  })

  /// The undo backdoor the fps lock closes: the CURRENT state is layer-less, but an
  /// older snapshot is not, so a rate change would land in that snapshot too and undo
  /// would hand back layers quantized to the old grid.
  it('is true when only an OLDER snapshot holds a layer', () => {
    const gen = seededGen(); const p0 = blankProject(gen, 's2')
    const h = new History(withLayer(p0), { kind: 'User' }, gen())
    h.record({ op_id: gen(), actor: { kind: 'User' }, timestamp: '<TS>', summary: 'deleted it', affected: [], snapshot: p0 })
    expect(h.current().tracks.every((t) => t.layers.length === 0)).toBe(true)
    expect(h.storedSnapshotsHoldLayer()).toBe(true)
  })

  /// The second backdoor: restore_checkpoint reaches snapshots the stack no longer has.
  it('is true when only a CHECKPOINT holds a layer', () => {
    const gen = seededGen(); const p0 = blankProject(gen, 's3')
    const h = new History(withLayer(p0), { kind: 'User' }, gen())
    h.checkpoint('has a layer', { kind: 'User' }, gen())
    // Wipe the stack down to a layer-less head; the checkpoint still holds one.
    h.record({ op_id: gen(), actor: { kind: 'User' }, timestamp: '<TS>', summary: 'deleted it', affected: [], snapshot: p0 })
    expect(h.storedSnapshotsHoldLayer()).toBe(true)
  })
})

describe('History.replaceTrackFlagsEverywhere', () => {
  it('patches all snapshots + persists across undo, unrecorded', () => {
    const gen = seededGen(); const p0 = blankProject(gen, 't'); const tid = p0.tracks[0].id
    const h = new History(p0, { kind: 'User' }, gen())
    // record a second snapshot so there's something to undo to
    const p1 = { ...h.current(), markers: [...h.current().markers] }
    h.record({ op_id: gen(), actor: { kind: 'User' }, timestamp: '<TS>', summary: 'edit', affected: [], snapshot: p1 })
    h.replaceTrackFlagsEverywhere(tid, { locked: true })
    expect(h.current().tracks.find((t) => t.id === tid)!.locked).toBe(true)
    expect(h.len()).toBe(2) // not recorded
    const prev = h.undo()!
    expect(prev.tracks.find((t) => t.id === tid)!.locked).toBe(true) // persists across undo
  })
  it('only typeof-defined fields apply; absent track is skipped', () => {
    const gen = seededGen(); const p0 = blankProject(gen, 't'); const tid = p0.tracks[0].id
    const h = new History(p0, { kind: 'User' }, gen())
    h.replaceTrackFlagsEverywhere(tid, { muted: true })
    const t = h.current().tracks.find((x) => x.id === tid)!
    expect(t.muted).toBe(true); expect(t.locked).toBe(false) // untouched
    h.replaceTrackFlagsEverywhere('ghost', { locked: true }) // no such track → no-op, no throw
    expect(h.current().tracks.every((x) => !x.locked)).toBe(true)
  })
})

describe('History.replaceRoleFlagsEverywhere', () => {
  it('sets the role flags on every snapshot (default-filled), surviving undo', () => {
    const gen = seededGen()
    const p0 = blankProject(gen, 'h')
    const h = new History(p0, { kind: 'User' }, gen())
    const p1 = { ...p0, composition: { ...p0.composition, duration_us: 5_000_000 } }
    h.record({ op_id: gen(), actor: { kind: 'User' }, timestamp: '<TS>', summary: 's', affected: [], snapshot: p1 })
    h.replaceRoleFlagsEverywhere('music', { muted: true })
    expect(h.current().audio_roles.music).toEqual({ gain_db: 0, muted: true, solo: false }) // head patched, defaults filled
    const earlier = h.undo()! // back to the Initial snapshot
    expect(earlier.audio_roles.music).toEqual({ gain_db: 0, muted: true, solo: false }) // earlier patched too
    expect(earlier.composition.duration_us).toBe(0) // role-only patch leaves the rest intact
  })
  it('preserves an existing gain_db while toggling solo', () => {
    const gen = seededGen()
    const p0 = { ...blankProject(gen, 'h'), audio_roles: { dialogue: { gain_db: 6, muted: false, solo: false } } }
    const h = new History(p0, { kind: 'User' }, gen())
    h.replaceRoleFlagsEverywhere('dialogue', { solo: true })
    expect(h.current().audio_roles.dialogue).toEqual({ gain_db: 6, muted: false, solo: true })
  })
})

describe('History.replaceMediaPoolEverywhere', () => {
  const mediaItem = (id: string): MediaItem => ({
    id, label: null, path_abs: 'media/clip.bin', path_rel: null, kind: 'Video',
    metadata: { duration_us: 4_000_000, video: null, audio: null, container_format: null },
    file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '2026-01-01T00:00:00Z',
    decode_route: { route: 'bypass' }, conform_path: null, waveform_path: null, thumbnails_dir: null,
  })
  it('sets the pool on every snapshot, leaving the cursor put and surviving undo', () => {
    const gen = seededGen()
    const p0 = blankProject(gen, 'h')
    const h = new History(p0, { kind: 'User' }, gen())
    // record a second snapshot (an unrelated edit) so there are two entries to patch
    const p1 = { ...p0, composition: { ...p0.composition, duration_us: 5_000_000 } }
    h.record({ op_id: gen(), actor: { kind: 'User' }, timestamp: '<TS>', summary: 's', affected: [], snapshot: p1 })
    const id = '00000000-0000-0000-0000-0000000000aa'
    h.replaceMediaPoolEverywhere({ [id]: mediaItem(id) })
    expect(Object.keys(h.current().media_pool)).toEqual([id]) // head patched
    const earlier = h.undo()! // back to the Initial snapshot
    expect(Object.keys(earlier.media_pool)).toEqual([id])       // earlier snapshot patched too (durable across undo)
    expect(earlier.composition.duration_us).toBe(0)             // pool-only patch leaves the rest intact
  })
})
