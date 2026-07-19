import { describe, it, expect } from 'vitest'
import {
  planMigration,
  runCopy,
  verify,
  rollback,
  assertDisjointRoots,
  isValidDataRoot,
  writeMarker,
  readMarker,
  clearMarker,
  deleteOldCopy,
  type MigrationFs,
  type CleanupMarker,
} from './dataRootMigration'
import type { Manifest } from '../shared/motifs/catalog'

// POSIX join so path math is deterministic in-memory (no platform separators).
const join = (...parts: string[]) => parts.join('/')

// Valid motif HTML with a parseable manifest island (matches composeMotifHtml's
// `id="motif-manifest"` island so parseManifestIsland + motifContentHash apply).
function motifHtml(id: string, version = 1, body = '<body></body>'): string {
  const manifest: Manifest = {
    id,
    name: id.toUpperCase(),
    version,
    size: [100, 100],
    default_duration_s: 1,
    props_schema: {},
  }
  return `<html><script id="motif-manifest" type="application/json">${JSON.stringify(manifest)}</script>${body}</html>`
}

/**
 * In-memory fs. Files map path→utf8 content; dirs is the set of directories.
 * `write` seeds a file (creating ancestor dirs). Absolute POSIX paths ('/old').
 */
function memFs() {
  const files = new Map<string, string>()
  const dirs = new Set<string>()

  const mkdirp = (p: string): void => {
    const segs = p.split('/')
    let cur = ''
    for (let i = 0; i < segs.length; i++) {
      cur = i === 0 ? segs[i] : cur + '/' + segs[i]
      if (cur !== '') dirs.add(cur)
    }
  }

  const fs: MigrationFs = {
    exists: (p) => files.has(p) || dirs.has(p),
    isDirectory: (p) => dirs.has(p),
    readDir: (p) => {
      const prefix = p.endsWith('/') ? p : p + '/'
      const names = new Set<string>()
      for (const k of [...files.keys(), ...dirs]) {
        if (k.startsWith(prefix)) {
          const seg = k.slice(prefix.length).split('/')[0]
          if (seg) names.add(seg)
        }
      }
      return [...names]
    },
    readFileText: (p) => {
      const v = files.get(p)
      if (v === undefined) throw new Error('ENOENT ' + p)
      return v
    },
    fileSize: (p) => {
      const v = files.get(p)
      return v === undefined ? 0 : Buffer.byteLength(v, 'utf8')
    },
    mkdirp,
    copyFile: (s, d) => {
      const v = files.get(s)
      if (v === undefined) throw new Error('ENOENT ' + s)
      files.set(d, v)
    },
    writeFile: (p, t) => {
      files.set(p, t)
    },
    rm: (p) => {
      files.delete(p)
      dirs.delete(p)
      const prefix = p + '/'
      for (const k of [...files.keys()]) if (k.startsWith(prefix)) files.delete(k)
      for (const k of [...dirs]) if (k.startsWith(prefix)) dirs.delete(k)
    },
  }

  const write = (p: string, content: string): void => {
    const dir = p.split('/').slice(0, -1).join('/')
    if (dir !== '') mkdirp(dir)
    files.set(p, content)
  }

  const snapshot = (prefix: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [k, v] of files) if (k === prefix || k.startsWith(prefix + '/')) out[k] = v
    return out
  }

  return { fs, files, dirs, write, snapshot }
}

// A populated OLD data root at /old with all three buckets.
function seedOldRoot(m: ReturnType<typeof memFs>): void {
  m.write('/old/motifs/countdown/index.html', motifHtml('countdown'))
  m.write('/old/motifs/lower-third/index.html', motifHtml('lower-third'))
  m.write('/old/motifs/lower-third/logo.png', 'PNGBYTES')
  m.write('/old/motifs/drafts/d1/index.html', motifHtml('d1'))
  m.write('/old/downloads/ffmpeg/ffmpeg.bin', 'FFMPEGDATA')
  // cache MUST NOT be copied — seed it to prove it is skipped.
  m.write('/old/cache/media/blob-0001', 'CACHEDATA')
  m.fs.mkdirp('/old/cache')
}

describe('assertDisjointRoots', () => {
  it('rejects identical roots', () => {
    expect(() => assertDisjointRoots('/old', '/old', join)).toThrow(/same/)
  })
  it('rejects new inside old', () => {
    expect(() => assertDisjointRoots('/old', '/old/inner', join)).toThrow(/inside/)
  })
  it('rejects old inside new', () => {
    expect(() => assertDisjointRoots('/old/inner', '/old', join)).toThrow(/inside|contain/)
  })
  it('allows sibling-prefixed paths (/old vs /older)', () => {
    expect(() => assertDisjointRoots('/old', '/older', join)).not.toThrow()
  })
})

describe('planMigration / isValidDataRoot', () => {
  it('adopts a target that is already a valid WeftCut data root', () => {
    const m = memFs()
    m.fs.mkdirp('/new/motifs')
    m.fs.mkdirp('/new/cache')
    m.fs.mkdirp('/new/downloads')
    expect(isValidDataRoot('/new', m.fs, join)).toBe(true)
    expect(planMigration('/old', '/new', m.fs, join)).toEqual({ mode: 'adopt' })
  })

  it('copies into a plain / empty folder (missing the layout)', () => {
    const m = memFs()
    m.fs.mkdirp('/new') // empty dir, no buckets
    expect(isValidDataRoot('/new', m.fs, join)).toBe(false)
    expect(planMigration('/old', '/new', m.fs, join)).toEqual({ mode: 'copy' })
  })

  it('is not a valid root when a bucket is missing', () => {
    const m = memFs()
    m.fs.mkdirp('/new/motifs')
    m.fs.mkdirp('/new/cache') // no downloads/
    expect(isValidDataRoot('/new', m.fs, join)).toBe(false)
  })

  it('rejects a nested pick', () => {
    const m = memFs()
    expect(() => planMigration('/old', '/old/sub', m.fs, join)).toThrow(/inside|contain/)
  })
})

describe('runCopy', () => {
  it('copies motifs + downloads only; creates an empty cache (cache NOT copied)', () => {
    const m = memFs()
    seedOldRoot(m)
    const { createdPaths } = runCopy('/old', '/new', m.fs, join)

    // motifs + downloads copied faithfully.
    expect(m.files.get('/new/motifs/countdown/index.html')).toBe(motifHtml('countdown'))
    expect(m.files.get('/new/motifs/lower-third/logo.png')).toBe('PNGBYTES')
    expect(m.files.get('/new/motifs/drafts/d1/index.html')).toBe(motifHtml('d1'))
    expect(m.files.get('/new/downloads/ffmpeg/ffmpeg.bin')).toBe('FFMPEGDATA')

    // cache exists at the new root but is EMPTY (the old cache blob is not copied).
    expect(m.dirs.has('/new/cache')).toBe(true)
    expect(m.files.has('/new/cache/media/blob-0001')).toBe(false)
    expect([...m.files.keys()].some((k) => k.startsWith('/new/cache/'))).toBe(false)

    // createdPaths lets rollback undo the whole fresh new root.
    expect(createdPaths).toContain('/new')
  })

  it('leaves the OLD root completely intact (source read-only)', () => {
    const m = memFs()
    seedOldRoot(m)
    const before = m.snapshot('/old')
    runCopy('/old', '/new', m.fs, join)
    expect(m.snapshot('/old')).toEqual(before)
  })

  it('emits progress with a copy denominator and a verify phase', () => {
    const m = memFs()
    seedOldRoot(m)
    const events: string[] = []
    runCopy('/old', '/new', m.fs, join, (p) => events.push(`${p.phase}:${p.copiedFiles}/${p.totalFiles}`))
    // 5 files copied (4 motif files + 1 download); cache not counted.
    expect(events[0]).toBe('copy:0/5')
    expect(events).toContain('verify:5/5')
  })

  it('rolls back its own partial copy on a mid-copy error, leaving oldRoot intact', () => {
    const m = memFs()
    seedOldRoot(m)
    const before = m.snapshot('/old')
    // Fail on the SECOND file copy to force a mid-copy error.
    let n = 0
    const failing: MigrationFs = {
      ...m.fs,
      copyFile: (s, d) => {
        n += 1
        if (n === 2) throw new Error('EIO simulated')
        m.fs.copyFile(s, d)
      },
    }
    expect(() => runCopy('/old', '/new', failing, join)).toThrow(/EIO/)
    // The freshly-created new root is gone (nothing partial survives).
    expect(m.dirs.has('/new')).toBe(false)
    expect([...m.files.keys()].some((k) => k.startsWith('/new/'))).toBe(false)
    // Old root untouched.
    expect(m.snapshot('/old')).toEqual(before)
  })

  it('refuses to merge into a pre-existing non-empty bucket', () => {
    const m = memFs()
    seedOldRoot(m)
    m.write('/new/motifs/existing/index.html', motifHtml('existing'))
    expect(() => runCopy('/old', '/new', m.fs, join)).toThrow(/refusing to merge/)
  })

  it('tracks only added buckets under a pre-existing (empty) new root', () => {
    const m = memFs()
    seedOldRoot(m)
    m.fs.mkdirp('/new') // exists but empty
    const { createdPaths } = runCopy('/old', '/new', m.fs, join)
    expect(createdPaths).not.toContain('/new')
    expect(createdPaths).toEqual(expect.arrayContaining(['/new/motifs', '/new/downloads', '/new/cache']))
  })
})

describe('verify', () => {
  it('passes for a faithful copy', () => {
    const m = memFs()
    seedOldRoot(m)
    runCopy('/old', '/new', m.fs, join)
    const r = verify('/old', '/new', m.fs, join)
    expect(r.ok).toBe(true)
    expect(r.mismatches).toEqual([])
  })

  it('detects a motif content mismatch', () => {
    const m = memFs()
    seedOldRoot(m)
    runCopy('/old', '/new', m.fs, join)
    // Corrupt a copied motif (different manifest version → different content hash).
    m.files.set('/new/motifs/countdown/index.html', motifHtml('countdown', 2))
    const r = verify('/old', '/new', m.fs, join)
    expect(r.ok).toBe(false)
    expect(r.mismatches.join(' ')).toMatch(/countdown/)
  })

  it('detects a downloads count/size mismatch', () => {
    const m = memFs()
    seedOldRoot(m)
    runCopy('/old', '/new', m.fs, join)
    m.fs.rm('/new/downloads/ffmpeg/ffmpeg.bin')
    const r = verify('/old', '/new', m.fs, join)
    expect(r.ok).toBe(false)
    expect(r.mismatches.join(' ')).toMatch(/downloads/)
  })
})

describe('verify-mismatch → rollback', () => {
  it('rolls back exactly the created paths, never touching oldRoot', () => {
    const m = memFs()
    seedOldRoot(m)
    const before = m.snapshot('/old')
    const { createdPaths } = runCopy('/old', '/new', m.fs, join)
    // Simulate a verify mismatch.
    m.files.set('/new/motifs/countdown/index.html', motifHtml('countdown', 9))
    const r = verify('/old', '/new', m.fs, join)
    expect(r.ok).toBe(false)

    rollback('/new', m.fs, createdPaths)
    // New root fully removed.
    expect(m.dirs.has('/new')).toBe(false)
    expect([...m.files.keys()].some((k) => k.startsWith('/new/'))).toBe(false)
    // Old root untouched.
    expect(m.snapshot('/old')).toEqual(before)
  })

  it('rollback removes only added buckets under a pre-existing new root', () => {
    const m = memFs()
    seedOldRoot(m)
    m.write('/new/keep-me.txt', 'USER FILE') // pre-existing unrelated content
    const { createdPaths } = runCopy('/old', '/new', m.fs, join)
    rollback('/new', m.fs, createdPaths)
    expect(m.files.get('/new/keep-me.txt')).toBe('USER FILE') // preserved
    expect(m.dirs.has('/new/motifs')).toBe(false)
    expect(m.dirs.has('/new/cache')).toBe(false)
  })
})

describe('cleanup marker (idempotent)', () => {
  const MARKER = '/userData/data-root-migration.json'
  const marker: CleanupMarker = { oldPath: '/old', newPath: '/new', status: 'pending-delete' }

  it('write → read round-trips', () => {
    const m = memFs()
    writeMarker(MARKER, marker, m.fs)
    expect(readMarker(MARKER, m.fs)).toEqual(marker)
  })

  it('writing twice is idempotent', () => {
    const m = memFs()
    writeMarker(MARKER, marker, m.fs)
    writeMarker(MARKER, marker, m.fs)
    expect(readMarker(MARKER, m.fs)).toEqual(marker)
  })

  it('read returns null when absent', () => {
    const m = memFs()
    expect(readMarker(MARKER, m.fs)).toBeNull()
  })

  it('read returns null on corrupt JSON or wrong status', () => {
    const m = memFs()
    m.fs.writeFile(MARKER, '{ not json')
    expect(readMarker(MARKER, m.fs)).toBeNull()
    m.fs.writeFile(MARKER, JSON.stringify({ oldPath: '/o', newPath: '/n', status: 'done' }))
    expect(readMarker(MARKER, m.fs)).toBeNull()
  })

  it('clear is idempotent (no throw when already gone)', () => {
    const m = memFs()
    writeMarker(MARKER, marker, m.fs)
    clearMarker(MARKER, m.fs)
    expect(readMarker(MARKER, m.fs)).toBeNull()
    expect(() => clearMarker(MARKER, m.fs)).not.toThrow()
    expect(readMarker(MARKER, m.fs)).toBeNull()
  })
})

describe('deleteOldCopy', () => {
  it('removes the whole dir when oldPath is the default <userData>/data', () => {
    const m = memFs()
    seedOldRoot(m) // reuse: pretend /old is <userData>/data
    deleteOldCopy('/old', '/old', m.fs, join)
    expect(m.dirs.has('/old')).toBe(false)
    expect([...m.files.keys()].some((k) => k.startsWith('/old/'))).toBe(false)
  })

  it('removes only the three buckets for a custom oldPath, preserving other files', () => {
    const m = memFs()
    seedOldRoot(m)
    m.write('/old/notes.txt', 'USER NOTE') // unrelated file in the custom folder
    deleteOldCopy('/old', '/userData/data', m.fs, join)
    expect([...m.files.keys()].some((k) => k.startsWith('/old/motifs/'))).toBe(false)
    expect([...m.files.keys()].some((k) => k.startsWith('/old/downloads/'))).toBe(false)
    expect([...m.files.keys()].some((k) => k.startsWith('/old/cache/'))).toBe(false)
    expect(m.files.get('/old/notes.txt')).toBe('USER NOTE') // preserved
  })

  it('is idempotent (deleting an already-deleted copy is a no-op)', () => {
    const m = memFs()
    seedOldRoot(m)
    deleteOldCopy('/old', '/userData/data', m.fs, join)
    expect(() => deleteOldCopy('/old', '/userData/data', m.fs, join)).not.toThrow()
  })
})
