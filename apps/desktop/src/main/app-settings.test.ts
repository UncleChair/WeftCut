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
    const after = s.apply({ display_mode: 'ShowAll', delta_window_us: 5_000_000, tail_snap_enabled: false, tail_snap_strength_px: 24 })
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
    // The preview-snap pair must default too — see app-settings.ts for why.
    expect(got.preview_snap_enabled).toBe(true)
    expect(got.preview_snap_strength_px).toBe(12)
  })

  it('ignores the retired media drawer key without migrating or persisting it', () => {
    const { fs, files } = memFs({
      [PATH]: '{ "display_mode": "ShowAll", "media_pool_drawer_open": true }',
    })
    const s = createAppSettingsStore({ fs, path: PATH, dir: DIR })

    expect(s.get()).toEqual({ ...APP_SETTINGS_DEFAULTS, display_mode: 'ShowAll' })
    s.apply({ tail_snap_enabled: false })

    const persisted = JSON.parse(files.get(PATH)!) as Record<string, unknown>
    expect(persisted).not.toHaveProperty('media_pool_drawer_open')
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

  it('preview_snap_strength clamps to [2, 80], independently of the timeline pair', () => {
    expect(store().apply({ preview_snap_strength_px: 0 }).preview_snap_strength_px).toBe(2)
    expect(store().apply({ preview_snap_strength_px: 200 }).preview_snap_strength_px).toBe(80)
    // The two domains have their own dials: turning one off leaves the other be.
    const after = store().apply({ preview_snap_enabled: false })
    expect(after.preview_snap_enabled).toBe(false)
    expect(after.tail_snap_enabled).toBe(true)
  })

  it('prebake_motifs / preview_effects_enabled round-trip', () => {
    expect(store().get().prebake_motifs).toBe(false)
    expect(store().apply({ prebake_motifs: true }).prebake_motifs).toBe(true)
    expect(store().get().preview_effects_enabled).toBe(true)
    expect(store().apply({ preview_effects_enabled: false }).preview_effects_enabled).toBe(false)
  })

  it('decode_engine defaults to auto, round-trips, and ignores unrecognized on-disk values', () => {
    expect(store().get().decode_engine).toBe('auto')
    expect(store().apply({ decode_engine: 'ffmpeg' }).decode_engine).toBe('ffmpeg')
    expect(store().apply({ decode_engine: 'webcodecs' }).decode_engine).toBe('webcodecs')
    // A pre-existing app_settings.json holding the field's old shape (a
    // boolean, or any other unrecognized value) falls back to the default.
    const s = store({ [PATH]: '{ "decode_engine": true }' })
    expect(s.get().decode_engine).toBe('auto')
  })

  it("migrates a persisted decode_engine 'native' to 'ffmpeg'", () => {
    const s = store({ [PATH]: '{ "decode_engine": "native" }' })
    expect(s.get().decode_engine).toBe('ffmpeg')
  })

  it("accepts 'ffmpeg' | 'webcodecs' | 'auto' and defaults other on-disk values to auto", () => {
    expect(store({ [PATH]: '{ "decode_engine": "ffmpeg" }' }).get().decode_engine).toBe('ffmpeg')
    expect(store({ [PATH]: '{ "decode_engine": "webcodecs" }' }).get().decode_engine).toBe('webcodecs')
    expect(store({ [PATH]: '{ "decode_engine": "auto" }' }).get().decode_engine).toBe('auto')
    expect(store({ [PATH]: '{ "decode_engine": "bogus" }' }).get().decode_engine).toBe('auto')
  })

  it('playback_resolution defaults to full on a file written before the field existed', () => {
    expect(store({ [PATH]: '{ "display_mode": "ShowAll" }' }).get().playback_resolution).toBe('full')
    expect(store().get().playback_resolution).toBe('full')
    expect(store().apply({ playback_resolution: 'half' }).playback_resolution).toBe('half')
    expect(store().apply({ playback_resolution: 'quarter' }).playback_resolution).toBe('quarter')
    // Hand-edited / wrong-typed values degrade the same way.
    expect(store({ [PATH]: '{ "playback_resolution": "eighth" }' }).get().playback_resolution).toBe('full')
    expect(store({ [PATH]: '{ "playback_resolution": 2 }' }).get().playback_resolution).toBe('full')
  })

  it('media_pool_layout defaults to large on a file written before the field existed', () => {
    // Same additive-field trap as playback_resolution: an existing
    // app_settings.json has no key, and the renderer switches on the value —
    // undefined there would silently drop every layout class.
    expect(store({ [PATH]: '{ "display_mode": "ShowAll" }' }).get().media_pool_layout).toBe('large')
    expect(store().get().media_pool_layout).toBe('large')
    expect(store().apply({ media_pool_layout: 'grid' }).media_pool_layout).toBe('grid')
    expect(store().apply({ media_pool_layout: 'list' }).media_pool_layout).toBe('list')
    // Hand-edited / wrong-typed values degrade the same way.
    expect(store({ [PATH]: '{ "media_pool_layout": "mosaic" }' }).get().media_pool_layout).toBe('large')
    expect(store({ [PATH]: '{ "media_pool_layout": 3 }' }).get().media_pool_layout).toBe('large')
  })

  it('timeline_follow_playhead defaults to ON on a file written before the field existed', () => {
    // The additive-boolean trap: an absent key must NOT read as false, or every
    // existing install silently loses the feature it never turned off.
    expect(store({ [PATH]: '{ "display_mode": "ShowAll" }' }).get().timeline_follow_playhead).toBe(true)
    expect(store().get().timeline_follow_playhead).toBe(true)
    expect(store().apply({ timeline_follow_playhead: false }).timeline_follow_playhead).toBe(false)
    expect(store({ [PATH]: '{ "timeline_follow_playhead": false }' }).get().timeline_follow_playhead).toBe(false)
    // Hand-edited / wrong-typed values degrade to the default.
    expect(store({ [PATH]: '{ "timeline_follow_playhead": "yes" }' }).get().timeline_follow_playhead).toBe(true)
  })

  it('data_root round-trips, and empty/missing/corrupt degrades to unset', () => {
    // No file → unset (resolver substitutes the default).
    expect(store().get().data_root).toBeUndefined()

    const { fs, files } = memFs()
    const s = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    // Set + read back through an independent reader (persisted, not in-memory).
    expect(s.apply({ data_root: '/mnt/media/weft' }).data_root).toBe('/mnt/media/weft')
    expect(createAppSettingsStore({ fs, path: PATH, dir: DIR }).get().data_root).toBe('/mnt/media/weft')
    expect(JSON.parse(files.get(PATH)!).data_root).toBe('/mnt/media/weft')

    // Empty string clears it back to unset, and is not left on disk.
    expect(s.apply({ data_root: '' }).data_root).toBeUndefined()
    expect(JSON.parse(files.get(PATH)!)).not.toHaveProperty('data_root')

    // Wrong-typed / whitespace-only on-disk values degrade to unset (no throw).
    expect(store({ [PATH]: '{ "data_root": 123 }' }).get().data_root).toBeUndefined()
    expect(store({ [PATH]: '{ "data_root": "   " }' }).get().data_root).toBeUndefined()
  })

  it('language round-trips, and empty/missing/corrupt degrades to unset', () => {
    // No file → unset (the renderer auto-detects the OS language on first run).
    expect(store().get().language).toBeUndefined()

    const { fs, files } = memFs()
    const s = createAppSettingsStore({ fs, path: PATH, dir: DIR })
    // Set + read back through an independent (persisted) reader.
    expect(s.apply({ language: 'zh-CN' }).language).toBe('zh-CN')
    expect(createAppSettingsStore({ fs, path: PATH, dir: DIR }).get().language).toBe('zh-CN')
    expect(JSON.parse(files.get(PATH)!).language).toBe('zh-CN')

    // Empty string clears it back to unset, and is not left on disk.
    expect(s.apply({ language: '' }).language).toBeUndefined()
    expect(JSON.parse(files.get(PATH)!)).not.toHaveProperty('language')

    // Wrong-typed / whitespace-only on-disk values degrade to unset (no throw).
    expect(store({ [PATH]: '{ "language": 5 }' }).get().language).toBeUndefined()
    expect(store({ [PATH]: '{ "language": "   " }' }).get().language).toBeUndefined()
  })
})
