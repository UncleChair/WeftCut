import type { MediaItem } from './model'

/** Channels that used to read the Rust mirror for one MediaItem and now receive
 *  it from the TS actor (the sole state owner). */
export const SINGLE_MEDIA_CHANNELS: ReadonlySet<string> = new Set([
  'get_media_thumbnail', 'get_waveform_peaks', 'ensure_full_proxy', 'ensure_conform',
])

/** Map renderer `{ mediaId }` args to the `{ item }` the Rust fn now expects.
 *  Throws the same "not found" error surface the old Rust lookup produced. */
export function resolveSingleMediaArgs(
  args: { mediaId?: string },
  pool: Record<string, MediaItem>,
): { item: MediaItem } {
  const id = args.mediaId ?? ''
  const item = pool[id]
  if (!item) throw new Error(`media ${id} not found`)
  return { item }
}
