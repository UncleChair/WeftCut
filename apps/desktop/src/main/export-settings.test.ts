import { describe, it, expect } from 'vitest'
import { createExportSettingsStore, type ExportSettingsFs } from './export-settings'

const WS = '/ws'
const FILE = '/ws/export.json'

function memFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed))
  const fs: ExportSettingsFs = {
    exists: (p) => files.has(p),
    readFile: (p) => { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v },
    writeFile: (p, t) => { files.set(p, t) },
    rename: (a, b) => { const v = files.get(a); if (v === undefined) throw new Error('ENOENT'); files.set(b, v); files.delete(a) },
    mkdirp: () => {},
  }
  return { fs, files }
}
const store = (seed?: Record<string, string>) =>
  createExportSettingsStore({ ...memFs(seed), join: (...p) => p.join('/') })

describe('export-settings store', () => {
  it('returns null when no file', () => {
    expect(store().load(WS)).toBeNull()
  })

  it('round-trips an opaque value via an independent reader instance', () => {
    const { fs } = memFs()
    const s = createExportSettingsStore({ fs, join: (...p) => p.join('/') })
    const value = { codec: 'av1', quality: 'high' }
    s.save(WS, value)
    const reader = createExportSettingsStore({ fs, join: (...p) => p.join('/') })
    expect(reader.load(WS)).toEqual(value)
  })

  it('atomic write leaves no .tmp behind', () => {
    const { fs, files } = memFs()
    createExportSettingsStore({ fs, join: (...p) => p.join('/') }).save(WS, { codec: 'h264' })
    expect(files.has(FILE)).toBe(true)
    expect(files.has(FILE + '.tmp')).toBe(false)
  })

  it('returns null on an empty file', () => {
    expect(store({ [FILE]: '' }).load(WS)).toBeNull()
  })

  it('returns null on garbage JSON', () => {
    expect(store({ [FILE]: '{ not json' }).load(WS)).toBeNull()
  })
})
