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
  PREVIEW_SNAP_STRENGTH_MIN_PX, PREVIEW_SNAP_STRENGTH_MAX_PX,
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
      // Additive pair: an app_settings.json predating preview snapping carries no
      // key here, so both MUST land on their defaults rather than undefined — the
      // settings UI reads the number straight into a slider, and the gizmo reads
      // the boolean as a gate.
      preview_snap_enabled: typeof parsed.preview_snap_enabled === 'boolean' ? parsed.preview_snap_enabled : d.preview_snap_enabled,
      preview_snap_strength_px: typeof parsed.preview_snap_strength_px === 'number' ? parsed.preview_snap_strength_px : d.preview_snap_strength_px,
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
      // Additive field: every app_settings.json written before it existed has
      // no key here, so an unrecognized/absent value MUST land on the default
      // ("full") rather than undefined — the renderer reads it straight into a
      // <select> value and a blank one renders an empty control.
      playback_resolution:
        parsed.playback_resolution === 'full' || parsed.playback_resolution === 'half' || parsed.playback_resolution === 'quarter'
          ? parsed.playback_resolution
          : d.playback_resolution,
      // Additive field, same trap as playback_resolution: files written before
      // it existed have no key — an absent/unrecognized value MUST land on the
      // default ("large") so the pool keeps its legacy card layout.
      media_pool_layout:
        parsed.media_pool_layout === 'large' || parsed.media_pool_layout === 'grid' || parsed.media_pool_layout === 'list'
          ? parsed.media_pool_layout
          : d.media_pool_layout,
      // Optional path; a non-string, empty, or whitespace-only value degrades to
      // unset (undefined) so the resolver falls back to the default root. Kept
      // out of the on-disk file when unset (JSON.stringify drops undefined).
      data_root:
        typeof parsed.data_root === 'string' && parsed.data_root.trim() !== ''
          ? parsed.data_root
          : d.data_root,
      // Optional locale code; a non-string / empty / whitespace-only value
      // degrades to unset (→ the renderer auto-detects the OS language). NOT
      // validated against the supported-locale set here — that list lives in
      // the renderer's i18n layer and i18next self-guards unknown codes, so
      // main stays decoupled from the UI locale set. Kept off disk when unset.
      language:
        typeof parsed.language === 'string' && parsed.language.trim() !== ''
          ? parsed.language
          : d.language,
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
      if (patch.preview_snap_enabled !== undefined) current.preview_snap_enabled = patch.preview_snap_enabled
      if (patch.preview_snap_strength_px !== undefined) current.preview_snap_strength_px = clamp(patch.preview_snap_strength_px, PREVIEW_SNAP_STRENGTH_MIN_PX, PREVIEW_SNAP_STRENGTH_MAX_PX)
      if (patch.prebake_motifs !== undefined) current.prebake_motifs = patch.prebake_motifs
      if (patch.preview_effects_enabled !== undefined) current.preview_effects_enabled = patch.preview_effects_enabled
      if (patch.decode_engine !== undefined) current.decode_engine = patch.decode_engine
      if (patch.playback_resolution !== undefined) current.playback_resolution = patch.playback_resolution
      if (patch.media_pool_layout !== undefined) current.media_pool_layout = patch.media_pool_layout
      // Empty / whitespace-only clears the field back to unset (→ default root);
      // any other value is stored verbatim. Storing undefined keeps it off disk.
      if (patch.data_root !== undefined) current.data_root = patch.data_root.trim() === '' ? undefined : patch.data_root
      // Empty / whitespace-only clears back to unset (→ auto-detect); any other
      // value stored verbatim. Storing undefined keeps it off disk.
      if (patch.language !== undefined) current.language = patch.language.trim() === '' ? undefined : patch.language
      write(current)
      return current
    },
  }
}
