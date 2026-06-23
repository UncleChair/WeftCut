// apps/desktop/src/main/state/commands.ts
// Production command adapter: translates the renderer's real category-A
// channels + camelCase wire args into the gated TS actor mutation core.
// The byte-exact prod-differential gate is the backstop for every mapping.

// ── Production param builder facts (read verbatim from mutations.rs) ────────
//
// add_color_layer_impl (mutations.rs:362-388):
//   color    → Rgba::BLACK = {r:0,g:0,b:0,a:255}
//   width    → snap.composition.width
//   height   → snap.composition.height
//   duration → DEFAULT_LAYER_DURATION_US (5_000_000 µs, floor .max(100_000))
//   trackId  → resolve_overlay_track() when absent (find free non-reserved track
//               or create new "Overlay" track)
//
// add_text_layer_impl (mutations.rs:269-305):
//   content  → "Text"
//   font     → family:"Arial", size_px:72.0, weight:400, italic:false
//   color    → Rgba::WHITE = {r:255,g:255,b:255,a:255}
//   align    → TextAlign::Center
//   backend  → TextBackend::DrawText
//   duration → DEFAULT_LAYER_DURATION_US (5_000_000 µs, floor .max(100_000))
//   trackId  → resolve_overlay_track() when absent
//
// add_media_layer (mutations.rs:73-183):
//   track_id  → required (no fallback)
//   total_src → media.metadata.duration_us ?? 2_000_000
//   Video   → videoClipParams(media,0,total_src), span=total_src
//   Audio   → audioParams(media,0,total_src) role=Music, span=total_src
//   Image   → imageOverlayParams(media), span=image_layer_span_us()
//             (still→3_000_000; animated→metadata.duration_us if >0 and
//              multi-frame OR >=500_000, else 3_000_000)
//   auto-pair: fires when kind==Video AND metadata.audio.is_some() AND
//              project.settings.auto_pair_audio_on_import==true.
//             DEFERRED: corpus mediaItemTemplate sets audio:null so the predicate
//             is false for all corpus seqs; implement when a corpus item carries
//             audio metadata. When implemented: single commit containing
//             video-layer-add, audio-layer-add (role=dialogue), groups_create
//             in that id-allocation order.
//
// add_demo_color_layer (mutations.rs:185-214):
//   track   → tracks.front() (first track; create "Track" if empty)
//   t_start → track.layers.last().t_end_us ?? 0
//   t_end   → t_start + 2_000_000
//   color   → demo_color(track.layers.len()) — 6-color palette cycled by index
//   w/h     → composition size
//
// add_demo_text_layer (mutations.rs:318-360):
//   track   → tracks.last() (last track; create "Overlay" if empty)
//   t_start → track.layers.last().t_end_us ?? 0
//   t_end   → t_start + 3_000_000
//   content → "TEXT", font Arial 96 weight:700 italic:false
//   color   → WHITE, align Center, backend DrawText
//
// resolve_overlay_track (mutations.rs:254-267):
//   scan tracks in REVERSE order, non-reserved only (role==null), find first
//   with no layer overlap in [t_start, t_end); if none → add_track("Overlay")
//
// DEFAULT_LAYER_DURATION_US = 5_000_000 (mutations.rs:235)
// ────────────────────────────────────────────────────────────────────────────

import type { LayerParams, Project, Rgba } from './model'
import { defaultTransform } from './mutations/add'
import { videoClipParams, audioParams, imageOverlayParams } from './mutations/media'

/** demo_color palette (mutations.rs:681-688): 6-color cycle by layer index. */
const DEMO_PALETTE: Rgba[] = [
  { r: 96, g: 165, b: 250, a: 255 },
  { r: 244, g: 114, b: 182, a: 255 },
  { r: 74, g: 222, b: 128, a: 255 },
  { r: 251, g: 191, b: 36, a: 255 },
  { r: 167, g: 139, b: 250, a: 255 },
  { r: 248, g: 113, b: 113, a: 255 },
]
export function demoColor(idx: number): Rgba {
  return DEMO_PALETTE[idx % DEMO_PALETTE.length]
}

/** add_color_layer_impl default (mutations.rs:378-382): BLACK, composition size. */
export function prodColorParams(a: Record<string, unknown>, comp: { width: number; height: number }): LayerParams {
  const color = (a.color as Rgba | undefined) ?? { r: 0, g: 0, b: 0, a: 255 }
  return {
    kind: 'Color',
    color: { mode: 'Static', value: color },
    width: (a.width as number | undefined) ?? comp.width,
    height: (a.height as number | undefined) ?? comp.height,
  }
}

/** add_text_layer_impl defaults (mutations.rs:282-299): "Text", Arial 72 DrawText. */
export function prodTextParams(a: Record<string, unknown>): LayerParams {
  return {
    kind: 'Text',
    content: (a.content as string | undefined) ?? 'Text',
    font: { family: 'Arial', size_px: 72, weight: 400, italic: false },
    color: { mode: 'Static', value: { r: 255, g: 255, b: 255, a: 255 } },
    align: 'Center',
    transform: defaultTransform(),
    opacity: { mode: 'Static', value: 1 },
    shadow: null, outline: null, intro: null, outro: null,
    backend_hint: 'DrawText',
  }
}

/** image_layer_span_us (mutations.rs:222-233): still→3s, animated→duration_us. */
function imageLayerSpanUs(metadata: { duration_us: number | null; video?: { nb_frames?: number | null } | null }): number {
  const STILL = 3_000_000
  const multiFrame = (metadata.video?.nb_frames ?? 0) > 1
  const d = metadata.duration_us
  if (d != null && d > 0 && (multiFrame || d >= 500_000)) return d
  return STILL
}

export interface MediaLayerResult {
  params: LayerParams
  durationUs: number
  // autoPair not populated: corpus mediaItemTemplate sets audio:null so the
  // predicate media.metadata.audio.is_some() is always false for corpus seqs.
  // When a future corpus item carries audio metadata, implement the single-commit
  // path here (video-layer-add + audio-layer-add(role=dialogue) + groups_create).
}

/** add_media_layer (mutations.rs:73-183): kind-dispatch on the pool item. */
export function prodMediaLayer(
  a: Record<string, unknown>,
  project: Project,
): MediaLayerResult {
  const mediaId = a.mediaId as string
  const item = project.media_pool[mediaId]
  if (!item) throw new Error(`media not found in pool: ${mediaId}`)
  const totalSrc = (item.metadata.duration_us as number | null | undefined) ?? 2_000_000
  switch (item.kind) {
    case 'Video':
      return { params: videoClipParams(mediaId, 0, totalSrc), durationUs: totalSrc }
    case 'Audio':
      return { params: audioParams(mediaId, 0, totalSrc), durationUs: totalSrc }
    case 'Image': {
      const span = imageLayerSpanUs(item.metadata as { duration_us: number | null; video?: { nb_frames?: number | null } | null })
      return { params: imageOverlayParams(mediaId), durationUs: span }
    }
    default:
      throw new Error(`unsupported media kind for add_media_layer: ${item.kind}`)
  }
}

/** resolveDurationUs (mutations.rs:235-236): 5s default, 100ms floor. */
export function resolveDurationUs(durationUs: number | undefined): number {
  return Math.max(durationUs ?? 5_000_000, 100_000)
}

/** resolveOverlayTrack (mutations.rs:237-267): scan tracks in reverse, find
 *  first non-reserved track with no layer overlap in [t0, t1). Returns null
 *  if none found (caller must create "Overlay" track via addTrack). */
export function pickFreeOverlayTrack(project: Project, t0: number, t1: number): string | null {
  const tracks = [...project.tracks].reverse()
  for (const t of tracks) {
    if (t.role !== null) continue
    const free = t.layers.every((l) => !(t0 < l.t_end_us && l.t_start_us < t1))
    if (free) return t.id
  }
  return null
}

/** Mechanical channels: pure camelCase→snake renaming, no param construction.
 *  Returns null for channels not in this table. */
const MECHANICAL: Record<string, (a: Record<string, unknown>) => { op: string; args: Record<string, unknown> }> = {
  add_track: () => ({ op: 'add_track', args: { label: 'Track' } }),
  update_layer: (a) => ({ op: 'update_layer', args: { layer: a.layerId, patch: a.patch } }),
  // (more added in Task 4)
}

/** All production channels this adapter handles (mechanical + rich + meta). */
export const PRODUCTION_OPS = new Set<string>([
  'add_track', 'update_layer',
  'add_color_layer', 'add_text_layer', 'add_media_layer',
  'add_demo_color_layer', 'add_demo_text_layer',
])

export function parseMechanical(channel: string, a: Record<string, unknown>): { op: string; args: Record<string, unknown> } | null {
  const fn = MECHANICAL[channel]
  return fn ? fn(a) : null
}
