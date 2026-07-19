import { describe, it, expect, vi } from 'vitest'
import { resolveDataRoot, type DataRootDeps, type DataRootFs } from './dataRoot'
import { createAppSettingsStore, type AppSettingsFs } from './app-settings'

const USER_DATA = '/userData'
const SETTINGS_PATH = '/userData/app_settings.json'

// POSIX join so the resolver's path math is deterministic in-memory (no
// platform separators leaking in).
const join = (...parts: string[]) => parts.join('/')

/** Real app-settings store over an in-memory file (single owner of the field). */
function settingsStore(seed?: Record<string, unknown>) {
  const files = new Map<string, string>()
  if (seed !== undefined) files.set(SETTINGS_PATH, JSON.stringify(seed))
  const fs: AppSettingsFs = {
    exists: (p) => files.has(p),
    readFile: (p) => { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v },
    writeFile: (p, t) => { files.set(p, t) },
    rename: (a, b) => { const v = files.get(a); if (v === undefined) throw new Error('ENOENT'); files.set(b, v); files.delete(a) },
    mkdirp: () => {},
  }
  const store = createAppSettingsStore({ fs, path: SETTINGS_PATH, dir: USER_DATA })
  return { store, files }
}

/** In-memory data-root fs; any path under a `bad` prefix throws on create/write. */
function rootFs(bad: string[] = []) {
  const dirs = new Set<string>()
  const isBad = (p: string) => bad.some((b) => p === b || p.startsWith(b + '/'))
  const fs: DataRootFs = {
    mkdirp: (d) => { if (isBad(d)) throw new Error('EACCES'); dirs.add(d) },
    writeFile: (p) => { if (isBad(p)) throw new Error('EACCES') },
    rm: () => {},
  }
  return { fs, dirs }
}

/** Deps whose dialog/picker/exit all throw — asserts they are never reached. */
function noPrompt(): Pick<DataRootDeps, 'showUnavailableDialog' | 'pickDirectory' | 'exit'> {
  return {
    showUnavailableDialog: () => { throw new Error('unexpected dialog') },
    pickDirectory: () => { throw new Error('unexpected picker') },
    exit: () => { throw new Error('unexpected exit') },
  }
}

describe('resolveDataRoot', () => {
  it('unset data_root → <userData>/data and creates all three subdirs', () => {
    const { store } = settingsStore() // no file → data_root unset
    const { fs, dirs } = rootFs()
    const resolved = resolveDataRoot({ userDataDir: USER_DATA, settings: store, fs, join, ...noPrompt() })

    expect(resolved).toEqual({
      dataRoot: '/userData/data',
      motifsDir: '/userData/data/motifs',
      cacheDir: '/userData/data/cache',
      downloadsDir: '/userData/data/downloads',
    })
    expect(dirs.has('/userData/data/motifs')).toBe(true)
    expect(dirs.has('/userData/data/cache')).toBe(true)
    expect(dirs.has('/userData/data/downloads')).toBe(true)
  })

  it('empty / whitespace data_root also falls back to the default', () => {
    const { store } = settingsStore({ data_root: '   ' })
    const { fs } = rootFs()
    const resolved = resolveDataRoot({ userDataDir: USER_DATA, settings: store, fs, join, ...noPrompt() })
    expect(resolved.dataRoot).toBe('/userData/data')
  })

  it('configured + available custom root → used as-is, subdirs created', () => {
    const { store } = settingsStore({ data_root: '/mnt/media/weft' })
    const { fs, dirs } = rootFs() // nothing bad → available
    const resolved = resolveDataRoot({ userDataDir: USER_DATA, settings: store, fs, join, ...noPrompt() })

    expect(resolved.dataRoot).toBe('/mnt/media/weft')
    expect(resolved.cacheDir).toBe('/mnt/media/weft/cache')
    expect(dirs.has('/mnt/media/weft/motifs')).toBe(true)
    expect(dirs.has('/mnt/media/weft/downloads')).toBe(true)
  })

  it('configured + unavailable → dialog; Re-set writes chosen path and switches (no copy)', () => {
    const { store } = settingsStore({ data_root: '/mnt/gone' })
    const { fs, dirs } = rootFs(['/mnt/gone']) // configured root unavailable
    const showUnavailableDialog = vi.fn((): 'reset' | 'quit' => 'reset')
    const pickDirectory = vi.fn((): string | null => '/mnt/new')
    const exit = vi.fn()

    const resolved = resolveDataRoot({
      userDataDir: USER_DATA, settings: store, fs, join,
      showUnavailableDialog, pickDirectory, exit,
    })

    expect(showUnavailableDialog).toHaveBeenCalledTimes(1)
    expect(showUnavailableDialog).toHaveBeenCalledWith('/mnt/gone')
    expect(pickDirectory).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()
    expect(resolved.dataRoot).toBe('/mnt/new')
    expect(dirs.has('/mnt/new/cache')).toBe(true)
    // The chosen path is persisted permanently to app_settings.json.
    expect(store.get().data_root).toBe('/mnt/new')
  })

  it('re-prompts when the newly-picked root is also unavailable', () => {
    const { store } = settingsStore({ data_root: '/mnt/gone' })
    const { fs } = rootFs(['/mnt/gone', '/mnt/alsobad'])
    const showUnavailableDialog = vi.fn((): 'reset' | 'quit' => 'reset')
    // First pick is also unavailable → re-prompt; second pick is good.
    const pickDirectory = vi.fn((): string | null => '/mnt/good').mockReturnValueOnce('/mnt/alsobad')
    const exit = vi.fn()

    const resolved = resolveDataRoot({
      userDataDir: USER_DATA, settings: store, fs, join,
      showUnavailableDialog, pickDirectory, exit,
    })

    expect(showUnavailableDialog).toHaveBeenCalledTimes(2)
    expect(showUnavailableDialog).toHaveBeenNthCalledWith(1, '/mnt/gone')
    expect(showUnavailableDialog).toHaveBeenNthCalledWith(2, '/mnt/alsobad')
    expect(pickDirectory).toHaveBeenCalledTimes(2)
    expect(resolved.dataRoot).toBe('/mnt/good')
    expect(store.get().data_root).toBe('/mnt/good')
    // No bad path was ever persisted.
    expect(store.get().data_root).not.toBe('/mnt/alsobad')
  })

  it('re-shows the dialog when the picker is cancelled, then succeeds', () => {
    const { store } = settingsStore({ data_root: '/mnt/gone' })
    const { fs } = rootFs(['/mnt/gone'])
    const showUnavailableDialog = vi.fn((): 'reset' | 'quit' => 'reset')
    // Cancel (null) once, then pick a good root.
    const pickDirectory = vi.fn((): string | null => '/mnt/good').mockReturnValueOnce(null)

    const resolved = resolveDataRoot({
      userDataDir: USER_DATA, settings: store, fs, join,
      showUnavailableDialog, pickDirectory, exit: vi.fn(),
    })

    expect(showUnavailableDialog).toHaveBeenCalledTimes(2)
    expect(resolved.dataRoot).toBe('/mnt/good')
  })

  it('Quit calls exit() and stops resolution', () => {
    const { store } = settingsStore({ data_root: '/mnt/gone' })
    const { fs } = rootFs(['/mnt/gone'])
    const exit = vi.fn()

    expect(() => resolveDataRoot({
      userDataDir: USER_DATA, settings: store, fs, join,
      showUnavailableDialog: () => 'quit',
      pickDirectory: () => { throw new Error('unexpected picker') },
      exit,
    })).toThrow(/quit/)
    expect(exit).toHaveBeenCalledTimes(1)
    // A configured-but-unavailable root is never silently overwritten.
    expect(store.get().data_root).toBe('/mnt/gone')
  })
})
