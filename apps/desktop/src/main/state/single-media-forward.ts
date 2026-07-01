import type { MediaItem } from './model'

/** Channels whose Rust fn takes one MediaItem as a call argument; the TS actor
 *  (the sole state owner) resolves it by `mediaId` and forwards it. */
export const SINGLE_MEDIA_CHANNELS: ReadonlySet<string> = new Set([
  'get_media_thumbnail', 'get_media_thumbnails', 'get_waveform_peaks',
  'get_waveform_levels', 'get_waveform_tile', 'ensure_full_proxy', 'ensure_conform',
])

/** Map renderer `{ mediaId, ...rest }` args to `{ item, ...rest }` the Rust fn
 *  now expects — `rest` carries channel-specific args (e.g. a tile request's
 *  level/channel/range) straight through untouched. Throws the same
 *  "not found" error surface the old Rust lookup produced. */
export function resolveSingleMediaArgs(
  args: { mediaId?: string } & Record<string, unknown>,
  pool: Record<string, MediaItem>,
): { item: MediaItem } & Record<string, unknown> {
  const { mediaId, ...rest } = args
  const id = mediaId ?? ''
  const item = pool[id]
  if (!item) throw new Error(`media ${id} not found`)
  return { item, ...rest }
}
