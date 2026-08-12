// apps/desktop/src/main/state/commands.ts
// Production command adapter: translates the renderer's real category-A
// channels + camelCase wire args into the gated TS actor mutation core.
// Param defaults live on the builders below; multi-commit sequencing (and its
// op_id ordering) lives in the matching actor.ts arm. Routing is pinned by
// __tests__/prod.routing.test.ts and __tests__/commands.test.ts.

import type { LayerParams, Project, Rgba } from './model'
import { defaultTransform } from './mutations/add'
import { videoClipParams, audioParams, imageOverlayParams } from './mutations/media'
import { parseRgba, parseNumOpt, parseStr, parseStrOpt } from './mcp-commands'

/** 6-color palette cycled by layer index. */
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

/** Default color layer: BLACK at composition size. */
export function prodColorParams(a: Record<string, unknown>, comp: { width: number; height: number }): LayerParams {
  const color = a.color === undefined ? { r: 0, g: 0, b: 0, a: 255 } : parseRgba(a.color, 'color')
  return {
    kind: 'Color',
    color: { mode: 'Static', value: color },
    width: parseNumOpt(a.width, 'width') ?? comp.width,
    height: parseNumOpt(a.height, 'height') ?? comp.height,
  }
}

/** Default text layer: "Text", Arial 72, DrawText. */
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

/** Image layer span: still→3s, animated→duration_us. */
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

/** add_media_layer: kind-dispatch on the pool item. The 2 s fallback covers a
 *  pool item with no probed duration; `duration_us` is normalized content
 *  duration, so a container start PTS never leaks into the span. */
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

export function resolveDurationUs(durationUs: number | undefined): number {
  return Math.max(durationUs ?? 5_000_000, 100_000)
}

/** Scan tracks in reverse for the first non-reserved track with no layer
 *  overlap in [t0, t1). Returns null if none found, which means the caller must
 *  spawn a track via `applyAddTrack`. */
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
  // No label: the renderer derives the name, and a literal written here could
  // never be localized (ADR 0042).
  add_track: () => ({ op: 'add_track', args: { label: null } }),
  update_layer: (a) => ({ op: 'update_layer', args: { layer: a.layerId, patch: a.patch } }),
  // Remaining mechanical + meta channels
  move_layer: (a) => ({ op: 'move_layer', args: { layer: a.layerId, to_track: a.newTrackId, t_start_us: a.newTStartUs, escape_group: a.escapeGroup ?? false } }),
  trim_layer: (a) => ({ op: 'trim_layer', args: { layer: a.layerId, edge: a.edge, new_t_us: a.newTUs, escape_group: a.escapeGroup ?? false } }),
  delete_layer: (a) => ({ op: 'delete_layer', args: { layer: a.layerId } }),
  remove_media: (a) => ({ op: 'remove_media', args: { media: a.mediaId, force: a.force ?? false } }),
  duplicate_layer: (a) => ({ op: 'duplicate_layer', args: { layer: a.layerId, t_offset_us: a.tOffsetUs } }),
  split_layer_grouped: (a) => ({ op: 'split_layer', args: { layer: a.layerId, at_t_us: a.atTUs, escape_group: a.escapeGroup ?? false } }),
  groups_create: (a) => ({ op: 'groups_create', args: { layers: a.layerIds, label: a.label ?? null, reassign: a.reassign ?? false } }),
  groups_dissolve: (a) => ({ op: 'groups_dissolve', args: { group: a.groupId } }),
  update_layer_params: (a) => ({ op: 'update_layer_params', args: { layer: a.layerId, patch: a.patch } }),
  update_layer_param_track: (a) => ({ op: 'update_layer_param_track', args: { layer: a.layerId, param_key: a.paramKey, track: a.track } }),
  update_layer_param_tracks: (a) => ({ op: 'update_layer_param_tracks', args: { layer: a.layerId, entries: a.entries } }),
  set_scale_linked: (a) => ({ op: 'set_scale_linked', args: { layer: a.layerId, linked: a.linked } }),
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
  // Transitions (spec § Command surface). Pure renaming — kind/direction are
  // validated actor-side by parseTransitionKind (Crossfade REJECTS direction;
  // Wipe/Slide REQUIRE one), so undefined passes through untouched.
  add_transition: (a) => ({ op: 'add_transition', args: { from: a.fromLayerId, to: a.toLayerId, duration_us: a.durationUs, kind: a.kind, direction: a.direction } }),
  update_transition: (a) => ({ op: 'update_transition', args: { transition: a.transitionId, duration_us: a.durationUs, kind: a.kind, direction: a.direction } }),
  remove_transition: (a) => ({ op: 'remove_transition', args: { transition: a.transitionId } }),
  restyle_captions: (a) => ({ op: 'restyle_captions', args: { patch: a.patch } }),
  update_project_settings: (a) => ({ op: 'update_project_settings', args: { patch: a.patch } }),
  project_undo: () => ({ op: 'undo', args: {} }),
  project_redo: () => ({ op: 'redo', args: {} }),
  // History-panel channels. Same `project_*` channel → bare-op-name mapping the
  // three above use: the CHANNEL is the renderer's name for it, the OP is the
  // dispatch arm's. jump_to takes an absolute stack index (cursor-only, rejects
  // under the revert lock); create/delete_checkpoint are the User-actor half of
  // the checkpoint surface the MCP tools already cover for agents.
  project_jump_to: (a) => ({ op: 'jump_to', args: { index: a.index } }),
  project_create_checkpoint: (a) => ({ op: 'create_checkpoint', args: { label: a.label } }),
  project_delete_checkpoint: (a) => ({ op: 'delete_checkpoint', args: { checkpoint_id: a.checkpointId } }),
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
  'move_layer', 'trim_layer', 'delete_layer', 'remove_media', 'duplicate_layer', 'split_layer_grouped',
  'groups_create', 'groups_dissolve',
  'update_layer_params', 'update_layer_param_track', 'update_layer_param_tracks', 'set_scale_linked',
  'add_effect', 'update_effect', 'move_effect', 'remove_effect',
  'set_composition', 'fit_composition_to_layers',
  'update_track_flags', 'set_role_gain', 'update_role_flags',
  'add_transition', 'update_transition', 'remove_transition',
  'separate_audio_to_new_track', 'restyle_captions',
  'update_project_settings', 'project_undo', 'project_redo', 'project_restore_checkpoint',
  'project_jump_to', 'project_create_checkpoint', 'project_delete_checkpoint',
  // add_motif as a pure TS recorded mutation
  'add_motif',
])

export function parseMechanical(channel: string, a: Record<string, unknown>): { op: string; args: Record<string, unknown> } | null {
  const fn = MECHANICAL[channel]
  return fn ? fn(a) : null
}
