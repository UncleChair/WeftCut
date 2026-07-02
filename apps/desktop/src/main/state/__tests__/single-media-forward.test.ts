import { describe, it, expect } from 'vitest'
import { SINGLE_MEDIA_CHANNELS, resolveSingleMediaArgs } from '../single-media-forward'
import type { MediaItem } from '../model'

const item = { id: 'm1', label: null, kind: 'Video', file_hash_blake3: 'h' } as never

describe('resolveSingleMediaArgs', () => {
  it('includes timeline thumbnail manifests in the single-media channel set', () => {
    expect(SINGLE_MEDIA_CHANNELS.has('get_media_thumbnails')).toBe(true)
  })
  it('replaces { mediaId } with the resolved { item }', () => {
    const pool = { m1: item }
    expect(resolveSingleMediaArgs({ mediaId: 'm1' }, pool)).toEqual({ item })
  })
  it('throws a not-found error when the id is absent', () => {
    expect(() => resolveSingleMediaArgs({ mediaId: 'gone' }, {})).toThrow(/media gone not found/)
  })
  it('passes through extra args for get_waveform_tile', () => {
    const pool = { m1: { id: 'm1' } as unknown as MediaItem }
    const out = resolveSingleMediaArgs(
      { mediaId: 'm1', level: 2, channel: 1, startPeak: 0, count: 2048 } as never,
      pool,
    )
    expect(out.item).toBe(pool.m1)
    expect(out).toMatchObject({ level: 2, channel: 1, startPeak: 0, count: 2048 })
  })
  it('passes through extra args for get_filmstrip_tile', () => {
    const pool = { m1: { id: 'm1' } as unknown as MediaItem }
    const out = resolveSingleMediaArgs({ mediaId: 'm1', lod: 4, index: 12 } as never, pool)
    expect(out.item).toBe(pool.m1)
    expect(out).toMatchObject({ lod: 4, index: 12 })
  })
})
