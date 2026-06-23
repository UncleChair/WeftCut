// apps/desktop/src/main/state/__tests__/commands.test.ts
// Unit tests for production param builders in commands.ts.
// TDD: written to fail before the exports exist; green after Step 3 impl.
import { describe, it, expect } from 'vitest'
import { prodColorParams, prodTextParams, prodMediaLayer, resolveDurationUs, demoColor, pickFreeOverlayTrack, PRODUCTION_OPS } from '../commands'
import type { Project } from '../model'

// ── PRODUCTION_OPS coverage assertion ────────────────────────────────────────
// Pins the exact set of renderer channels the production adapter handles.
// If this fails, a channel was added or removed unintentionally — do NOT
// silently update the expected list; investigate first.
describe('PRODUCTION_OPS', () => {
  it('contains exactly the 31 in-scope renderer channels', () => {
    const expected = [
      'add_color_layer', 'add_demo_color_layer', 'add_demo_text_layer', 'add_effect',
      'add_media_layer', 'add_text_layer', 'add_track', 'delete_layer', 'duplicate_layer',
      'fit_composition_to_layers', 'groups_create', 'groups_dissolve', 'move_effect',
      'move_layer', 'project_redo', 'project_undo', 'remove_effect', 'restyle_caption_track',
      'separate_audio_to_new_track', 'set_composition', 'set_role_gain', 'split_layer_grouped',
      'trim_layer', 'update_effect', 'update_layer', 'update_layer_param_track',
      'update_layer_param_tracks', 'update_layer_params', 'update_project_settings',
      'update_role_flags', 'update_track_flags',
    ].sort()
    expect([...PRODUCTION_OPS].sort()).toEqual(expected)
  })
})

// ── prodColorParams ───────────────────────────────────────────────────────
describe('prodColorParams', () => {
  it('defaults to BLACK + composition size', () => {
    const p = prodColorParams({}, { width: 1920, height: 1080 })
    expect(p).toMatchObject({
      kind: 'Color',
      color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } },
      width: 1920,
      height: 1080,
    })
  })

  it('passes through explicit color', () => {
    const p = prodColorParams({ color: { r: 255, g: 0, b: 0, a: 255 } }, { width: 1920, height: 1080 })
    expect(p).toMatchObject({ color: { mode: 'Static', value: { r: 255, g: 0, b: 0, a: 255 } } })
  })

  it('passes through explicit width/height', () => {
    const p = prodColorParams({ width: 1280, height: 720 }, { width: 1920, height: 1080 })
    expect(p).toMatchObject({ width: 1280, height: 720 })
  })
})

// ── prodTextParams ────────────────────────────────────────────────────────
describe('prodTextParams', () => {
  it('defaults to Arial 72 DrawText content="Text"', () => {
    const p = prodTextParams({}) as Extract<ReturnType<typeof prodTextParams>, { kind: 'Text' }>
    expect(p.kind).toBe('Text')
    expect(p.content).toBe('Text')
    expect(p.font).toEqual({ family: 'Arial', size_px: 72, weight: 400, italic: false })
    expect(p.backend_hint).toBe('DrawText')
    expect(p.color).toEqual({ mode: 'Static', value: { r: 255, g: 255, b: 255, a: 255 } })
    expect(p.align).toBe('Center')
  })

  it('passes through explicit content', () => {
    const p = prodTextParams({ content: 'Hello World' }) as Extract<ReturnType<typeof prodTextParams>, { kind: 'Text' }>
    expect(p.content).toBe('Hello World')
  })
})

// ── resolveDurationUs ─────────────────────────────────────────────────────
describe('resolveDurationUs', () => {
  it('defaults to 5s', () => {
    expect(resolveDurationUs(undefined)).toBe(5_000_000)
  })
  it('passes through explicit value above floor', () => {
    expect(resolveDurationUs(2_000_000)).toBe(2_000_000)
  })
  it('enforces 100ms floor', () => {
    expect(resolveDurationUs(0)).toBe(100_000)
    expect(resolveDurationUs(50_000)).toBe(100_000)
  })
})

// ── demoColor ─────────────────────────────────────────────────────────────
describe('demoColor', () => {
  it('returns sky blue for index 0', () => {
    expect(demoColor(0)).toEqual({ r: 96, g: 165, b: 250, a: 255 })
  })
  it('cycles at 6', () => {
    expect(demoColor(6)).toEqual(demoColor(0))
    expect(demoColor(7)).toEqual(demoColor(1))
  })
})

// ── prodMediaLayer ────────────────────────────────────────────────────────
function makeProject(overrides?: Partial<Project>): Project {
  const base: Project = {
    schema_version: 9, project_id: 'proj',
    metadata: { name: 'test', created_at: '', modified_at: '', description: null },
    composition: { width: 1920, height: 1080, fps: { num: 30, den: 1 }, duration_us: 0,
      duration_pinned: false, sample_rate: 48000, channels: 2, color_space: 'Bt709',
      background: { r: 0, g: 0, b: 0, a: 255 } },
    media_pool: {}, tracks: [], markers: [], transitions: [], groups: [], audio_roles: {},
    settings: { preview_width: 1280, preview_height: 720, autosave_interval_secs: 60,
      history_capacity: 200, auto_pair_audio_on_import: true, auto_delete_empty_tracks: true },
    ...overrides,
  }
  return base
}

describe('prodMediaLayer', () => {
  it('video: durationUs = media duration', () => {
    const p = makeProject({ media_pool: { 'vid': { id: 'vid', label: null, path_abs: '', path_rel: null,
      kind: 'Video', metadata: { duration_us: 5_000_000, video: null, audio: null, container_format: null },
      file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '',
      proxy_path: null, quick_proxy_path: null, proxy_bypassed: false,
      export_uses_original: false, proxy_format_version: 0, conform_path: null,
      waveform_path: null, thumbnails_dir: null } } })
    const r = prodMediaLayer({ mediaId: 'vid' }, p)
    expect(r.durationUs).toBe(5_000_000)
    expect(r.params.kind).toBe('VideoClip')
  })

  it('video: defaults to 2s when duration_us null', () => {
    const p = makeProject({ media_pool: { 'vid': { id: 'vid', label: null, path_abs: '', path_rel: null,
      kind: 'Video', metadata: { duration_us: null, video: null, audio: null, container_format: null },
      file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '',
      proxy_path: null, quick_proxy_path: null, proxy_bypassed: false,
      export_uses_original: false, proxy_format_version: 0, conform_path: null,
      waveform_path: null, thumbnails_dir: null } } })
    const r = prodMediaLayer({ mediaId: 'vid' }, p)
    expect(r.durationUs).toBe(2_000_000)
  })

  it('audio: role=music in params', () => {
    const p = makeProject({ media_pool: { 'aud': { id: 'aud', label: null, path_abs: '', path_rel: null,
      kind: 'Audio', metadata: { duration_us: 3_000_000, video: null, audio: null, container_format: null },
      file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '',
      proxy_path: null, quick_proxy_path: null, proxy_bypassed: false,
      export_uses_original: false, proxy_format_version: 0, conform_path: null,
      waveform_path: null, thumbnails_dir: null } } })
    const r = prodMediaLayer({ mediaId: 'aud' }, p)
    expect(r.params.kind).toBe('Audio')
    if (r.params.kind === 'Audio') expect(r.params.role).toBe('music')
  })

  it('image: still defaults to 3s', () => {
    const p = makeProject({ media_pool: { 'img': { id: 'img', label: null, path_abs: '', path_rel: null,
      kind: 'Image', metadata: { duration_us: null, video: null, audio: null, container_format: null },
      file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '',
      proxy_path: null, quick_proxy_path: null, proxy_bypassed: false,
      export_uses_original: false, proxy_format_version: 0, conform_path: null,
      waveform_path: null, thumbnails_dir: null } } })
    const r = prodMediaLayer({ mediaId: 'img' }, p)
    expect(r.params.kind).toBe('ImageOverlay')
    expect(r.durationUs).toBe(3_000_000)
  })
})

// ── pickFreeOverlayTrack ──────────────────────────────────────────────────
describe('pickFreeOverlayTrack', () => {
  it('returns null when no non-reserved tracks', () => {
    const p = makeProject({ tracks: [
      { id: 'a', label: 'A roll', enabled: true, locked: false, muted: false, solo: false,
        removable: false, role: 'ARoll', transient: false, height_px: 64, layers: [] },
    ] })
    expect(pickFreeOverlayTrack(p, 0, 5_000_000)).toBeNull()
  })

  it('returns last non-reserved track with no overlap', () => {
    const p = makeProject({ tracks: [
      { id: 'a', label: 'A roll', enabled: true, locked: false, muted: false, solo: false,
        removable: false, role: 'ARoll', transient: false, height_px: 64, layers: [] },
      { id: 't1', label: 'T1', enabled: true, locked: false, muted: false, solo: false,
        removable: true, role: null, transient: false, height_px: 64, layers: [] },
    ] })
    expect(pickFreeOverlayTrack(p, 0, 5_000_000)).toBe('t1')
  })
})
