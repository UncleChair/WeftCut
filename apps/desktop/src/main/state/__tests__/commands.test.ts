// apps/desktop/src/main/state/__tests__/commands.test.ts
// Unit tests for production param builders in commands.ts.
import { describe, it, expect } from 'vitest'
import { prodColorParams, prodTextParams, prodMediaLayer, resolveDurationUs, demoColor, pickFreeOverlayTrack, PRODUCTION_OPS, parseMechanical } from '../commands'
import type { Project } from '../model'
import { createActor } from '../actor'
import { blankProject } from '../model'
import { seededGen } from '../ids'

// ── PRODUCTION_OPS coverage assertion ────────────────────────────────────────
// Pins the exact set of renderer channels the production adapter handles.
// If this fails, a channel was added or removed unintentionally — do NOT
// silently update the expected list; investigate first.
describe('PRODUCTION_OPS', () => {
  it('contains exactly the 44 in-scope renderer channels', () => {
    const expected = [
      'add_color_layer', 'add_demo_color_layer', 'add_demo_text_layer', 'add_effect',
      'add_media_layer', 'add_motif', 'add_text_layer', 'add_track', 'add_transition',
      'delete_layer', 'duplicate_layer',
      'fit_composition_to_layers', 'groups_create', 'groups_dissolve', 'move_effect',
      'move_layer', 'move_layers_to_new_track', 'paste_layer',
      'project_create_checkpoint', 'project_delete_checkpoint',
      'project_jump_to', 'project_redo', 'project_restore_checkpoint', 'project_undo',
      'remove_effect', 'remove_media', 'remove_transition', 'rename_track', 'restyle_captions',
      'separate_audio_to_new_track', 'set_composition', 'set_role_gain', 'set_scale_linked', 'split_layer_grouped',
      'trim_layer', 'update_effect', 'update_layer', 'update_layer_param_track',
      'update_layer_param_tracks', 'update_layer_params', 'update_project_settings',
      'update_role_flags', 'update_track_flags', 'update_transition',
    ].sort()
    expect([...PRODUCTION_OPS].sort()).toEqual(expected)
  })
})

describe('parseMechanical media removal', () => {
  it('maps the guarded and forced renderer paths to remove_media', () => {
    expect(parseMechanical('remove_media', { mediaId: 'media-1' })).toEqual({
      op: 'remove_media',
      args: { media: 'media-1', force: false },
    })
    expect(parseMechanical('remove_media', { mediaId: 'media-1', force: true })).toEqual({
      op: 'remove_media',
      args: { media: 'media-1', force: true },
    })
  })
})

// ── transition channels: camelCase wire args → actor op args ────────────────
// Pure mechanical renaming; kind/direction pass through untouched (the actor's
// parseTransitionKind owns pairing validation — Crossfade rejects a direction,
// Wipe/Slide require one).
describe('parseMechanical transitions', () => {
  it('add_transition maps from/to/duration and passes kind+direction through', () => {
    expect(
      parseMechanical('add_transition', {
        fromLayerId: 'from-1', toLayerId: 'to-1', durationUs: 1_000_000,
        kind: 'Wipe', direction: 'left',
      }),
    ).toEqual({
      op: 'add_transition',
      args: { from: 'from-1', to: 'to-1', duration_us: 1_000_000, kind: 'Wipe', direction: 'left' },
    })
  })

  it('add_transition leaves an omitted direction undefined (Crossfade case)', () => {
    const mech = parseMechanical('add_transition', {
      fromLayerId: 'from-1', toLayerId: 'to-1', durationUs: 500_000, kind: 'Crossfade',
    })
    expect(mech?.args.direction).toBeUndefined()
    expect(mech?.args.kind).toBe('Crossfade')
  })

  it('update_transition maps transitionId and passes the optional trio through', () => {
    expect(
      parseMechanical('update_transition', {
        transitionId: 'tr-1', durationUs: 750_000, kind: 'Slide', direction: 'up',
      }),
    ).toEqual({
      op: 'update_transition',
      args: { transition: 'tr-1', duration_us: 750_000, kind: 'Slide', direction: 'up' },
    })
    const durationOnly = parseMechanical('update_transition', { transitionId: 'tr-1', durationUs: 250_000 })
    expect(durationOnly?.args).toEqual({ transition: 'tr-1', duration_us: 250_000, kind: undefined, direction: undefined })
  })

  it('remove_transition maps transitionId', () => {
    expect(parseMechanical('remove_transition', { transitionId: 'tr-1' })).toEqual({
      op: 'remove_transition',
      args: { transition: 'tr-1' },
    })
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
    schema_version: 10, project_id: 'proj',
    metadata: { name: 'test', created_at: '', modified_at: '', description: null },
    composition: { width: 1920, height: 1080, fps: { num: 30, den: 1 }, duration_us: 0,
      duration_pinned: false, sample_rate: 48000, channels: 2, color_space: 'Bt709',
      background: { r: 0, g: 0, b: 0, a: 255 } },
    media_pool: {}, tracks: [], markers: [], transitions: [], groups: [], audio_roles: {},
    settings: { preview_width: 1280, preview_height: 720, autosave_interval_secs: 60,
      history_capacity: 200, auto_pair_audio_on_import: true,
      prefer_proxies: false, proxy_overrides: {} },
    ...overrides,
  }
  return base
}

describe('prodMediaLayer', () => {
  it('video: durationUs = media duration', () => {
    const p = makeProject({ media_pool: { 'vid': { id: 'vid', label: null, path_abs: '', path_rel: null,
      kind: 'Video', metadata: { duration_us: 5_000_000, video: null, audio: null, container_format: null },
      file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '',
      decode_route: { route: 'bypass' }, conform_path: null,
      waveform_path: null, thumbnails_dir: null } } })
    const r = prodMediaLayer({ mediaId: 'vid' }, p)
    expect(r.durationUs).toBe(5_000_000)
    expect(r.params.kind).toBe('VideoClip')
  })

  it('video: defaults to 2s when duration_us null', () => {
    const p = makeProject({ media_pool: { 'vid': { id: 'vid', label: null, path_abs: '', path_rel: null,
      kind: 'Video', metadata: { duration_us: null, video: null, audio: null, container_format: null },
      file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '',
      decode_route: { route: 'bypass' }, conform_path: null,
      waveform_path: null, thumbnails_dir: null } } })
    const r = prodMediaLayer({ mediaId: 'vid' }, p)
    expect(r.durationUs).toBe(2_000_000)
  })

  it('audio: role=music in params', () => {
    const p = makeProject({ media_pool: { 'aud': { id: 'aud', label: null, path_abs: '', path_rel: null,
      kind: 'Audio', metadata: { duration_us: 3_000_000, video: null, audio: null, container_format: null },
      file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '',
      decode_route: { route: 'bypass' }, conform_path: null,
      waveform_path: null, thumbnails_dir: null } } })
    const r = prodMediaLayer({ mediaId: 'aud' }, p)
    expect(r.params.kind).toBe('Audio')
    if (r.params.kind === 'Audio') expect(r.params.role).toBe('music')
  })

  it('image: still defaults to 3s', () => {
    const p = makeProject({ media_pool: { 'img': { id: 'img', label: null, path_abs: '', path_rel: null,
      kind: 'Image', metadata: { duration_us: null, video: null, audio: null, container_format: null },
      file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '',
      decode_route: { route: 'bypass' }, conform_path: null,
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
      { id: 'a', label: null, enabled: true, locked: false, muted: false, solo: false,
        removable: false, role: 'ARoll', transient: false, height_px: 64, layers: [] },
    ] })
    expect(pickFreeOverlayTrack(p, 0, 5_000_000)).toBeNull()
  })

  it('returns last non-reserved track with no overlap', () => {
    const p = makeProject({ tracks: [
      { id: 'a', label: null, enabled: true, locked: false, muted: false, solo: false,
        removable: false, role: 'ARoll', transient: false, height_px: 64, layers: [] },
      { id: 't1', label: 'T1', enabled: true, locked: false, muted: false, solo: false,
        removable: true, role: null, transient: false, height_px: 64, layers: [] },
    ] })
    expect(pickFreeOverlayTrack(p, 0, 5_000_000)).toBe('t1')
  })
})

// ── add_media_layer auto-pair ─────────────────────
describe('add_media_layer auto-pair', () => {
  function makeActorWithMedia(withAudio: boolean, autoPairSetting = true) {
    const idGen = seededGen()
    const initial = blankProject(idGen, 'test')
    // Override setting if needed (blankProject defaults auto_pair_audio_on_import: true)
    if (!autoPairSetting) initial.settings.auto_pair_audio_on_import = false
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    // Use a fixed media id separate from idGen chain; template produces audio block when withAudio=true
    const mediaId = '11111111-1111-1111-1111-111111111111' as const
    actor.dispatch('add_media', { id: mediaId, kind: 'Video', duration_us: 4_000_000, with_audio: withAudio })
    return { actor, mediaId, aRollId: initial.tracks[0].id }
  }

  it('video+audio: track has a VideoClip and Audio(role=dialogue) layer at same span', () => {
    const { actor, mediaId, aRollId } = makeActorWithMedia(true)
    const r = actor.command('add_media_layer', { trackId: aRollId, mediaId, tStartUs: 0 })
    expect(r.ok).toBe(true)
    const snap = actor.snapshot()
    const track = snap.tracks.find((t) => t.id === aRollId)!
    expect(track.layers).toHaveLength(2)
    const vid = track.layers.find((l) => l.params.kind === 'VideoClip')!
    const aud = track.layers.find((l) => l.params.kind === 'Audio')!
    expect(vid).toBeDefined()
    expect(aud).toBeDefined()
    // Both layers span the full media duration
    expect(vid.t_start_us).toBe(0)
    expect(vid.t_end_us).toBe(4_000_000)
    expect(aud.t_start_us).toBe(0)
    expect(aud.t_end_us).toBe(4_000_000)
    // Paired audio has role=dialogue (kebab-case)
    if (aud.params.kind === 'Audio') expect(aud.params.role).toBe('dialogue')
  })

  it('video+audio: exactly one group contains both the video and audio layer ids', () => {
    const { actor, mediaId, aRollId } = makeActorWithMedia(true)
    const r = actor.command('add_media_layer', { trackId: aRollId, mediaId, tStartUs: 0 })
    expect(r.ok).toBe(true)
    const snap = actor.snapshot()
    const track = snap.tracks.find((t) => t.id === aRollId)!
    const vidId = track.layers.find((l) => l.params.kind === 'VideoClip')!.id
    const audId = track.layers.find((l) => l.params.kind === 'Audio')!.id
    // groups_create([videoId, audioId]) produces exactly one group with both members
    const groups = snap.groups.filter((g) => g.members.includes(vidId) && g.members.includes(audId))
    expect(groups).toHaveLength(1)
    // snapshot is immer-frozen: spread before sorting to avoid mutation error
    expect([...groups[0].members].sort()).toEqual([vidId, audId].sort())
  })

  it('video-only media (no audio): no pair, single layer, no group', () => {
    const { actor, mediaId, aRollId } = makeActorWithMedia(false)
    const r = actor.command('add_media_layer', { trackId: aRollId, mediaId, tStartUs: 0 })
    expect(r.ok).toBe(true)
    const snap = actor.snapshot()
    const track = snap.tracks.find((t) => t.id === aRollId)!
    expect(track.layers).toHaveLength(1)
    expect(track.layers[0].params.kind).toBe('VideoClip')
    expect(snap.groups).toHaveLength(0)
  })

  it('auto_pair_audio_on_import=false: no pair even when media has audio', () => {
    const { actor, mediaId, aRollId } = makeActorWithMedia(true, false)
    const r = actor.command('add_media_layer', { trackId: aRollId, mediaId, tStartUs: 0 })
    expect(r.ok).toBe(true)
    const snap = actor.snapshot()
    const track = snap.tracks.find((t) => t.id === aRollId)!
    expect(track.layers).toHaveLength(1)
    expect(snap.groups).toHaveLength(0)
  })

  it('prodMediaLayer: autoPairAudio is non-null only when media has audio and setting on', () => {
    // Video with audio metadata + setting on → autoPairAudio populated
    const p1 = makeProject({ media_pool: { 'vid': { id: 'vid', label: null, path_abs: '', path_rel: null,
      kind: 'Video', metadata: { duration_us: 4_000_000, video: null,
        audio: { sample_rate: 0, channels: 0, codec: '' }, container_format: null },
      file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '',
      decode_route: { route: 'bypass' }, conform_path: null,
      waveform_path: null, thumbnails_dir: null } } })
    const r1 = prodMediaLayer({ mediaId: 'vid' }, p1)
    expect(r1.autoPairAudio).not.toBeNull()
    if (r1.autoPairAudio && r1.autoPairAudio.kind === 'Audio') {
      expect(r1.autoPairAudio.role).toBe('dialogue')
    }

    // Video without audio metadata → autoPairAudio null
    const p2 = makeProject({ media_pool: { 'vid': { id: 'vid', label: null, path_abs: '', path_rel: null,
      kind: 'Video', metadata: { duration_us: 4_000_000, video: null, audio: null, container_format: null },
      file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '',
      decode_route: { route: 'bypass' }, conform_path: null,
      waveform_path: null, thumbnails_dir: null } } })
    const r2 = prodMediaLayer({ mediaId: 'vid' }, p2)
    expect(r2.autoPairAudio).toBeNull()

    // Video with audio but setting off → autoPairAudio null
    const p3 = makeProject({ media_pool: { 'vid': { id: 'vid', label: null, path_abs: '', path_rel: null,
      kind: 'Video', metadata: { duration_us: 4_000_000, video: null,
        audio: { sample_rate: 0, channels: 0, codec: '' }, container_format: null },
      file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '',
      decode_route: { route: 'bypass' }, conform_path: null,
      waveform_path: null, thumbnails_dir: null } },
      settings: { preview_width: 1280, preview_height: 720, autosave_interval_secs: 60,
        history_capacity: 200, auto_pair_audio_on_import: false,
        prefer_proxies: false, proxy_overrides: {} } })
    const r3 = prodMediaLayer({ mediaId: 'vid' }, p3)
    expect(r3.autoPairAudio).toBeNull()
  })
})
