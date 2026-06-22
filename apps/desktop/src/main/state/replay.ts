// apps/desktop/src/main/state/replay.ts
import { seededGen } from './ids'
import { blankProject } from './model'
import { canonicalize } from './canonical'
import { serializeProject } from './serialize'
import { createActor } from './actor'
import { tsErrorVariant } from './errors'

export const SUPPORTED_OPS = new Set<string>([
  'add_layer', 'add_track', 'add_marker', 'set_composition',
  'move_layer', 'trim_layer', 'delete_layer', 'duplicate_layer', 'undo', 'redo',
  'split_layer', 'groups_create',
  'update_layer', 'fit_composition_to_layers',
])
const SUPPORTED_ADD_KINDS = new Set<string>(['color', 'text'])

export interface TraceStep { op: string; ok: boolean; error: string | null; state: unknown }
export interface Trace { name: string; steps: TraceStep[] }
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

/** TS twin of native/src/bin/replay_driver.rs. Starts from a blank project with
 *  seeded ids (#1 A-roll, #2 B-roll, #3 project), then applies each command. */
export function replaySequence(seq: Sequence): Trace {
  const idGen = seededGen()
  const initial = blankProject(idGen, 'replay')
  const aRoll = initial.tracks[0].id
  const bRoll = initial.tracks[1].id
  const actor = createActor({ initial, idGen, clock: () => '<TS>' })

  const refs = new Map<string, string>([['A', aRoll], ['B', bRoll]])
  const steps: TraceStep[] = []
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
    const state = canonicalize(serializeProject(actor.snapshot()))
    steps.push({ op: cmd.op, ok: r.ok, error, state })
  }
  return { name: seq.name, steps }
}

function buildArgs(cmd: Cmd, refs: Map<string, string>): Record<string, unknown> {
  switch (cmd.op) {
    case 'add_layer': return { track: resolve(refs, cmd.track), kind: cmd.kind, t_start_us: cmd.t_start_us, t_end_us: cmd.t_end_us }
    case 'add_track': return { label: cmd.label ?? null }
    case 'add_marker': return { t_us: cmd.t_us, end_t_us: cmd.end_t_us ?? null, label: cmd.label ?? 'm' }
    case 'move_layer': return { layer: resolve(refs, cmd.layer), to_track: resolve(refs, cmd.to_track), t_start_us: cmd.t_start_us, escape_group: cmd.escape_group ?? false }
    case 'trim_layer': return { layer: resolve(refs, cmd.layer), edge: cmd.edge, new_t_us: cmd.new_t_us, escape_group: cmd.escape_group ?? false }
    case 'delete_layer': return { layer: resolve(refs, cmd.layer) }
    case 'duplicate_layer': return { layer: resolve(refs, cmd.layer), t_offset_us: cmd.t_offset_us }
    case 'set_composition': return { duration_us: cmd.duration_us }
    case 'split_layer': return { layer: resolve(refs, cmd.layer), at_t_us: cmd.at_t_us, escape_group: cmd.escape_group ?? false }
    case 'groups_create': return { layers: (cmd.layers as unknown[]).map((t) => resolve(refs, t)), label: cmd.label ?? null, reassign: cmd.reassign ?? false }
    case 'update_layer': return { layer: resolve(refs, cmd.layer), patch: { label: cmd.label, t_start_us: cmd.t_start_us, t_end_us: cmd.t_end_us, enabled: cmd.enabled, locked: cmd.locked } }
    case 'fit_composition_to_layers': return {}
    case 'undo': case 'redo': return {}
    default: return {}
  }
}
