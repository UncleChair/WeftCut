import type { Layer, MediaItem, Project } from './model'

/** MCP clip compute tools whose Rust handler takes one layer + its MediaItem
 *  (the `resolve_clip_audio_source` / `resolve_clip_video_source` inputs) as an
 *  injected slice; the TS actor (the sole state owner) resolves and forwards it.
 *  `detect_silences` / `transcribe_clip` read the layer's audio; `describe_clip`
 *  and `analyze_clip` read its video frames. */
export const CLIP_SLICE_TOOLS: ReadonlySet<string> = new Set([
  'detect_silences', 'transcribe_clip', 'describe_clip', 'analyze_clip',
])

/** MCP clip compute tools shaped `{ a:{layer_id,t_us}, b:{layer_id,t_us} }` —
 *  TWO nested clip slices, not a top-level `layer_id`, so they can't ride
 *  `CLIP_SLICE_TOOLS`. `compare_frames` compares one frame from each side. */
export const TWO_SLICE_TOOLS: ReadonlySet<string> = new Set(['compare_frames'])

/** Resolve one layer id to its `{ layer, media }` slice from the actor snapshot.
 *  The MediaItem comes from the layer's params (VideoClip / Audio carry a `media`
 *  id). Missing layer/media → `null` — the Rust handler owns the structured
 *  not-found / not-analyzable error (single source of truth). */
function resolveLayerSlice(
  layerId: string,
  snapshot: Pick<Project, 'tracks' | 'media_pool'>,
): { layer: Layer | null; media: MediaItem | null } {
  const layer: Layer | null =
    snapshot.tracks.flatMap((t) => t.layers).find((l) => l.id === layerId) ?? null
  const mediaId =
    layer && (layer.params.kind === 'VideoClip' || layer.params.kind === 'Audio')
      ? layer.params.media
      : null
  const media: MediaItem | null = mediaId ? snapshot.media_pool[mediaId] ?? null : null
  return { layer, media }
}

/** Resolve the `{ layer, media }` slice for a single-slice clip MCP tool from a
 *  top-level `layer_id` and merge it into the tool args. */
export function resolveClipSliceArgs(
  args: Record<string, unknown>,
  snapshot: Pick<Project, 'tracks' | 'media_pool'>,
): Record<string, unknown> {
  const { layer, media } = resolveLayerSlice((args as { layer_id?: string }).layer_id ?? '', snapshot)
  return { ...args, layer, media }
}

/** Resolve BOTH nested clip slices for a two-slice tool: each of `a` / `b` gets
 *  its `{ layer, media }` injected from its own `layer_id`, same
 *  single-source-of-truth contract as `resolveClipSliceArgs` (missing → null,
 *  Rust produces the not-found / not-video error per side). */
export function resolveTwoSliceArgs(
  args: Record<string, unknown>,
  snapshot: Pick<Project, 'tracks' | 'media_pool'>,
): Record<string, unknown> {
  const resolveSide = (raw: unknown): Record<string, unknown> => {
    const side = (raw ?? {}) as Record<string, unknown>
    const { layer, media } = resolveLayerSlice((side as { layer_id?: string }).layer_id ?? '', snapshot)
    return { ...side, layer, media }
  }
  return {
    ...args,
    a: resolveSide((args as { a?: unknown }).a),
    b: resolveSide((args as { b?: unknown }).b),
  }
}
