import { describe, it, expect } from 'vitest'
import { createWorkspaceStore, type WorkspaceFs, type WorkspaceTimer } from './workspace'
import {
  WORKSPACE_DOC_VERSION,
  EDITING_WORKSPACE_ID,
  activeWorkspaceProfile,
  type WorkspaceDocument,
} from '../shared/workspace'

/** In-memory fs + a manual timer so debounce/flush are deterministic. A
 *  monotonic id counter makes created profile ids predictable. */
function harness() {
  const vfs: Record<string, string> = {}
  const dirs = new Set<string>()
  const fs: WorkspaceFs = {
    exists: (p) => Object.prototype.hasOwnProperty.call(vfs, p) || dirs.has(p),
    readFile: (p) => {
      if (!Object.prototype.hasOwnProperty.call(vfs, p)) throw new Error(`enoent: ${p}`)
      return vfs[p]!
    },
    writeFile: (p, t) => { vfs[p] = t },
    rename: (a, b) => { vfs[b] = vfs[a]!; delete vfs[a] },
    mkdirp: (d) => { dirs.add(d) },
  }
  let scheduled: (() => void) | null = null
  let sets = 0
  let clears = 0
  const timer: WorkspaceTimer = {
    set: (cb) => { sets++; scheduled = cb; return { id: sets } },
    clear: () => { clears++; scheduled = null },
  }
  let ids = 0
  const path = '/cfg/workspaces.json'
  const store = createWorkspaceStore({ fs, path, dir: '/cfg', timer, newId: () => `ws-${++ids}` })
  return {
    store,
    vfs,
    path,
    fireTimer: () => { const cb = scheduled; scheduled = null; cb?.() },
    hasPending: () => scheduled !== null,
    counts: () => ({ sets, clears }),
    onDisk: () => JSON.parse(vfs[path]!) as WorkspaceDocument,
  }
}

describe('createWorkspaceStore document defaults', () => {
  it('returns the built-in Editing profile when the file is missing', () => {
    const { store } = harness()
    expect(store.get()).toEqual({
      version: WORKSPACE_DOC_VERSION,
      activeId: EDITING_WORKSPACE_ID,
      profiles: [{ id: EDITING_WORKSPACE_ID, name: 'Editing', current: null, saved: null }],
    })
  })

  it('degrades corrupt / empty / array documents to defaults', () => {
    for (const bad of ['{ not json', '   ', '[1,2,3]']) {
      const { store, vfs, path } = harness()
      vfs[path] = bad
      expect(store.get().activeId).toBe(EDITING_WORKSPACE_ID)
      expect(store.get().profiles).toHaveLength(1)
    }
  })

  it('migrates a v1 {current,saved} document into the Editing profile current', () => {
    const { store, vfs, path } = harness()
    vfs[path] = JSON.stringify({ version: 1, current: { layout: 'v1' }, saved: { baseline: 'v1' } })
    const doc = store.get()
    expect(doc.version).toBe(WORKSPACE_DOC_VERSION)
    expect(doc.profiles).toHaveLength(1)
    expect(activeWorkspaceProfile(doc)).toEqual({
      id: EDITING_WORKSPACE_ID, name: 'Editing', current: { layout: 'v1' }, saved: null,
    })
  })

  it('normalizes an invalid activeId back to Editing and keeps Editing immutable', () => {
    const { store, vfs, path } = harness()
    vfs[path] = JSON.stringify({
      version: WORKSPACE_DOC_VERSION,
      activeId: 'ghost',
      profiles: [
        // A tampered Editing entry with a saved baseline + wrong name must be repaired.
        { id: EDITING_WORKSPACE_ID, name: 'Hacked', current: { c: 1 }, saved: { s: 1 } },
        { id: 'custom-a', name: 'Cutting', current: { c: 2 }, saved: { s: 2 } },
      ],
    })
    const doc = store.get()
    expect(doc.activeId).toBe(EDITING_WORKSPACE_ID)
    expect(doc.profiles[0]).toEqual({ id: EDITING_WORKSPACE_ID, name: 'Editing', current: { c: 1 }, saved: null })
    expect(doc.profiles[1]).toMatchObject({ id: 'custom-a', name: 'Cutting' })
  })
})

describe('createWorkspaceStore current-layout autosave', () => {
  it('buffers setCurrent for the active profile and reads it back before any disk write', () => {
    const { store, vfs, path, hasPending } = harness()
    store.setCurrent({ version: 1, empty: false, dockview: { tag: 'x' } })
    expect(vfs[path]).toBeUndefined()
    expect(hasPending()).toBe(true)
    expect(activeWorkspaceProfile(store.get()).current).toEqual({ version: 1, empty: false, dockview: { tag: 'x' } })
  })

  it('coalesces rapid writes: the last value wins and only one write lands', () => {
    const { store, fireTimer, counts, onDisk } = harness()
    store.setCurrent({ n: 1 })
    store.setCurrent({ n: 2 })
    store.setCurrent({ n: 3 })
    expect(counts().clears).toBe(2)
    fireTimer()
    expect(activeWorkspaceProfile(onDisk()).current).toEqual({ n: 3 })
  })

  it('the debounce timer writes an atomic versioned document without an explicit flush', () => {
    const { store, vfs, path, fireTimer, onDisk } = harness()
    store.setCurrent({ via: 'timer' })
    expect(vfs[path]).toBeUndefined()
    fireTimer()
    expect(onDisk().version).toBe(WORKSPACE_DOC_VERSION)
    expect(activeWorkspaceProfile(onDisk()).current).toEqual({ via: 'timer' })
    expect(vfs[path + '.tmp']).toBeUndefined()
  })

  it('flush is a no-op when nothing is pending', () => {
    const { store, vfs } = harness()
    store.flush()
    expect(Object.keys(vfs)).toHaveLength(0)
  })

  it('reads a persisted document back after restart', () => {
    const first = harness()
    first.store.setCurrent({ layout: 'saved-to-disk' })
    first.store.flush()
    const disk = first.vfs[first.path]!
    const second = harness()
    second.vfs[second.path] = disk
    expect(activeWorkspaceProfile(second.store.get()).current).toEqual({ layout: 'saved-to-disk' })
  })

  it('preserves an intentionally empty layout as current (distinct from missing)', () => {
    const { store, fireTimer, onDisk } = harness()
    store.setCurrent({ version: 1, empty: true, dockview: null })
    fireTimer()
    expect(activeWorkspaceProfile(onDisk()).current).toEqual({ version: 1, empty: true, dockview: null })
  })
})

describe('createWorkspaceStore profile CRUD', () => {
  it('save-as creates a custom profile seeded from the current arrangement and activates it', () => {
    const { store, onDisk } = harness()
    const layout = { version: 1, empty: false, dockview: { tag: 'cut' } }
    const doc = store.createProfile('Cutting', layout)
    expect(doc.activeId).toBe('ws-1')
    expect(doc.profiles.map((p) => p.id)).toEqual([EDITING_WORKSPACE_ID, 'ws-1'])
    const created = doc.profiles[1]!
    expect(created).toEqual({ id: 'ws-1', name: 'Cutting', current: layout, saved: layout })
    // Persisted immediately (explicit user action), not debounced.
    expect(onDisk().activeId).toBe('ws-1')
  })

  it('save promotes the active custom profile current → its saved baseline', () => {
    const { store } = harness()
    store.createProfile('Cutting', { seed: true })
    store.setCurrent({ moved: true })
    const doc = store.saveBaseline()
    const active = activeWorkspaceProfile(doc)
    expect(active.current).toEqual({ moved: true })
    expect(active.saved).toEqual({ moved: true })
  })

  it('save on the immutable Editing profile is a no-op (never overwrites its baseline)', () => {
    const { store } = harness()
    store.setCurrent({ live: 'editing' })
    const doc = store.saveBaseline()
    expect(activeWorkspaceProfile(doc).saved).toBeNull()
    expect(activeWorkspaceProfile(doc).current).toEqual({ live: 'editing' })
  })

  it('switching flushes the current profile then activates the destination', () => {
    const { store, onDisk } = harness()
    store.createProfile('Cutting', { seed: 'cut' }) // active = ws-1
    // A buffered (debounced) current edit on ws-1 must survive the switch.
    store.setCurrent({ edited: 'cut' })
    const doc = store.setActive(EDITING_WORKSPACE_ID)
    expect(doc.activeId).toBe(EDITING_WORKSPACE_ID)
    // The flushed ws-1 current landed on disk before the switch.
    const persisted = onDisk()
    expect(persisted.activeId).toBe(EDITING_WORKSPACE_ID)
    expect(persisted.profiles.find((p) => p.id === 'ws-1')?.current).toEqual({ edited: 'cut' })
  })

  it('setActive with an unknown id falls back to Editing', () => {
    const { store } = harness()
    expect(store.setActive('does-not-exist').activeId).toBe(EDITING_WORKSPACE_ID)
  })

  it('renames a custom profile but refuses to rename Editing', () => {
    const { store } = harness()
    store.createProfile('Cutting', null)
    const renamed = store.renameProfile('ws-1', 'Color Grading')
    expect(renamed.profiles.find((p) => p.id === 'ws-1')?.name).toBe('Color Grading')
    const editingRename = store.renameProfile(EDITING_WORKSPACE_ID, 'Nope')
    expect(editingRename.profiles[0]?.name).toBe('Editing')
  })

  it('deleting the active custom profile first activates Editing', () => {
    const { store, onDisk } = harness()
    store.createProfile('Cutting', { seed: true }) // active = ws-1
    const doc = store.deleteProfile('ws-1')
    expect(doc.activeId).toBe(EDITING_WORKSPACE_ID)
    expect(doc.profiles.map((p) => p.id)).toEqual([EDITING_WORKSPACE_ID])
    expect(onDisk().activeId).toBe(EDITING_WORKSPACE_ID)
  })

  it('deleting a non-active custom profile keeps the active selection', () => {
    const { store } = harness()
    store.createProfile('Cutting', null)   // ws-1, active
    store.createProfile('Grading', null)   // ws-2, active
    const doc = store.deleteProfile('ws-1')
    expect(doc.activeId).toBe('ws-2')
    expect(doc.profiles.map((p) => p.id)).toEqual([EDITING_WORKSPACE_ID, 'ws-2'])
  })

  it('refuses to delete the built-in Editing profile', () => {
    const { store } = harness()
    const doc = store.deleteProfile(EDITING_WORKSPACE_ID)
    expect(doc.profiles.map((p) => p.id)).toEqual([EDITING_WORKSPACE_ID])
  })

  it('profiles, active selection, and baselines survive a restart', () => {
    const first = harness()
    first.store.createProfile('Cutting', { seed: 'cut' }) // ws-1 active
    first.store.setCurrent({ live: 'cut' })
    first.store.saveBaseline()                            // ws-1 saved = current
    first.store.setActive(EDITING_WORKSPACE_ID)
    first.store.setCurrent({ live: 'editing' })
    first.store.flush()

    const disk = first.vfs[first.path]!
    const second = harness()
    second.vfs[second.path] = disk
    const doc = second.store.get()
    expect(doc.activeId).toBe(EDITING_WORKSPACE_ID)
    const cutting = doc.profiles.find((p) => p.id === 'ws-1')!
    expect(cutting.name).toBe('Cutting')
    expect(cutting.current).toEqual({ live: 'cut' })
    expect(cutting.saved).toEqual({ live: 'cut' })
    expect(activeWorkspaceProfile(doc).current).toEqual({ live: 'editing' })
  })
})
