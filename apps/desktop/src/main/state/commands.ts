// apps/desktop/src/main/state/commands.ts
// Production command adapter: translates the renderer's real category-A
// channels + camelCase wire args into the gated TS actor mutation core.
// The byte-exact prod-differential gate is the backstop for every mapping.

// ── Production param builder facts ──────────────────────────────────────────
//
// add_color_layer_impl:
//   color    → Rgba::BLACK = {r:0,g:0,b:0,a:255}
//   width    → snap.composition.width
//   height   → snap.composition.height
//   duration → DEFAULT_LAYER_DURATION_US (5_000_000 µs, floor .max(100_000))
//   trackId  → resolve_overlay_track() when absent (find free non-reserved track
//               or create new "Overlay" track)
//
// add_text_layer_impl:
//   content  → "Text"
//   font     → family:"Arial", size_px:72.0, weight:400, italic:false
//   color    → Rgba::WHITE = {r:255,g:255,b:255,a:255}
//   align    → TextAlign::Center
//   backend  → TextBackend::DrawText
//   duration → DEFAULT_LAYER_DURATION_US (5_000_000 µs, floor .max(100_000))
//   trackId  → resolve_overlay_track() when absent
//
// add_media_layer:
//   track_id  → required (no fallback)
//   total_src → media.metadata.duration_us ?? 2_000_000
//               (normalized content duration; container start PTS is hidden)
//   Video   → videoClipParams(media,0,total_src), span=total_src
//   Audio   → audioParams(media,0,total_src) role=Music, span=total_src
//   Image   → imageOverlayParams(media), span=image_layer_span_us()
//             (still→3_000_000; animated→metadata.duration_us if >0 and
//              multi-frame OR >=500_000, else 3_000_000)
//   auto-pair: fires when kind==Video AND metadata.audio.is_some() AND
//              project.settings.auto_pair_audio_on_import==true. THREE
//              separate commits — video-layer-add, audio-layer-add
//              (role=dialogue), groups_create — in that id-allocation order
//              (the add_media_layer arm in actor.ts; three op_ids matching
//              Rust's three handle calls). NOT exercised by the differential
//              corpus (mediaItemTemplate sets audio:null).
//
// add_demo_color_layer:
//   track   → tracks.front() (first track; create "Track" if empty)
//   t_start → track.layers.last().t_end_us ?? 0
//   t_end   → t_start + 2_000_000
//   color   → demo_color(track.layers.len()) — 6-color palette cycled by index
//   w/h     → composition size
//
// add_demo_text_layer:
//   track   → tracks.last() (last track; create "Overlay" if empty)
//   t_start → track.layers.last().t_end_us ?? 0
//   t_end   → t_start + 3_000_000
//   content → "TEXT", font Arial 96 weight:700 italic:false
//   color   → WHITE, align Center, backend DrawText
//
// resolve_overlay_track:
//   scan tracks in REVERSE order, non-reserved only (role==null), find first
//   with no layer overlap in [t_start, t_end); if none → add_track("Overlay")
//
// DEFAULT_LAYER_DURATION_US = 5_000_000
// ────────────────────────────────────────────────────────────────────────────

import type { LayerParams, Project, Rgba } from './model'
import { defaultTransform } from './mutations/add'
import { videoClipParams, audioParams, imageOverlayParams } from './mutations/media'
import { parseRgba, parseNumOpt, parseStr, parseStrOpt } from './mcp-commands'

/** demo_color palette: 6-color cycle by layer index. */
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

/** add_color_layer_impl default: BLACK, composition size. */
export function prodColorParams(a: Record<string, unknown>, comp: { width: number; height: number }): LayerParams {
  const color = a.color === undefined ? { r: 0, g: 0, b: 0, a: 255 } : parseRgba(a.color, 'color')
  return {
    kind: 'Color',
    color: { mode: 'Static', value: color },
    width: parseNumOpt(a.width, 'width') ?? comp.width,
    height: parseNumOpt(a.height, 'height') ?? comp.height,
  }
}

/** add_text_layer_impl defaults: "Text", Arial 72 DrawText. */
export function prodTextParams(a: Record<string, unknown>): LayerParams {
  return {
    kind: 'Text',
    content: parseStrOpt(a.content, 'content') ?? 'Text',
    font: { family: 'Arial', size_px: 72, weight: 400, italic: false },
    color: { mode: 'Static', value: { r: 255, g: 255, b: 255, a: 255 } },
    align: 'Center',
    transform: defaultTransform(),
    opacity: { mode: 'Static', value: 1 },
    shadow: null, outline: null, intro: null, outro: null,
    backend_hint: 'DrawText',
  }
}

/** image_layer_span_us: still→3s, animated→duration_us. */
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
  /** When the source is a video carrying audio AND auto_pair_audio_on_import is on,
   *  the paired Audio layer params (role=dialogue). Else null. */
  autoPairAudio: LayerParams | null
}

/** add_media_layer: kind-dispatch on the pool item. */
export function prodMediaLayer(
  a: Record<string, unknown>,
  project: Project,
): MediaLayerResult {
  const mediaId = parseStr(a.mediaId, 'mediaId')
  const item = project.media_pool[mediaId]
  if (!item) throw new Error(`media not found in pool: ${mediaId}`)
  const totalSrc = (item.metadata.duration_us as number | null | undefined) ?? 2_000_000
  switch (item.kind) {
    case 'Video': {
      const autoPair = item.metadata.audio != null && project.settings.auto_pair_audio_on_import
        ? { ...audioParams(mediaId, 0, totalSrc), role: 'dialogue' as const }
        : null
      return { params: videoClipParams(mediaId, 0, totalSrc), durationUs: totalSrc, autoPairAudio: autoPair }
    }
    case 'Audio':
      return { params: audioParams(mediaId, 0, totalSrc), durationUs: totalSrc, autoPairAudio: null }
    case 'Image': {
      const span = imageLayerSpanUs(item.metadata as { duration_us: number | null; video?: { nb_frames?: number | null } | null })
      return { params: imageOverlayParams(mediaId), durationUs: span, autoPairAudio: null }
    }
    default:
      throw new Error(`unsupported media kind for add_media_layer: ${item.kind}`)
  }
}

/** resolveDurationUs: 5s default, 100ms floor. */
export function resolveDurationUs(durationUs: number | undefined): number {
  return Math.max(durationUs ?? 5_000_000, 100_000)
}

/** resolveOverlayTrack: scan tracks in reverse, find
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
  // Remaining mechanical + meta channels
  move_layer: (a) => ({ op: 'move_layer', args: { layer: a.layerId, to_track: a.newTrackId, t_start_us: a.newTStartUs, escape_group: a.escapeGroup ?? false } }),
  trim_layer: (a) => ({ op: 'trim_layer', args: { layer: a.layerId, edge: a.edge, new_t_us: a.newTUs, escape_group: a.escapeGroup ?? false } }),
  delete_layer: (a) => ({ op: 'delete_layer', args: { layer: a.layerId } }),
  duplicate_layer: (a) => ({ op: 'duplicate_layer', args: { layer: a.layerId, t_offset_us: a.tOffsetUs } }),
  split_layer_grouped: (a) => ({ op: 'split_layer', args: { layer: a.layerId, at_t_us: a.atTUs, escape_group: a.escapeGroup ?? false } }),
  groups_create: (a) => ({ op: 'groups_create', args: { layers: a.layerIds, label: a.label ?? null, reassign: a.reassign ?? false } }),
  groups_dissolve: (a) => ({ op: 'groups_dissolve', args: { group: a.groupId } }),
  update_layer_params: (a) => ({ op: 'update_layer_params', args: { layer: a.layerId, patch: a.patch } }),
  update_layer_param_track: (a) => ({ op: 'update_layer_param_track', args: { layer: a.layerId, param_key: a.paramKey, track: a.track } }),
  update_layer_param_tracks: (a) => ({ op: 'update_layer_param_tracks', args: { layer: a.layerId, entries: a.entries } }),
  add_effect: (a) => ({ op: 'add_effect', args: { layer: a.layerId, kind: a.kind } }),
  update_effect: (a) => ({ op: 'update_effect', args: { layer: a.layerId, effect: a.effectId, patch: a.patch } }),
  move_effect: (a) => ({ op: 'move_effect', args: { layer: a.layerId, effect: a.effectId, new_index: a.newIndex } }),
  remove_effect: (a) => ({ op: 'remove_effect', args: { layer: a.layerId, effect: a.effectId } }),
  // set_composition: renderer sends { patch: {...} }; dispatch receives the patch directly as its args.
  set_composition: (a) => ({ op: 'set_composition', args: a.patch as Record<string, unknown> }),
  fit_composition_to_layers: () => ({ op: 'fit_composition_to_layers', args: {} }),
  update_track_flags: (a) => ({ op: 'update_track_flags', args: { track: a.trackId, patch: a.patch } }),
  set_role_gain: (a) => ({ op: 'set_role_gain', args: { role: a.role, gain_db: a.gainDb } }),
  update_role_flags: (a) => ({ op: 'update_role_flags', args: { role: a.role, patch: a.patch } }),
  separate_audio_to_new_track: (a) => ({ op: 'separate_audio', args: { layer: a.layerId } }),
  restyle_captions: (a) => ({ op: 'restyle_captions', args: { patch: a.patch } }),
  update_project_settings: (a) => ({ op: 'update_project_settings', args: { patch: a.patch } }),
  project_undo: () => ({ op: 'undo', args: {} }),
  project_redo: () => ({ op: 'redo', args: {} }),
  project_restore_checkpoint: (a) => ({ op: 'restore_checkpoint', args: { checkpoint_id: a.checkpointId } }),
  // NOTE: add_motif is intentionally NOT a MECHANICAL entry — parseMechanical
  // returns null for it, so command() falls through to the rich add_motif switch
  // arm (canonicalize + two-commit). It is listed in PRODUCTION_OPS directly.
}

/** All production channels this adapter handles (mechanical + rich + meta). */
export const PRODUCTION_OPS = new Set<string>([
  'add_track', 'update_layer',
  'add_color_layer', 'add_text_layer', 'add_media_layer', 'paste_layer',
  'add_demo_color_layer', 'add_demo_text_layer',
  // Remaining mechanical + meta channels
  'move_layer', 'trim_layer', 'delete_layer', 'duplicate_layer', 'split_layer_grouped',
  'groups_create', 'groups_dissolve',
  'update_layer_params', 'update_layer_param_track', 'update_layer_param_tracks',
  'add_effect', 'update_effect', 'move_effect', 'remove_effect',
  'set_composition', 'fit_composition_to_layers',
  'update_track_flags', 'set_role_gain', 'update_role_flags',
  'separate_audio_to_new_track', 'restyle_captions',
  'update_project_settings', 'project_undo', 'project_redo', 'project_restore_checkpoint',
  // add_motif as a pure TS recorded mutation
  'add_motif',
])

export function parseMechanical(channel: string, a: Record<string, unknown>): { op: string; args: Record<string, unknown> } | null {
  const fn = MECHANICAL[channel]
  return fn ? fn(a) : null
}
