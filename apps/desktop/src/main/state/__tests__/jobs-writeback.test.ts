import { describe, it, expect, vi } from 'vitest'
import { applyDerivativesEvent } from '../jobs-writeback'
import { createActor, type ActorHandle } from '../actor'
import { blankProject, type MediaItem, type Project } from '../model'
import { seededGen } from '../ids'

const MID = '00000000-0000-0000-0000-0000000000aa'

// Media starts on a Proxied route carrying an old full master, so the fold
// signals (full_proxy_landed set/clear) and a plain path option (conform) can
// all be exercised through the writeback adapter.
function actorWithMedia(): ActorHandle {
  const idGen = seededGen()
  const base = blankProject(idGen, 'p')
  const item: MediaItem = {
    id: MID, label: null, path_abs: '/ws/Media/clip.mp4', path_rel: 'Media/clip.mp4',
    kind: 'Video', metadata: { duration_us: 1_000_000 }, file_hash_blake3: 'x', file_size: 0, file_mtime: 0,
    imported_at: '2026-01-01T00:00:00Z',
    decode_route: { route: 'proxied', quick_proxy: null, full_proxy: 'old.mp4', format_version: 0 },
    conform_path: null, waveform_path: null, thumbnails_dir: null,
  }
  const initial: Project = { ...base, media_pool: { [MID]: item } }
  return createActor({ initial, idGen })
}

describe('applyDerivativesEvent', () => {
  it('SET: a full_proxy_landed object folds into the Proxied route', () => {
    const a = actorWithMedia()
    const r = applyDerivativesEvent(a, { media_id: MID, patch: { full_proxy_landed: { path: 'new.mp4', format_version: 3 } } })
    expect(r.ok).toBe(true)
    expect(a.snapshot().media_pool[MID].decode_route)
      .toEqual({ route: 'proxied', quick_proxy: null, full_proxy: 'new.mp4', format_version: 3 })
  })

  it('CLEAR: an explicit null full_proxy_landed clears the master (tri-state)', () => {
    const a = actorWithMedia()
    applyDerivativesEvent(a, { media_id: MID, patch: { full_proxy_landed: null } })
    expect(a.snapshot().media_pool[MID].decode_route)
      .toEqual({ route: 'proxied', quick_proxy: null, full_proxy: null, format_version: 0 })
  })

  it('LEAVE: an absent route key leaves the existing route value', () => {
    const a = actorWithMedia()
    applyDerivativesEvent(a, { media_id: MID, patch: { conform_path: 'c.bin' } }) // no route key
    expect(a.snapshot().media_pool[MID].decode_route)
      .toEqual({ route: 'proxied', quick_proxy: null, full_proxy: 'old.mp4', format_version: 0 }) // unchanged
    expect(a.snapshot().media_pool[MID].conform_path).toBe('c.bin')
  })

  it('SET_ROUTE: an authoritative route replacement is applied', () => {
    const a = actorWithMedia()
    applyDerivativesEvent(a, { media_id: MID, patch: { set_route: { route: 'bypass' } } })
    expect(a.snapshot().media_pool[MID].decode_route).toEqual({ route: 'bypass' })
  })

  it('returns MediaNotFound (and warns) for an unknown media id without throwing', () => {
    const a = actorWithMedia()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = applyDerivativesEvent(a, { media_id: '00000000-0000-0000-0000-0000000000ff', patch: { set_route: { route: 'bypass' } } })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.error).toBe('MediaNotFound')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
