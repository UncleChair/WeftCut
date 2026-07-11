import { describe, expect, it } from 'vitest'
import { createDecodeCapabilityStore } from './decode-capability'
import type { AppSettingsFs } from './app-settings'

function memFs(): AppSettingsFs {
  const files = new Map<string, string>()
  return {
    exists: (p) => files.has(p),
    readFile: (p) => { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v },
    writeFile: (p, t) => void files.set(p, t),
    rename: (from, to) => { files.set(to, files.get(from)!); files.delete(from) },
    mkdirp: () => {},
  }
}

describe('decode capability cache', () => {
  it('misses, stores, hits', () => {
    const s = createDecodeCapabilityStore({ fs: memFs(), path: '/x/decode_capability.json', dir: '/x' })
    expect(s.get('sw', 'prores::yuv422p10le:hd', 'avcodec=61')).toBeNull()
    s.put('sw', 'prores::yuv422p10le:hd', 'avcodec=61', true)
    expect(s.get('sw', 'prores::yuv422p10le:hd', 'avcodec=61')).toBe(true)
  })
  it('envKey change invalidates the lane', () => {
    const s = createDecodeCapabilityStore({ fs: memFs(), path: '/x/c.json', dir: '/x' })
    s.put('sw', 'k', 'v1', true)
    expect(s.get('sw', 'k', 'v2')).toBeNull()       // stale env → miss
    s.put('sw', 'k', 'v2', false)
    expect(s.get('sw', 'k', 'v2')).toBe(false)
  })
  it('envKey change wipes the WHOLE lane, not just the touched classKey', () => {
    const s = createDecodeCapabilityStore({ fs: memFs(), path: '/x/c.json', dir: '/x' })
    s.put('sw', 'prores::yuv422p10le:hd', 'v1', true)
    s.put('sw', 'h264::yuv420p:hd', 'v1', true)
    s.put('sw', 'av1::yuv420p:hd', 'v2', false)
    // Both v1-era classKeys must be unreachable under the new env stamp —
    // a merge bug would leave them reachable since only 'av1::...' was touched.
    expect(s.get('sw', 'prores::yuv422p10le:hd', 'v2')).toBeNull()
    expect(s.get('sw', 'h264::yuv420p:hd', 'v2')).toBeNull()
    expect(s.get('sw', 'av1::yuv420p:hd', 'v2')).toBe(false)
  })
  it('corrupt file degrades to empty', () => {
    const fs = memFs()
    fs.writeFile('/x/c.json', '{nope')
    const s = createDecodeCapabilityStore({ fs, path: '/x/c.json', dir: '/x' })
    expect(s.get('sw', 'k', 'v')).toBeNull()
  })
})
