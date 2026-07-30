import { describe, expect, it, vi } from 'vitest'
import { createDecodeCapabilityStore, resolveHwLane, HW_LANE_PRIORITY } from './decode-capability'
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
  it('keys HW verdicts per device (VAAPI multi-node) without collision', () => {
    const s = createDecodeCapabilityStore({ fs: memFs(), path: '/x/c.json', dir: '/x' })
    s.put('vaapi', 'h264::yuv420p:hd', 'gpu', true, '/dev/dri/renderD128')
    s.put('vaapi', 'h264::yuv420p:hd', 'gpu', false, '/dev/dri/renderD129')
    expect(s.get('vaapi', 'h264::yuv420p:hd', 'gpu', '/dev/dri/renderD128')).toBe(true)
    expect(s.get('vaapi', 'h264::yuv420p:hd', 'gpu', '/dev/dri/renderD129')).toBe(false)
    // A device-less lookup for the same classKey is a DISTINCT (device=null) key,
    // so it must not pick up either node's verdict.
    expect(s.get('vaapi', 'h264::yuv420p:hd', 'gpu')).toBeNull()
  })
  it('corrupt file degrades to empty', () => {
    const fs = memFs()
    fs.writeFile('/x/c.json', '{nope')
    const s = createDecodeCapabilityStore({ fs, path: '/x/c.json', dir: '/x' })
    expect(s.get('sw', 'k', 'v')).toBeNull()
  })
})

// Advertisement-gated multi-lane HW resolution (User Story 8/9/17/18): resolvers
// probe ONLY lanes the component compiled in, in NVDEC > VAAPI > d3d11va >
// videotoolbox order, per DRM node for VAAPI, and fall back to software when
// none pass. Driven by FAKE capabilities (the `lanes` array), FAKE devices, and
// a FAKE verdict (the `probe` spy) — platform-independent, no GPU, runs in CI.
describe('resolveHwLane (advertisement-gated multi-lane HW probe)', () => {
  const envKey = () => Promise.resolve('gpu:1:2:drv')
  const store = () => createDecodeCapabilityStore({ fs: memFs(), path: '/x/c.json', dir: '/x' })
  // NVDEC/d3d11va/videotoolbox decode on the sole GPU/OS handle (device=null);
  // VAAPI enumerates DRM render nodes.
  const twoNodeDevices = (lane: 'sw' | 'd3d11va' | 'nvdec' | 'vaapi' | 'videotoolbox') =>
    lane === 'vaapi' ? ['/dev/dri/renderD128', '/dev/dri/renderD129'] : [null]

  it('exposes the NVDEC > VAAPI > d3d11va > videotoolbox priority as a stable contract', () => {
    expect(HW_LANE_PRIORITY).toEqual(['nvdec', 'vaapi', 'd3d11va', 'videotoolbox'])
  })

  it('takes NVDEC first when it passes, never touching VAAPI', async () => {
    const s = store()
    const probe = vi.fn((lane: string) => ({ ok: lane === 'nvdec', reason: null }))
    const r = await resolveHwLane({
      lanes: ['software', 'nvdec', 'vaapi'], store: s, classKey: 'h264::yuv420p:hd',
      envKey, devices: twoNodeDevices, probe,
    })
    expect(r).toEqual({ lane: 'nvdec', device: null, ok: true, reason: null })
    expect(probe.mock.calls).toEqual([['nvdec', null]]) // VAAPI never probed
    expect(s.get('nvdec', 'h264::yuv420p:hd', 'gpu:1:2:drv')).toBe(true)
  })

  it('honors priority regardless of advertisement order (VAAPI listed first)', async () => {
    const s = store()
    const probe = vi.fn(() => ({ ok: true, reason: null }))
    const r = await resolveHwLane({
      lanes: ['vaapi', 'nvdec'], store: s, classKey: 'k', envKey,
      devices: twoNodeDevices, probe,
    })
    expect(r.lane).toBe('nvdec') // priority list, not the order they were advertised
  })

  it('falls from a failed NVDEC to the VAAPI node that passes', async () => {
    const s = store()
    const probe = vi.fn((lane: string, device: string | null) => ({
      ok: lane === 'vaapi' && device === '/dev/dri/renderD129', reason: null,
    }))
    const r = await resolveHwLane({
      lanes: ['software', 'nvdec', 'vaapi'], store: s, classKey: 'k', envKey,
      devices: twoNodeDevices, probe,
    })
    expect(r).toEqual({ lane: 'vaapi', device: '/dev/dri/renderD129', ok: true, reason: null })
    expect(probe.mock.calls).toEqual([
      ['nvdec', null],
      ['vaapi', '/dev/dri/renderD128'],
      ['vaapi', '/dev/dri/renderD129'],
    ])
    expect(s.get('nvdec', 'k', 'gpu:1:2:drv')).toBe(false)
    expect(s.get('vaapi', 'k', 'gpu:1:2:drv', '/dev/dri/renderD128')).toBe(false)
    expect(s.get('vaapi', 'k', 'gpu:1:2:drv', '/dev/dri/renderD129')).toBe(true)
  })

  it('falls back to software (lane null) and caches every negative when nothing passes', async () => {
    const s = store()
    const probe = vi.fn(() => ({ ok: false, reason: 'no hw decoder' }))
    const r = await resolveHwLane({
      lanes: ['software', 'nvdec', 'vaapi'], store: s, classKey: 'k', envKey,
      devices: twoNodeDevices, probe,
    })
    expect(r).toEqual({ lane: null, device: null, ok: false, reason: 'no hw lane passed' })
    expect(s.get('nvdec', 'k', 'gpu:1:2:drv')).toBe(false)
    expect(s.get('vaapi', 'k', 'gpu:1:2:drv', '/dev/dri/renderD128')).toBe(false)
    expect(s.get('vaapi', 'k', 'gpu:1:2:drv', '/dev/dri/renderD129')).toBe(false)
  })

  it('NEVER probes when the build advertises no HW lane (Linux SW-only)', async () => {
    const s = store()
    const probe = vi.fn(() => ({ ok: true, reason: null }))
    const r = await resolveHwLane({
      lanes: ['software'], store: s, classKey: 'k', envKey, devices: twoNodeDevices, probe,
    })
    expect(r).toEqual({ lane: null, device: null, ok: false, reason: 'hw lane unavailable' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('treats an unloaded component (no advertised lanes) as unavailable without probing', async () => {
    const s = store()
    const probe = vi.fn(() => ({ ok: true, reason: null }))
    const r = await resolveHwLane({ lanes: [], store: s, classKey: 'k', envKey, devices: twoNodeDevices, probe })
    expect(r).toEqual({ lane: null, device: null, ok: false, reason: 'hw lane unavailable' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('short-circuits on a cached positive without re-probing', async () => {
    const s = store()
    s.put('nvdec', 'k', 'gpu:1:2:drv', true)
    const probe = vi.fn(() => ({ ok: false, reason: 'should not run' }))
    const r = await resolveHwLane({
      lanes: ['software', 'nvdec', 'vaapi'], store: s, classKey: 'k', envKey,
      devices: twoNodeDevices, probe,
    })
    expect(r).toEqual({ lane: 'nvdec', device: null, ok: true, reason: 'cached' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('a cached NEGATIVE for NVDEC skips it (no re-probe) and moves to VAAPI', async () => {
    const s = store()
    s.put('nvdec', 'k', 'gpu:1:2:drv', false)
    const probe = vi.fn((lane: string) => ({ ok: lane === 'vaapi', reason: null }))
    const r = await resolveHwLane({
      lanes: ['software', 'nvdec', 'vaapi'], store: s, classKey: 'k', envKey,
      devices: (lane) => (lane === 'vaapi' ? ['/dev/dri/renderD128'] : [null]), probe,
    })
    expect(r).toEqual({ lane: 'vaapi', device: '/dev/dri/renderD128', ok: true, reason: null })
    expect(probe.mock.calls).toEqual([['vaapi', '/dev/dri/renderD128']]) // NVDEC never re-probed
  })

  it('skips a VAAPI lane that enumerates zero DRM render nodes', async () => {
    const s = store()
    const probe = vi.fn(() => ({ ok: true, reason: null }))
    const r = await resolveHwLane({
      lanes: ['software', 'vaapi'], store: s, classKey: 'k', envKey,
      devices: () => [], probe, // no render nodes present
    })
    expect(r).toEqual({ lane: null, device: null, ok: false, reason: 'no hw lane passed' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('resolves the Windows d3d11va lane through the same path (device null)', async () => {
    const s = store()
    const probe = vi.fn(() => ({ ok: true, reason: null }))
    const r = await resolveHwLane({
      lanes: ['software', 'd3d11va'], store: s, classKey: 'h264::yuv420p:hd', envKey,
      devices: (lane) => (lane === 'vaapi' ? ['/dev/dri/renderD128'] : [null]), probe,
    })
    expect(r).toEqual({ lane: 'd3d11va', device: null, ok: true, reason: null })
    expect(probe).toHaveBeenCalledWith('d3d11va', null)
    expect(s.get('d3d11va', 'h264::yuv420p:hd', 'gpu:1:2:drv')).toBe(true)
  })

  it('resolves the macOS videotoolbox lane through the same path (device null)', async () => {
    const s = store()
    const probe = vi.fn(() => ({ ok: true, reason: null }))
    const r = await resolveHwLane({
      lanes: ['software', 'videotoolbox'], store: s, classKey: 'h264::yuv420p:hd', envKey,
      devices: (lane) => (lane === 'vaapi' ? ['/dev/dri/renderD128'] : [null]), probe,
    })
    expect(r).toEqual({ lane: 'videotoolbox', device: null, ok: true, reason: null })
    expect(probe).toHaveBeenCalledWith('videotoolbox', null)
    expect(s.get('videotoolbox', 'h264::yuv420p:hd', 'gpu:1:2:drv')).toBe(true)
  })

  it('falls back to software when the advertised videotoolbox lane probes unusable', async () => {
    // The advertisement is unconditional on macOS; the cached probe verdict is
    // the actual gate — a refusal must land on software, and be remembered.
    const s = store()
    const probe = vi.fn(() => ({ ok: false, reason: 'no hw surface' }))
    const r = await resolveHwLane({
      lanes: ['software', 'videotoolbox'], store: s, classKey: 'h264::yuv420p:uhd', envKey,
      devices: (lane) => (lane === 'vaapi' ? ['/dev/dri/renderD128'] : [null]), probe,
    })
    expect(r).toEqual({ lane: null, device: null, ok: false, reason: 'no hw lane passed' })
    expect(s.get('videotoolbox', 'h264::yuv420p:uhd', 'gpu:1:2:drv')).toBe(false)
  })
})
