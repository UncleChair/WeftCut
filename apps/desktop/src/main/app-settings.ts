// App-level preferences persisted at <userData>/app_settings.json, owned by the
// Electron main process. One value across every project (no per-project override).
//
// The on-disk file path + JSON field names are a COMPATIBILITY SURFACE:
// existing users' app_settings.json files must keep loading, so neither may
// change without a migration.
//
// Bad-config recovery: a missing / empty / corrupt file degrades to
// all-defaults so a hand-edit mishap can't brick the editor.

import {
  APP_SETTINGS_DEFAULTS,
  DELTA_WINDOW_MIN_US, DELTA_WINDOW_MAX_US,
  TAIL_SNAP_STRENGTH_MIN_PX, TAIL_SNAP_STRENGTH_MAX_PX,
  type AppSettings, type AppSettingsPatch,
} from '../shared/app-settings'

/** Minimal fs surface — injected so tests run in-memory; node:fs in production. */
export interface AppSettingsFs {
  exists(path: string): boolean
  readFile(path: string): string
  writeFile(path: string, text: string): void
  rename(from: string, to: string): void
  mkdirp(dir: string): void
}

export interface AppSettingsStore {
  get(): AppSettings
  /** Apply a patch atomically; returns the post-patch settings. */
  apply(patch: AppSettingsPatch): AppSettings
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

export function createAppSettingsStore(deps: { fs: AppSettingsFs; path: string; dir: string }): AppSettingsStore {
  function read(): AppSettings {
    if (!deps.fs.exists(deps.path)) return { ...APP_SETTINGS_DEFAULTS }
    let body: string
    try { body = deps.fs.readFile(deps.path) }
    catch (e) { console.warn(`[app-settings] read ${deps.path}:`, e); return { ...APP_SETTINGS_DEFAULTS } }
    if (body.trim() === '') return { ...APP_SETTINGS_DEFAULTS }
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(body) as Record<string, unknown> }
    catch (e) { console.warn(`[app-settings] parse ${deps.path}:`, e); return { ...APP_SETTINGS_DEFAULTS } }
    // Per-field defaulting (parity with serde #[serde(default = ...)]): a missing
    // or wrong-typed field falls back to its default; unknown keys are ignored.
    const d = APP_SETTINGS_DEFAULTS
    return {
      display_mode: parsed.display_mode === 'ShowAll' || parsed.display_mode === 'AbRoll' ? parsed.display_mode : d.display_mode,
      delta_window_us: typeof parsed.delta_window_us === 'number' ? parsed.delta_window_us : d.delta_window_us,
      tail_snap_enabled: typeof parsed.tail_snap_enabled === 'boolean' ? parsed.tail_snap_enabled : d.tail_snap_enabled,
      tail_snap_strength_px: typeof parsed.tail_snap_strength_px === 'number' ? parsed.tail_snap_strength_px : d.tail_snap_strength_px,
      prebake_motifs: typeof parsed.prebake_motifs === 'boolean' ? parsed.prebake_motifs : d.prebake_motifs,
      preview_effects_enabled: typeof parsed.preview_effects_enabled === 'boolean' ? parsed.preview_effects_enabled : d.preview_effects_enabled,
      // 'native' was the persisted value's old name (pre-rename); migrate it
      // to 'ffmpeg' on load so pre-existing app_settings.json files keep
      // resolving to the same engine instead of silently falling back to
      // the default.
      decode_engine:
        parsed.decode_engine === 'native' ? 'ffmpeg'
        : parsed.decode_engine === 'ffmpeg' || parsed.decode_engine === 'webcodecs' || parsed.decode_engine === 'auto'
          ? parsed.decode_engine
          : d.decode_engine,
    }
  }

  function write(settings: AppSettings): void {
    deps.fs.mkdirp(deps.dir)
    const tmp = deps.path + '.tmp'
    deps.fs.writeFile(tmp, JSON.stringify(settings, null, 2))
    deps.fs.rename(tmp, deps.path) // atomic promote
  }

  return {
    get: read,
    apply(patch) {
      const current = read()
      if (patch.display_mode !== undefined) current.display_mode = patch.display_mode
      if (patch.delta_window_us !== undefined) current.delta_window_us = clamp(patch.delta_window_us, DELTA_WINDOW_MIN_US, DELTA_WINDOW_MAX_US)
      if (patch.tail_snap_enabled !== undefined) current.tail_snap_enabled = patch.tail_snap_enabled
      if (patch.tail_snap_strength_px !== undefined) current.tail_snap_strength_px = clamp(patch.tail_snap_strength_px, TAIL_SNAP_STRENGTH_MIN_PX, TAIL_SNAP_STRENGTH_MAX_PX)
      if (patch.prebake_motifs !== undefined) current.prebake_motifs = patch.prebake_motifs
      if (patch.preview_effects_enabled !== undefined) current.preview_effects_enabled = patch.preview_effects_enabled
      if (patch.decode_engine !== undefined) current.decode_engine = patch.decode_engine
      write(current)
      return current
    },
  }
}
