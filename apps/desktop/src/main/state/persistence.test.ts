import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject, SCHEMA_VERSION } from './model'
import type { MediaItem, Project } from './model'
import { canonicalString } from './canonical'
import { serializeProject } from './serialize'
import { serializeProjectToJson, schemaGate, parseProjectJson, reconcileMediaPaths, clearSessionQuickProxies, loadProjectFromJson } from './persistence'

describe('serializeProjectToJson (mirror io/mod.rs:25 to_string_pretty)', () => {
  it('pretty-prints with 2-space indent and no trailing newline', () => {
    const p = blankProject(seededGen(), 'doc')
    const json = serializeProjectToJson(p)
    expect(json.startsWith(`{\n  "schema_version": ${SCHEMA_VERSION}`)).toBe(true)
    expect(json.endsWith('\n')).toBe(false)
    expect(json.includes('\n    ')).toBe(true) // nested 4-space level exists
  })
  it('round-trips through parseProjectJson canonically', () => {
    const p = blankProject(seededGen(), 'doc')
    const back = parseProjectJson(serializeProjectToJson(p))
    expect(canonicalString(serializeProject(back))).toBe(canonicalString(serializeProject(p)))
  })
})

describe('schemaGate (mirror io/migrate.rs:20 run)', () => {
  it('accepts the current schema version', () => {
    expect(() => schemaGate({ schema_version: SCHEMA_VERSION })).not.toThrow()
  })
  it('rejects an older version with fresh-workspace guidance', () => {
    expect(() => schemaGate({ schema_version: SCHEMA_VERSION - 1 }))
      .toThrow(/below the supported minimum.*fresh workspace/s)
  })
  it('rejects a newer version with update-the-app guidance', () => {
    expect(() => schemaGate({ schema_version: SCHEMA_VERSION + 5 }))
      .toThrow(/newer than this build.*Update the app/s)
  })
  it('rejects a non-numeric / absent version', () => {
    expect(() => schemaGate({})).toThrow(/schema/i)
  })
})

describe('parseProjectJson', () => {
  it('throws on malformed JSON', () => {
    expect(() => parseProjectJson('{not json')).toThrow()
  })
  it('throws on a wrong schema version (gate before cast)', () => {
    const p = blankProject(seededGen(), 'doc')
    const bad = JSON.stringify({ ...(serializeProject(p) as object), schema_version: 8 })
    expect(() => parseProjectJson(bad)).toThrow(/below the supported minimum/)
  })
})

const posixJoin = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/')

function mediaItem(over: Partial<MediaItem>): MediaItem {
  return {
    id: '00000000-0000-0000-0000-0000000000aa', label: null,
    path_abs: '/saved/at/Media/clip.mp4', path_rel: 'Media/clip.mp4', kind: 'Video',
    metadata: { duration_us: 1_000_000 }, file_hash_blake3: 'deadbeef', file_size: 0, file_mtime: 0,
    imported_at: '2026-01-01T00:00:00Z', decode_route: { route: 'bypass' },
    conform_path: null, waveform_path: null, thumbnails_dir: null, ...over,
  }
}
function withMedia(items: MediaItem[]): Project {
  return {
    schema_version: 10, project_id: 'p', metadata: { name: 'm', created_at: '<TS>', modified_at: '<TS>', description: null },
    composition: { width: 1920, height: 1080, fps: { num: 30, den: 1 }, duration_us: 0, duration_pinned: false,
      sample_rate: 48000, channels: 2, color_space: 'Bt709', background: { r: 0, g: 0, b: 0, a: 255 } },
    media_pool: Object.fromEntries(items.map((i) => [i.id, i])), tracks: [], markers: [],
    transitions: [], groups: [], audio_roles: {},
    settings: { preview_width: 1280, preview_height: 720, autosave_interval_secs: 60, history_capacity: 200, auto_pair_audio_on_import: true, auto_delete_empty_tracks: true },
  }
}

describe('reconcileMediaPaths (mirror io/mod.rs:73 path_abs ← dir.join(path_rel))', () => {
  it('rewrites path_abs from path_rel against the new workspace dir', () => {
    const p = withMedia([mediaItem({ path_rel: 'Media/clip.mp4', path_abs: '/old/Media/clip.mp4' })])
    const out = reconcileMediaPaths(p, '/new/ws.vproj', posixJoin)
    expect(out.media_pool['00000000-0000-0000-0000-0000000000aa'].path_abs).toBe('/new/ws.vproj/Media/clip.mp4')
  })
  it('leaves path_abs alone when path_rel is null (pending import / synthesized media)', () => {
    const p = withMedia([mediaItem({ path_rel: null, path_abs: '/external/source/video.mp4' })])
    const out = reconcileMediaPaths(p, '/new/ws.vproj', posixJoin)
    expect(out.media_pool['00000000-0000-0000-0000-0000000000aa'].path_abs).toBe('/external/source/video.mp4')
  })
})

describe('clearSessionQuickProxies', () => {
  it('nulls the route quick_proxy slot and reports the file to delete', () => {
    const p = withMedia([mediaItem({ decode_route: { route: 'direct-export', quick_proxy: '/ws/clip.quick.mp4' } })])
    const { project, quickProxiesToDelete } = clearSessionQuickProxies(p)
    const r = project.media_pool['00000000-0000-0000-0000-0000000000aa'].decode_route
    expect(r).toEqual({ route: 'direct-export', quick_proxy: null })
    expect(quickProxiesToDelete).toEqual(['/ws/clip.quick.mp4'])
  })
  it('preserves the full proxy slot while clearing the quick on a Proxied route', () => {
    const p = withMedia([mediaItem({ decode_route: { route: 'proxied', quick_proxy: '/ws/clip.quick.mp4', full_proxy: '/ws/clip.master.mp4', format_version: 2 } })])
    const { project, quickProxiesToDelete } = clearSessionQuickProxies(p)
    expect(project.media_pool['00000000-0000-0000-0000-0000000000aa'].decode_route)
      .toEqual({ route: 'proxied', quick_proxy: null, full_proxy: '/ws/clip.master.mp4', format_version: 2 })
    expect(quickProxiesToDelete).toEqual(['/ws/clip.quick.mp4'])
  })
  it('reports nothing when no quick proxies are set', () => {
    expect(clearSessionQuickProxies(withMedia([mediaItem({ decode_route: { route: 'bypass' } })])).quickProxiesToDelete).toEqual([])
  })
})

describe('loadProjectFromJson', () => {
  it('parses, reconciles, and clears quick proxies in one pass', () => {
    const p = withMedia([mediaItem({ path_rel: 'Media/clip.mp4', path_abs: '/old/Media/clip.mp4', decode_route: { route: 'direct-export', quick_proxy: '/old/clip.quick.mp4' } })])
    const text = JSON.stringify(p)
    const { project, quickProxiesToDelete } = loadProjectFromJson(text, { dir: '/moved.vproj', join: posixJoin })
    const m = project.media_pool['00000000-0000-0000-0000-0000000000aa']
    expect(m.path_abs).toBe('/moved.vproj/Media/clip.mp4')
    expect(m.decode_route).toEqual({ route: 'direct-export', quick_proxy: null })
    expect(quickProxiesToDelete).toEqual(['/old/clip.quick.mp4'])
  })
})
