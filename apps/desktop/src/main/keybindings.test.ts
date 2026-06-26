import { describe, it, expect } from 'vitest'
import { createKeybindingsStore, type KeybindingsFs } from './keybindings'

const PATH = '/cfg/keybindings.json'
const DIR = '/cfg'

function memFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed))
  const fs: KeybindingsFs = {
    exists: (p) => files.has(p),
    readFile: (p) => { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v },
    writeFile: (p, t) => { files.set(p, t) },
    rename: (a, b) => { const v = files.get(a); if (v === undefined) throw new Error('ENOENT'); files.set(b, v); files.delete(a) },
    mkdirp: () => {},
  }
  return { fs, files }
}

const store = (seed?: Record<string, string>) => {
  const { fs } = memFs(seed)
  return createKeybindingsStore({ fs, path: PATH, dir: DIR })
}

const storeWithFs = (seed?: Record<string, string>) => {
  const { fs, files } = memFs(seed)
  return { store: createKeybindingsStore({ fs, path: PATH, dir: DIR }), fs, files }
}

describe('keybindings store', () => {
  it('empty when no file yet', () => {
    expect(store().get()).toEqual({})
  })

  it('set round-trips', () => {
    const { store: s, fs } = storeWithFs()
    s.set('undo', ['F3'])
    // Read back via a fresh store instance sharing the same fs
    const s2 = createKeybindingsStore({ fs, path: PATH, dir: DIR })
    expect(s2.get()['undo']).toEqual(['F3'])
  })

  it('set overwrites existing action', () => {
    const s = store()
    s.set('undo', ['Mod+Z', 'F3'])
    s.set('undo', ['Mod+Z'])
    expect(s.get()['undo']).toEqual(['Mod+Z'])
  })

  it('empty keys means explicitly unbound (persists distinct from no entry)', () => {
    const s = store()
    s.set('undo', [])
    // Must be present as an empty array, not undefined
    const got = s.get()
    expect('undo' in got).toBe(true)
    expect(got['undo']).toEqual([])
  })

  it('reset_all clears everything', () => {
    const s = store()
    s.set('undo', ['F3'])
    s.set('save', ['Ctrl+Alt+S'])
    s.resetAll()
    expect(s.get()).toEqual({})
  })

  it('export and reimport round-trips (export → reset → import restores)', () => {
    const { fs } = memFs()
    const s = createKeybindingsStore({ fs, path: PATH, dir: DIR })
    const BACKUP = '/tmp/backup.json'
    s.set('undo', ['F3'])
    s.exportTo(BACKUP)
    s.resetAll()
    expect(s.get()).toEqual({})
    const restored = s.importFrom(BACKUP)
    expect(restored['undo']).toEqual(['F3'])
    // The store reflects the imported file, not just the return value.
    expect(s.get()['undo']).toEqual(['F3'])
  })

  it('import rejects invalid JSON without touching the current file', () => {
    const { fs } = memFs({ '/tmp/broken.json': '{ not json' })
    const s = createKeybindingsStore({ fs, path: PATH, dir: DIR })
    // Pre-existing override survives a failed import.
    s.set('undo', ['F3'])
    expect(() => s.importFrom('/tmp/broken.json')).toThrow()
    // Override must still be present after the failed import.
    expect(s.get()['undo']).toEqual(['F3'])
  })

  it('tolerates an empty file', () => {
    const { store: s } = storeWithFs({ [PATH]: '' })
    expect(s.get()).toEqual({})
    // And we can still write to it.
    s.set('undo', ['F3'])
    expect(Object.keys(s.get()).length).toBe(1)
  })

  it('write is atomic: no .tmp file left behind after set', () => {
    const { store: s, files } = storeWithFs()
    s.set('undo', ['F3'])
    expect(files.has(PATH + '.tmp')).toBe(false)
    expect(files.has(PATH)).toBe(true)
  })

  it('write is atomic: no .tmp file left behind after resetAll', () => {
    const { store: s, files } = storeWithFs()
    s.set('undo', ['F3'])
    s.resetAll()
    expect(files.has(PATH + '.tmp')).toBe(false)
  })

  it('exportTo writes valid JSON at the dest path', () => {
    const DEST = '/tmp/export.json'
    const { store: s, files } = storeWithFs()
    s.set('undo', ['Mod+Z', 'F3'])
    s.exportTo(DEST)
    expect(files.has(DEST)).toBe(true)
    const parsed = JSON.parse(files.get(DEST)!) as { overrides?: Record<string, string[]> }
    expect(parsed.overrides?.['undo']).toEqual(['Mod+Z', 'F3'])
  })

  it('exportTo on empty store writes {"overrides":{}} template', () => {
    const DEST = '/tmp/export-empty.json'
    const { store: s, files } = storeWithFs()
    s.exportTo(DEST)
    const parsed = JSON.parse(files.get(DEST)!) as { overrides?: Record<string, string[]> }
    expect(parsed.overrides).toEqual({})
  })

  it('multiple actions persist independently', () => {
    const s = store()
    s.set('undo', ['Mod+Z'])
    s.set('redo', ['Mod+Shift+Z'])
    s.set('save', ['Mod+S'])
    const got = s.get()
    expect(got['undo']).toEqual(['Mod+Z'])
    expect(got['redo']).toEqual(['Mod+Shift+Z'])
    expect(got['save']).toEqual(['Mod+S'])
  })
})
