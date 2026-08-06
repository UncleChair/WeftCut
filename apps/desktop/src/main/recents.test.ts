// Unit tests for the TS recents store — load/save, dedup, cap and order edge
// cases. All tests use an in-memory filesystem (no real disk I/O).

import { describe, it, expect, afterEach } from 'vitest'
import { createRecentsStore } from './recents'
import type { RecentsFs } from './recents'

/** Build an in-memory fs for testing. */
function makeFs(): RecentsFs & { _vfs: Record<string, string> } {
  const vfs: Record<string, string> = {}
  return {
    _vfs: vfs,
    exists: (p: string) => Object.prototype.hasOwnProperty.call(vfs, p),
    readFile: (p: string) => {
      if (!Object.prototype.hasOwnProperty.call(vfs, p)) throw new Error(`vfs: not found: ${p}`)
      return vfs[p]!
    },
    writeFile: (p: string, t: string) => { vfs[p] = t },
    rename: (a: string, b: string) => { vfs[b] = vfs[a]!; delete vfs[a] },
    mkdirp: (_d: string) => {},
  }
}

/** Create a store backed by the given in-memory fs. */
function fresh(fs: RecentsFs) {
  return createRecentsStore({ fs, path: '/cfg/recents.json', dir: '/cfg' })
}

// ── Port of recents.rs tests ─────────────────────────────────────────────────

describe('recents store — empty when no file yet', () => {
  it('returns empty list, null mostRecent, false reopen_on_launch', () => {
    const store = fresh(makeFs())
    expect(store.list()).toEqual([])
    expect(store.mostRecent()).toBeNull()
    expect(store.getReopenOnLaunch()).toBe(false)
  })
})

describe('recents store — push dedupes and caps', () => {
  it('caps at 10, newest first, dedup moves to top', () => {
    const fs = makeFs()
    const store = fresh(fs)
    // Push 15 entries (0..14).
    for (let i = 0; i < 15; i++) {
      store.push(`/proj/p${i}`, `p${i}`)
    }
    const entries = store.list()
    expect(entries.length).toBe(10)
    // Most recent first.
    expect(entries[0]!.name).toBe('p14')
    // p0..p4 were evicted; p5..p14 remain.
    expect(entries.map((e) => e.name)).toEqual(
      ['p14', 'p13', 'p12', 'p11', 'p10', 'p9', 'p8', 'p7', 'p6', 'p5'],
    )

    // Re-push an existing entry — should move to top, not duplicate.
    store.push('/proj/p10', 'p10')
    const after = store.list()
    expect(after.length).toBe(10)
    expect(after[0]!.name).toBe('p10')
    // p10 appears only once.
    expect(after.filter((e) => e.name === 'p10').length).toBe(1)
  })
})

describe('recents store — remove drops entry', () => {
  it('removes by path, leaves others', () => {
    const fs = makeFs()
    const store = fresh(fs)
    store.push('/proj/a', 'a')
    store.push('/proj/b', 'b')
    store.remove('/proj/a')
    const entries = store.list()
    expect(entries.length).toBe(1)
    expect(entries[0]!.name).toBe('b')
  })
})

describe('recents store — reopen_on_launch round-trips', () => {
  it('defaults false, round-trips true then false', () => {
    const fs = makeFs()
    const store = fresh(fs)
    expect(store.getReopenOnLaunch()).toBe(false)
    store.setReopenOnLaunch(true)
    expect(store.getReopenOnLaunch()).toBe(true)
    store.setReopenOnLaunch(false)
    expect(store.getReopenOnLaunch()).toBe(false)
  })
})

describe('recents store — last_new_project_parent round-trips', () => {
  it('defaults null, round-trips a path, overwrites on second call', () => {
    const fs = makeFs()
    const store = fresh(fs)
    expect(store.lastNewProjectParent()).toBeNull()
    store.setLastNewProjectParent('/projects/area')
    expect(store.lastNewProjectParent()).toBe('/projects/area')
    // Overwrite — UI re-records on every new project.
    store.setLastNewProjectParent('/other/area')
    expect(store.lastNewProjectParent()).toBe('/other/area')
  })
})

// ── Additional TS-specific tests ─────────────────────────────────────────────

describe('recents store — corrupt file degrades gracefully', () => {
  it('push never throws on a corrupt existing file', () => {
    const fs = makeFs()
    // Pre-populate with garbage JSON.
    fs.writeFile('/cfg/recents.json', '{this is not valid json}')
    const store = fresh(fs)
    // push must not throw.
    expect(() => store.push('/proj/new', 'new')).not.toThrow()
    // After recovery from corrupt file, the new entry is the only one.
    const entries = store.list()
    expect(entries.length).toBe(1)
    expect(entries[0]!.name).toBe('new')
  })
})

describe('recents store — empty JSON body degrades gracefully', () => {
  it('returns defaults when file is whitespace-only', () => {
    const fs = makeFs()
    fs.writeFile('/cfg/recents.json', '   ')
    const store = fresh(fs)
    expect(store.list()).toEqual([])
    expect(store.getReopenOnLaunch()).toBe(false)
    expect(store.mostRecent()).toBeNull()
    expect(store.lastNewProjectParent()).toBeNull()
  })
})

describe('recents store — mostRecent returns the top entry', () => {
  it('returns null on empty, first entry when non-empty', () => {
    const fs = makeFs()
    const store = fresh(fs)
    expect(store.mostRecent()).toBeNull()
    store.push('/proj/x', 'x')
    store.push('/proj/y', 'y')
    const top = store.mostRecent()
    expect(top?.name).toBe('y')
  })
})

describe('recents store — last_opened timestamp is set on push', () => {
  it('each pushed entry has a non-empty last_opened ISO string', () => {
    const fs = makeFs()
    const store = fresh(fs)
    store.push('/proj/z', 'z')
    const entries = store.list()
    expect(entries.length).toBe(1)
    expect(typeof entries[0]!.last_opened).toBe('string')
    expect(entries[0]!.last_opened.length).toBeGreaterThan(0)
    // Must parse as a date.
    expect(isNaN(Date.parse(entries[0]!.last_opened))).toBe(false)
  })
})

// ── Platform-conditional dedup parity (mirrors Rust `same_path` #[cfg] split) ──
// normPath reads process.platform at call time, so we override it per-test and
// restore in afterEach. case-INSENSITIVE on Windows, case-SENSITIVE elsewhere.
describe('recents store — push dedup is platform-conditional (Rust same_path parity)', () => {
  const realPlatform = process.platform
  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true })
  }
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  })

  it('on win32, a case-differing path dedupes (collapses to one entry)', () => {
    setPlatform('win32')
    const store = fresh(makeFs())
    store.push('/Proj/A', 'A')
    store.push('/proj/a', 'a-lower')
    const entries = store.list()
    expect(entries.length).toBe(1)
    // Re-push moved it to top with the new display name.
    expect(entries[0]!.name).toBe('a-lower')
  })

  it('on linux, a case-differing path is DISTINCT (two entries)', () => {
    setPlatform('linux')
    const store = fresh(makeFs())
    store.push('/Proj/A', 'A')
    store.push('/proj/a', 'a-lower')
    const entries = store.list()
    expect(entries.length).toBe(2)
    expect(entries.map((e) => e.path).sort()).toEqual(['/Proj/A', '/proj/a'])
  })
})
