import { describe, it, expect } from 'vitest'
import { SINGLE_MEDIA_CHANNELS, resolveSingleMediaArgs } from '../single-media-forward'

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
})
