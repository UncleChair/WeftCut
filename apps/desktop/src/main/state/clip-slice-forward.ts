import type { Layer, MediaItem, Project } from './model'

/** MCP clip compute tools whose Rust handler takes one layer + its MediaItem
 *  (the `resolve_clip_audio_source` / `resolve_clip_video_source` inputs) as an
 *  injected slice; the TS actor (the sole state owner) resolves and forwards it.
 *  `detect_silences` / `transcribe_clip` read the layer's audio; `describe_clip`
 *  reads its video frames. */
export const CLIP_SLICE_TOOLS: ReadonlySet<string> = new Set([
  'detect_silences', 'transcribe_clip', 'describe_clip',
])

/** Resolve the `{ layer, media }` slice for a clip-audio MCP tool from the actor
 *  snapshot and merge it into the tool args. The layer is found by `layer_id`;
 *  its MediaItem comes from the layer's params (VideoClip / Audio carry a `media`
 *  id). Missing layer/media → `null`; the Rust handler then produces the
 *  structured not-found / not-analyzable error (single source of truth). */
export function resolveClipSliceArgs(
  args: Record<string, unknown>,
  snapshot: Pick<Project, 'tracks' | 'media_pool'>,
): Record<string, unknown> {
  const layerId = (args as { layer_id?: string }).layer_id ?? ''
  const layer: Layer | null =
    snapshot.tracks.flatMap((t) => t.layers).find((l) => l.id === layerId) ?? null
  const mediaId =
    layer && (layer.params.kind === 'VideoClip' || layer.params.kind === 'Audio')
      ? layer.params.media
      : null
  const media: MediaItem | null = mediaId ? snapshot.media_pool[mediaId] ?? null : null
  return { ...args, layer, media }
}
