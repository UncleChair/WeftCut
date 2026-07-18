import { describe, expect, it, vi } from 'vitest'
import { createDecodeCapabilityStore, resolveHwProbe, HW_PREVIEW_LANE } from './decode-capability'
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

// Advertisement-gated HW probe (User Story 17/18): resolvers probe ONLY lanes
// the component compiled in. Driven by FAKE capabilities (the `lanes` array)
// and a FAKE verdict (the `probe` spy) — platform-independent, no GPU, runs in
// CI. The gate is what stops the Linux resolver from ever calling into the
// GPU-preview stub that returns a "not built" verdict by design.
describe('resolveHwProbe (advertisement-gated HW probe)', () => {
  const ADVERTISED = ['software', HW_PREVIEW_LANE] // Windows-shaped advertisement
  const envKey = () => Promise.resolve('gpu:1:2:drv')
  const store = () => createDecodeCapabilityStore({ fs: memFs(), path: '/x/c.json', dir: '/x' })

  it('probes an advertised HW lane on a cache miss, then caches the verdict', async () => {
    const s = store()
    const probe = vi.fn(() => ({ ok: true, reason: null }))
    const r = await resolveHwProbe({ lanes: ADVERTISED, store: s, classKey: 'h264::yuv420p:hd', envKey, probe })
    expect(r).toEqual({ ok: true, reason: null })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(s.get('hw', 'h264::yuv420p:hd', 'gpu:1:2:drv')).toBe(true) // verdict cached
  })

  it('NEVER probes a lane the build did not advertise (Linux: software only)', async () => {
    const s = store()
    const probe = vi.fn(() => ({ ok: true, reason: null }))
    const r = await resolveHwProbe({ lanes: ['software'], store: s, classKey: 'h264::yuv420p:hd', envKey, probe })
    expect(r).toEqual({ ok: false, reason: 'hw lane unavailable' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('treats an unloaded component (no advertised lanes) as unavailable without probing', async () => {
    const s = store()
    const probe = vi.fn(() => ({ ok: true, reason: null }))
    const r = await resolveHwProbe({ lanes: [], store: s, classKey: 'k', envKey, probe })
    expect(r).toEqual({ ok: false, reason: 'hw lane unavailable' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('short-circuits on a cached verdict without re-probing', async () => {
    const s = store()
    s.put('hw', 'h264::yuv420p:hd', 'gpu:1:2:drv', true)
    const probe = vi.fn(() => ({ ok: false, reason: 'should not run' }))
    const r = await resolveHwProbe({ lanes: ADVERTISED, store: s, classKey: 'h264::yuv420p:hd', envKey, probe })
    expect(r).toEqual({ ok: true, reason: 'cached' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('falls back (ok:false) and caches a negative probe verdict, fallback semantics intact', async () => {
    const s = store()
    const probe = vi.fn(() => ({ ok: false, reason: 'no hw decoder' }))
    const r = await resolveHwProbe({ lanes: ADVERTISED, store: s, classKey: 'av1::yuv420p:hd', envKey, probe })
    expect(r).toEqual({ ok: false, reason: 'no hw decoder' })
    expect(s.get('hw', 'av1::yuv420p:hd', 'gpu:1:2:drv')).toBe(false)
  })
})
