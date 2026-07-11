import { describe, it, expect } from 'vitest'
import { createAppSettingsStore, type AppSettingsFs } from './app-settings'
import { APP_SETTINGS_DEFAULTS } from '../shared/app-settings'

const PATH = '/cfg/app_settings.json'
const DIR = '/cfg'

function memFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed))
  const fs: AppSettingsFs = {
    exists: (p) => files.has(p),
    readFile: (p) => { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v },
    writeFile: (p, t) => { files.set(p, t) },
    rename: (a, b) => { const v = files.get(a); if (v === undefined) throw new Error('ENOENT'); files.set(b, v); files.delete(a) },
    mkdirp: () => {},
  }
  return { fs, files }
}
const store = (seed?: Record<string, string>) => createAppSettingsStore({ ...memFs(seed), path: PATH, dir: DIR })

describe('app-settings store', () => {
  it('defaults when no file', () => {
    expect(store().get()).toEqual(APP_SETTINGS_DEFAULTS)
  })

  it('apply persists then reads back (independent reader)', () => {
    const { fs, files } = memFs()
    const s = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    const after = s.apply({ display_mode: 'ShowAll', delta_window_us: 5_000_000, media_pool_drawer_open: true, tail_snap_enabled: false, tail_snap_strength_px: 24 })
    expect(after.display_mode).toBe('ShowAll')
    expect(after.delta_window_us).toBe(5_000_000)
    expect(after.tail_snap_strength_px).toBe(24)
    const reader = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    expect(reader.get()).toEqual(after)
    expect(files.has(PATH + '.tmp')).toBe(false) // tmp promoted, not left behind
  })

  it('missing fields inherit defaults', () => {
    const s = store({ [PATH]: '{ "display_mode": "ShowAll" }' })
    const got = s.get()
    expect(got.display_mode).toBe('ShowAll')
    expect(got.delta_window_us).toBe(10_000_000)
    expect(got.tail_snap_enabled).toBe(true)
    expect(got.tail_snap_strength_px).toBe(12)
  })

  it('corrupt file falls back to defaults (no throw)', () => {
    const s = store({ [PATH]: '{ not valid json at all' })
    expect(s.get()).toEqual(APP_SETTINGS_DEFAULTS)
  })

  it('delta_window clamps to [1s, 5min]', () => {
    expect(store().apply({ delta_window_us: 0 }).delta_window_us).toBe(1_000_000)
    expect(store().apply({ delta_window_us: 10 * 60 * 1_000_000 }).delta_window_us).toBe(300_000_000)
  })

  it('tail_snap_strength clamps to [2, 80]', () => {
    expect(store().apply({ tail_snap_strength_px: 0 }).tail_snap_strength_px).toBe(2)
    expect(store().apply({ tail_snap_strength_px: 200 }).tail_snap_strength_px).toBe(80)
  })

  it('prebake_motifs / preview_effects_enabled round-trip', () => {
    expect(store().get().prebake_motifs).toBe(false)
    expect(store().apply({ prebake_motifs: true }).prebake_motifs).toBe(true)
    expect(store().get().preview_effects_enabled).toBe(true)
    expect(store().apply({ preview_effects_enabled: false }).preview_effects_enabled).toBe(false)
  })

  it('decode_engine defaults to auto, round-trips, and ignores unrecognized on-disk values', () => {
    expect(store().get().decode_engine).toBe('auto')
    expect(store().apply({ decode_engine: 'native' }).decode_engine).toBe('native')
    expect(store().apply({ decode_engine: 'webcodecs' }).decode_engine).toBe('webcodecs')
    // A pre-existing app_settings.json holding the field's old shape (a
    // boolean, or any other unrecognized value) falls back to the default —
    // no migration of a truthy old value into 'native'.
    const s = store({ [PATH]: '{ "decode_engine": true }' })
    expect(s.get().decode_engine).toBe('auto')
  })
})
