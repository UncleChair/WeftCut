// apps/desktop/src/main/state/replay.ts
import { seededGen } from './ids'
import { blankProject } from './model'
import { canonicalize } from './canonical'
import { serializeProject } from './serialize'
import { createActor } from './actor'
import { tsErrorVariant } from './errors'
import { buildProjectSummary } from './summary'

export const SUPPORTED_OPS = new Set<string>([
  'add_layer', 'add_track', 'add_marker', 'set_composition',
  'move_layer', 'trim_layer', 'delete_layer', 'duplicate_layer', 'undo', 'redo',
  'split_layer', 'groups_create',
  'groups_dissolve', 'groups_add_members', 'groups_remove_members', 'groups_rename',
  'update_layer', 'fit_composition_to_layers',
  'update_marker', 'remove_marker',
  'delete_track', 'move_track',
  'update_track_flags',
  'add_effect', 'update_effect', 'move_effect', 'remove_effect',
  'add_transition', 'remove_transition',
  'add_media', 'separate_audio',
  'update_layer_params', 'update_layer_param_track', 'update_layer_param_tracks',
  'set_role_gain', 'update_role_flags', 'update_project_settings',
  'add_caption_track', 'restyle_caption_track',
])
const SUPPORTED_ADD_KINDS = new Set<string>(['color', 'text', 'video', 'audio', 'image'])

export interface TraceStep { op: string; ok: boolean; error: string | null; state: unknown }
export interface Trace { name: string; steps: TraceStep[] }
export interface SummaryStep { op: string; ok: boolean; error: string | null; summary: unknown }
export interface SummaryTrace { name: string; steps: SummaryStep[] }
interface Cmd { op: string; ref?: string; [k: string]: unknown }
interface Sequence { name: string; commands: Cmd[] }

export function sequenceIsSupported(seq: Sequence): boolean {
  for (const c of seq.commands) {
    if (!SUPPORTED_OPS.has(c.op)) return false
    if (c.op === 'add_layer' && !SUPPORTED_ADD_KINDS.has(String(c.kind))) return false
  }
  return true
}

/** Resolve @A/@B/@<ref> tokens to ids; bare ids pass through. */
function resolve(refs: Map<string, string>, token: unknown): string {
  const s = String(token)
  const key = s.startsWith('@') ? s.slice(1) : s
  return refs.get(key) ?? key
}

/** Substitute a single @ref token inside an effect-param key string. */
function resolveParamKey(refs: Map<string, string>, key: string): string {
  return key.replace(/@([A-Za-z0-9_]+)/, (_, r) => refs.get(r) ?? r)
}

/** Shared dispatch loop. `capture` receives the actor + cmd metadata after each
 *  step and returns the value to record in the step. */
function runSequence<S>(
  seq: Sequence,
  capture: (actor: ReturnType<typeof createActor>, cmd: Cmd, ok: boolean, error: string | null) => S,
): { name: string; steps: Array<{ op: string; ok: boolean; error: string | null } & S> } {
  const idGen = seededGen()
  const initial = blankProject(idGen, 'replay')
  const aRoll = initial.tracks[0].id
  const bRoll = initial.tracks[1].id
  const actor = createActor({ initial, idGen, clock: () => '<TS>' })

  const refs = new Map<string, string>([['A', aRoll], ['B', bRoll]])
  const steps: Array<{ op: string; ok: boolean; error: string | null } & S> = []
  for (const cmd of seq.commands) {
    const args = buildArgs(cmd, refs)
    const r = actor.dispatch(cmd.op, args)
    let error: string | null = null
    if (r.ok) {
      // capture a returned layer/track/marker id under its ref
      if (cmd.ref && typeof r.value === 'string') refs.set(cmd.ref, r.value)
    } else {
      const v = tsErrorVariant(r.error)
      error = v.inner ? `${v.top}(${v.inner})` : v.top
    }
    const extra = capture(actor, cmd, r.ok, error)
    steps.push({ op: cmd.op, ok: r.ok, error, ...extra })
  }
  return { name: seq.name, steps }
}

/** TS twin of native/src/bin/replay_driver.rs. Starts from a blank project with
 *  seeded ids (#1 A-roll, #2 B-roll, #3 project), then applies each command. */
export function replaySequence(seq: Sequence): Trace {
  return runSequence(seq, (actor) => ({
    state: canonicalize(serializeProject(actor.snapshot())),
  })) as Trace
}

/** Replay a sequence and capture the summary view at each step (for the
 *  oracle-summary differential gate). `fileExists` is () => false because the
 *  corpus has no real media files on disk. */
export function replaySummaries(seq: Sequence): SummaryTrace {
  return runSequence(seq, (actor) => ({
    summary: canonicalize(buildProjectSummary(actor.snapshot(), actor.historyStatus(), () => false)),
  })) as SummaryTrace
}

function buildArgs(cmd: Cmd, refs: Map<string, string>): Record<string, unknown> {
  switch (cmd.op) {
    case 'add_layer': return { track: resolve(refs, cmd.track), kind: cmd.kind, t_start_us: cmd.t_start_us, t_end_us: cmd.t_end_us,
      media: cmd.media !== undefined ? resolve(refs, cmd.media) : undefined, src_in_us: cmd.src_in_us, src_out_us: cmd.src_out_us }
    case 'add_track': return { label: cmd.label ?? null }
    case 'add_marker': return { t_us: cmd.t_us, end_t_us: cmd.end_t_us ?? null, label: cmd.label ?? 'm' }
    case 'move_layer': return { layer: resolve(refs, cmd.layer), to_track: resolve(refs, cmd.to_track), t_start_us: cmd.t_start_us, escape_group: cmd.escape_group ?? false }
    case 'trim_layer': return { layer: resolve(refs, cmd.layer), edge: cmd.edge, new_t_us: cmd.new_t_us, escape_group: cmd.escape_group ?? false }
    case 'delete_layer': return { layer: resolve(refs, cmd.layer) }
    case 'duplicate_layer': return { layer: resolve(refs, cmd.layer), t_offset_us: cmd.t_offset_us }
    case 'set_composition': return { duration_us: cmd.duration_us, fps: cmd.fps, width: cmd.width, height: cmd.height, sample_rate: cmd.sample_rate, channels: cmd.channels, color_space: cmd.color_space, background: cmd.background }
    case 'split_layer': return { layer: resolve(refs, cmd.layer), at_t_us: cmd.at_t_us, escape_group: cmd.escape_group ?? false }
    case 'groups_create': return { layers: (cmd.layers as unknown[]).map((t) => resolve(refs, t)), label: cmd.label ?? null, reassign: cmd.reassign ?? false }
    case 'groups_dissolve': return { group: resolve(refs, cmd.group) }
    case 'groups_add_members': return { group: resolve(refs, cmd.group), layers: (cmd.layers as unknown[]).map((t) => resolve(refs, t)), reassign: cmd.reassign ?? false }
    case 'groups_remove_members': return { group: resolve(refs, cmd.group), layers: (cmd.layers as unknown[]).map((t) => resolve(refs, t)) }
    case 'groups_rename': return { group: resolve(refs, cmd.group), label: cmd.label ?? null }
    case 'update_layer': return { layer: resolve(refs, cmd.layer), patch: { label: cmd.label, t_start_us: cmd.t_start_us, t_end_us: cmd.t_end_us, enabled: cmd.enabled, locked: cmd.locked } }
    case 'fit_composition_to_layers': return {}
    case 'update_marker': return { marker: resolve(refs, cmd.marker), patch: { t_us: cmd.t_us, end_t_us: cmd.end_t_us, label: cmd.label, color: cmd.color } }
    case 'remove_marker': return { marker: resolve(refs, cmd.marker) }
    case 'delete_track': return { track: resolve(refs, cmd.track), force: cmd.force ?? false }
    case 'move_track': return { track: resolve(refs, cmd.track), new_position: cmd.new_position }
    case 'update_track_flags': return { track: resolve(refs, cmd.track), patch: { enabled: cmd.enabled, muted: cmd.muted, solo: cmd.solo, locked: cmd.locked } }
    case 'add_effect': return { layer: resolve(refs, cmd.layer), kind: cmd.kind }
    case 'update_effect': return { layer: resolve(refs, cmd.layer), effect: resolve(refs, cmd.effect), patch: { enabled: cmd.enabled, params: cmd.params } }
    case 'move_effect': return { layer: resolve(refs, cmd.layer), effect: resolve(refs, cmd.effect), new_index: cmd.new_index }
    case 'remove_effect': return { layer: resolve(refs, cmd.layer), effect: resolve(refs, cmd.effect) }
    case 'add_transition': return { from: resolve(refs, cmd.from), to: resolve(refs, cmd.to), duration_us: cmd.duration_us }
    case 'remove_transition': return { transition: resolve(refs, cmd.transition) }
    case 'add_media': return { id: cmd.id, kind: cmd.kind, duration_us: cmd.duration_us ?? null }
    case 'separate_audio': return { layer: resolve(refs, cmd.layer) }
    case 'update_layer_params': return { layer: resolve(refs, cmd.layer), patch: cmd.patch }
    case 'update_layer_param_track': return { layer: resolve(refs, cmd.layer), param_key: resolveParamKey(refs, cmd.param_key as string), track: cmd.track }
    case 'update_layer_param_tracks': return { layer: resolve(refs, cmd.layer), entries: cmd.entries }
    case 'set_role_gain': return { role: cmd.role, gain_db: cmd.gain_db }
    case 'update_role_flags': return { role: cmd.role, patch: { muted: cmd.muted, solo: cmd.solo } }
    case 'update_project_settings': return { patch: { auto_delete_empty_tracks: cmd.auto_delete_empty_tracks } }
    case 'add_caption_track': return { cues: cmd.cues, comp_w: cmd.comp_w, comp_h: cmd.comp_h, label: cmd.label ?? null }
    case 'restyle_caption_track': return { track: resolve(refs, cmd.track), patch: cmd.patch }
    case 'undo': case 'redo': return {}
    default: return {}
  }
}
