import { describe, it, expect } from 'vitest'
import {
  resolveClipSliceArgs,
  resolveTwoSliceArgs,
  CLIP_SLICE_TOOLS,
  TWO_SLICE_TOOLS,
} from '../clip-slice-forward'

const media = { id: 'm1', file_hash_blake3: 'h' } as never
const media2 = { id: 'm2', file_hash_blake3: 'h2' } as never
const vclip = { id: 'L1', params: { kind: 'VideoClip', media: 'm1' } } as never
const vclip2 = { id: 'L3', params: { kind: 'VideoClip', media: 'm2' } } as never
const text = { id: 'L2', params: { kind: 'Text', content: 'hi' } } as never
const snap = { tracks: [{ layers: [vclip, vclip2, text] }], media_pool: { m1: media, m2: media2 } } as never

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
    expect([...CLIP_SLICE_TOOLS].sort()).toEqual(['analyze_clip', 'describe_clip', 'detect_silences', 'transcribe_clip'])
  })
})

describe('resolveTwoSliceArgs', () => {
  it('lists exactly the two-slice compute tools', () => {
    expect([...TWO_SLICE_TOOLS].sort()).toEqual(['compare_frames'])
  })
  it('injects the slice into both nested a/b, preserving their t_us', () => {
    const out = resolveTwoSliceArgs(
      { a: { layer_id: 'L1', t_us: 1_000_000 }, b: { layer_id: 'L3', t_us: 2_000_000 } },
      snap,
    )
    expect(out.a).toMatchObject({ layer: vclip, media, t_us: 1_000_000 })
    expect(out.b).toMatchObject({ layer: vclip2, media: media2, t_us: 2_000_000 })
  })
  it('same-clip pair resolves both sides to the same layer/media', () => {
    const out = resolveTwoSliceArgs(
      { a: { layer_id: 'L1', t_us: 0 }, b: { layer_id: 'L1', t_us: 500_000 } },
      snap,
    )
    expect(out.a).toMatchObject({ layer: vclip, media })
    expect(out.b).toMatchObject({ layer: vclip, media })
  })
  it('null layer + null media when a side layer id is absent or non-video', () => {
    const out = resolveTwoSliceArgs(
      { a: { layer_id: 'gone', t_us: 0 }, b: { layer_id: 'L2', t_us: 0 } },
      snap,
    )
    expect(out.a).toMatchObject({ layer: null, media: null })
    expect(out.b).toMatchObject({ layer: text, media: null })
  })
  it('tolerates a missing side object (Rust produces the not-found error)', () => {
    const out = resolveTwoSliceArgs({ a: { layer_id: 'L1', t_us: 0 } }, snap)
    expect(out.a).toMatchObject({ layer: vclip, media })
    expect(out.b).toMatchObject({ layer: null, media: null })
  })
})
