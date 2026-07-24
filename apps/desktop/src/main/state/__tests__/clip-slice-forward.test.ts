import { describe, it, expect } from 'vitest'
import { resolveClipSliceArgs, CLIP_SLICE_TOOLS } from '../clip-slice-forward'

const media = { id: 'm1', file_hash_blake3: 'h' } as never
const vclip = { id: 'L1', params: { kind: 'VideoClip', media: 'm1' } } as never
const text = { id: 'L2', params: { kind: 'Text', content: 'hi' } } as never
const snap = { tracks: [{ layers: [vclip, text] }], media_pool: { m1: media } } as never

describe('resolveClipSliceArgs', () => {
  it('injects the layer and its MediaItem for an AV layer, preserving args', () => {
    const out = resolveClipSliceArgs({ layer_id: 'L1', threshold_amp: 0.02 }, snap)
    expect(out.layer).toBe(vclip)
    expect(out.media).toBe(media)
    expect(out.threshold_amp).toBe(0.02)
  })
  it('null layer + null media when the layer id is absent', () => {
    expect(resolveClipSliceArgs({ layer_id: 'gone' }, snap)).toMatchObject({ layer: null, media: null })
  })
  it('null media for a non-AV layer (Rust produces the not-analyzable error)', () => {
    const out = resolveClipSliceArgs({ layer_id: 'L2' }, snap)
    expect(out.layer).toBe(text)
    expect(out.media).toBeNull()
  })
  it('lists exactly the clip-slice compute tools', () => {
    expect([...CLIP_SLICE_TOOLS].sort()).toEqual(['describe_clip', 'detect_silences', 'transcribe_clip'])
  })
})
