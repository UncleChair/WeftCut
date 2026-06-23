import { describe, it, expect, vi } from 'vitest'
import { applyDerivativesEvent } from '../jobs-writeback'
import { createActor, type ActorHandle } from '../actor'
import { blankProject, type MediaItem, type Project } from '../model'
import { seededGen } from '../ids'

const MID = '00000000-0000-0000-0000-0000000000aa'

function actorWithMedia(): ActorHandle {
  const idGen = seededGen()
  const base = blankProject(idGen, 'p')
  const item: MediaItem = {
    id: MID, label: null, path_abs: '/ws/Media/clip.mp4', path_rel: 'Media/clip.mp4',
    kind: 'Video', metadata: { duration_us: 1_000_000 }, file_hash_blake3: 'x', file_size: 0, file_mtime: 0,
    imported_at: '2026-01-01T00:00:00Z', proxy_path: 'old.mp4', quick_proxy_path: null,
    proxy_bypassed: false, export_uses_original: false, proxy_format_version: 0,
    conform_path: null, waveform_path: null, thumbnails_dir: null,
  }
  const initial: Project = { ...base, media_pool: { [MID]: item } }
  return createActor({ initial, idGen })
}

describe('applyDerivativesEvent', () => {
  it('SET: a string proxy_path is applied', () => {
    const a = actorWithMedia()
    const r = applyDerivativesEvent(a, { media_id: MID, patch: { proxy_path: 'new.mp4', proxy_format_version: 3 } })
    expect(r.ok).toBe(true)
    expect(a.snapshot().media_pool[MID].proxy_path).toBe('new.mp4')
    expect(a.snapshot().media_pool[MID].proxy_format_version).toBe(3)
  })

  it('CLEAR: an explicit null proxy_path clears it (tri-state)', () => {
    const a = actorWithMedia()
    applyDerivativesEvent(a, { media_id: MID, patch: { proxy_path: null } })
    expect(a.snapshot().media_pool[MID].proxy_path).toBeNull()
  })

  it('LEAVE: an absent proxy_path key leaves the existing value', () => {
    const a = actorWithMedia()
    applyDerivativesEvent(a, { media_id: MID, patch: { conform_path: 'c.bin' } }) // no proxy_path key
    expect(a.snapshot().media_pool[MID].proxy_path).toBe('old.mp4')   // unchanged
    expect(a.snapshot().media_pool[MID].conform_path).toBe('c.bin')
  })

  it('returns MediaNotFound (and warns) for an unknown media id without throwing', () => {
    const a = actorWithMedia()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = applyDerivativesEvent(a, { media_id: '00000000-0000-0000-0000-0000000000ff', patch: { proxy_bypassed: true } })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.error).toBe('MediaNotFound')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
