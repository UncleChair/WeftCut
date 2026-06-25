// apps/desktop/src/main/state/mcp-commands.ts
// Pure MCP-tool adapter helpers: arg parsing (snake_case MCP vocab → internal
// dispatch vocab), ToolResult shaping, and CommandError → MCP error mapping.
// The byte-exact mcp.differential gate (vs Rust dispatch_tool) is the backstop.
// Mirrors native/src/mcp/{tools.rs,wire.rs}.
import type { CommandError } from './errors'
import type { Animated, Interpolation, Keyframe, Rgba } from './model'
import { canonicalize } from './canonical'

export type McpErrorCode = 'invalid_params' | 'invalid_request' | 'not_found' | 'internal'
export type McpToolErrorJson = { code: McpErrorCode; message: string; data?: unknown }
export type ToolResultJson = { content: Array<{ type: 'text'; text: string }> } // isError omitted when false
export type McpCallResult = { ok: true; result: ToolResultJson } | { ok: false; error: McpToolErrorJson }

/** Thrown by arg parsers on bad input (e.g. malformed UUID) → invalid_params. */
export class McpArgError extends Error {
  constructor(public readonly mcpMessage: string) { super(mcpMessage); this.name = 'McpArgError' }
  toJson(): McpToolErrorJson { return { code: 'invalid_params', message: this.mcpMessage } }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Mirrors tools.rs parse_uuid: validates + errors "<field> not a UUID: …". */
export function parseUuid(s: unknown, field: string): string {
  if (typeof s !== 'string' || !UUID_RE.test(s)) throw new McpArgError(`${field} not a UUID: ${String(s)}`)
  return s
}

const INTERP_SIMPLE = new Set(['Hold', 'Linear', 'EaseIn', 'EaseOut'])
const isPair = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number'

/** Validate an Interpolation (model.ts:16) — mirrors Rust serde from_value::<Interpolation>
 *  (tools.rs:934). Throws McpArgError on malformed input → invalid_params. */
export function parseInterp(v: unknown): Interpolation {
  if (v === null || typeof v !== 'object') throw new McpArgError(`invalid interp: not an object`)
  const o = v as Record<string, unknown>
  const kind = o.kind
  if (typeof kind !== 'string') throw new McpArgError(`invalid interp: missing 'kind'`)
  if (INTERP_SIMPLE.has(kind)) return { kind } as Interpolation
  if (kind === 'Bezier') {
    if (!isPair(o.p1) || !isPair(o.p2)) throw new McpArgError(`invalid interp: Bezier needs p1/p2 as [number, number]`)
    return { kind: 'Bezier', p1: o.p1, p2: o.p2 }
  }
  throw new McpArgError(`invalid interp: unknown kind '${kind}'`)
}

/** Optional variant: undefined passes through (set_keyframe's interp is Option). */
export function parseInterpOpt(v: unknown): Interpolation | undefined {
  return v === undefined ? undefined : parseInterp(v)
}

/** Validate an Animated<number> (model.ts:20) — mirrors Rust serde
 *  from_value::<Animated<f64>> (tools.rs:1038). Throws McpArgError → invalid_params. */
export function parseAnimatedF64(v: unknown): Animated<number> {
  if (v === null || typeof v !== 'object') throw new McpArgError(`invalid track: not an object`)
  const o = v as Record<string, unknown>
  if (o.mode === 'Static') {
    if (typeof o.value !== 'number') throw new McpArgError(`invalid track: Static value must be a number`)
    return { mode: 'Static', value: o.value }
  }
  if (o.mode === 'Keyframed') {
    if (!Array.isArray(o.value)) throw new McpArgError(`invalid track: Keyframed value must be an array`)
    const kfs: Keyframe<number>[] = o.value.map((raw) => {
      if (raw === null || typeof raw !== 'object') throw new McpArgError(`invalid track: keyframe must be an object`)
      const k = raw as Record<string, unknown>
      if (typeof k.id !== 'string') throw new McpArgError(`invalid track: keyframe id must be a string`)
      if (typeof k.t_us !== 'number') throw new McpArgError(`invalid track: keyframe t_us must be a number`)
      if (typeof k.value !== 'number') throw new McpArgError(`invalid track: keyframe value must be a number`)
      return { id: k.id, t_us: k.t_us, value: k.value, interp: parseInterp(k.interp) }
    })
    return { mode: 'Keyframed', value: kfs }
  }
  throw new McpArgError(`invalid track: unknown mode '${String(o.mode)}'`)
}

const AUDIO_ROLES = new Set(['dialogue', 'music', 'sfx', 'voiceover'])
/** Validate an AudioRole (audio_role.rs kebab-case). Rust rejects an unknown
 *  role at the serde boundary → invalid_params; mirror that here. */
export function parseRole(v: unknown): string {
  if (typeof v !== 'string' || !AUDIO_ROLES.has(v)) throw new McpArgError(`unknown audio role '${String(v)}'`)
  return v
}

/** Validate an Rgba (color.rs: four u8 fields). Rust serde rejects a non-object
 *  or out-of-range value at the deserialize boundary → invalid_params; the
 *  dedicated mcpCall arms (add_marker/add_color_layer) previously cast `a.color
 *  as Rgba` raw, so a string like "#fff" committed to the actor and then broke
 *  the read-mirror push. Mirror Rust's contract here so it never commits. */
export function parseRgba(v: unknown, field: string): Rgba {
  if (v === null || typeof v !== 'object') throw new McpArgError(`${field} must be an {r,g,b,a} color object`)
  const o = v as Record<string, unknown>
  const out = { r: 0, g: 0, b: 0, a: 0 }
  for (const k of ['r', 'g', 'b', 'a'] as const) {
    const n = o[k]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255)
      throw new McpArgError(`${field}.${k} must be an integer 0..255`)
    out[k] = n
  }
  return out
}

/** Validate a required finite-number wire arg → invalid_params. A raw `as number`
 *  cast would let a string/undefined through as NaN into the actor. */
export function parseNum(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new McpArgError(`${field} must be a number`)
  return v
}

/** Optional finite-number variant: undefined/null → undefined (absent). */
export function parseNumOpt(v: unknown, field: string): number | undefined {
  return v === undefined || v === null ? undefined : parseNum(v, field)
}

/** Validate a required string wire arg → invalid_params. */
export function parseStr(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new McpArgError(`${field} must be a string`)
  return v
}

// ── ToolResult shapers (wire.rs:81-93) ──
export function toolText(s: string): ToolResultJson { return { content: [{ type: 'text', text: s }] } }
export function toolEmpty(): ToolResultJson { return { content: [] } }
/** json results travel as a text block whose text is the SERIALIZED JSON with
 *  alpha-sorted keys (Rust serde_json preserve_order OFF → BTreeMap). */
export function toolJson(v: unknown): ToolResultJson { return { content: [{ type: 'text', text: JSON.stringify(canonicalize(v)) }] } }

/** native/src/mcp/keyframes.rs:165 get_param_track result shape (NOT the raw
 *  Animated serde): Static → {mode,value}; Keyframed → {mode, keyframes:[{id,
 *  t_us (timeline-absolute = local + t_start), t_local_us (stored base), value,
 *  interp}]}. Caller wraps in toolJson (sorted keys, mirrors Rust json!/BTreeMap). */
export function shapeGetParamTrack(track: { mode: 'Static'; value: number } | { mode: 'Keyframed'; value: Array<{ id: string; t_us: number; value: number; interp: unknown }> }, tStartUs: number): unknown {
  if (track.mode === 'Static') return { mode: 'Static', value: track.value }
  return {
    mode: 'Keyframed',
    keyframes: track.value.map((k) => ({ id: k.id, t_us: k.t_us + tStartUs, t_local_us: k.t_us, value: k.value, interp: k.interp })),
  }
}

/** Reasonable, NON-asserted prose for a failed dry-run op (the differential
 *  gate uses succeeding-ops-only sequences, so this string is never gated;
 *  the halt/error shape is unit-tested in mcp.dryrun.test.ts). */
export function dryRunErrorString(e: CommandError): string {
  if (e.error === 'InvalidArgument') return `${e.field}: ${e.detail}`
  if (e.error === 'Backend') return e.detail
  if (e.error === 'ValidationFailed') return `validation failed: ${e.detail.rule}`
  return e.error
}

/** tools.rs:1512 DryRunResponse: per-op {index, status, output|error} flattened,
 *  plus halted_at (the first failing index, or null). DryRunOutput serde is
 *  tag="kind" rename_all=snake_case: add_layer{layer_id} / split_layer{left_id,
 *  right_id} / void. Wrapped in toolJson (sorted keys). */
export function shapeDryRunResponse(
  results: Array<{ ok: true; value: { kind: 'AddLayer'; layer_id: string } | { kind: 'SplitLayer'; left_id: string; right_id: string } | { kind: 'Void' } } | { ok: false; error: CommandError }>,
): ToolResultJson {
  let haltedAt: number | null = null
  const entries = results.map((r, index) => {
    if (r.ok) {
      const o = r.value
      const output = o.kind === 'AddLayer' ? { kind: 'add_layer', layer_id: o.layer_id }
        : o.kind === 'SplitLayer' ? { kind: 'split_layer', left_id: o.left_id, right_id: o.right_id }
        : { kind: 'void' }
      return { index, status: 'ok', output }
    }
    if (haltedAt === null) haltedAt = index
    return { index, status: 'error', error: dryRunErrorString(r.error) }
  })
  return toolJson({ results: entries, halted_at: haltedAt })
}

/** map_command_error (tools.rs:61-118): CommandError → MCP error JSON. Only the
 *  structured `data` (LayerOverlap/MediaInUse) + InvalidArgument message are
 *  gated byte-exact; other prose messages are reasonable-but-ungated. */
export function mapCommandError(e: CommandError): McpToolErrorJson {
  if (e.error === 'InvalidArgument') return { code: 'invalid_params', message: `${e.field}: ${e.detail}` }
  if (e.error === 'Backend') return { code: 'internal', message: e.detail }
  if (e.error === 'ValidationFailed' && e.detail.rule === 'LayerOverlap') {
    const d = e.detail
    return { code: 'invalid_params', message: 'layer overlap', data: {
      error: 'LayerOverlap', track: d.track, blocking_layer: d.a,
      blocking_range_us: [d.a_start, d.a_end], requested_range_us: [d.b_start, d.b_end],
      options: [
        { action: 'create_new_track', kind: 'Video' },
        { action: 'trim_existing', layer_id: d.a, new_t_end_us: d.b_start },
        { action: 'split_at_t', layer_id: d.a, at_t_us: d.b_start },
      ],
    } }
  }
  if (e.error === 'MediaInUse') {
    return { code: 'invalid_params', message: 'media in use', data: {
      error: 'MediaInUse', media: e.media, referenced_by: e.referenced_by,
      options: [
        { action: 'force_remove', note: 'calls remove_media with force=true; cascades layer deletions' },
        { action: 'delete_layers_first', layer_ids: e.referenced_by },
      ],
    } }
  }
  return { code: 'invalid_params', message: e.error }
}

// keyframes.rs:149 require_key presence check (the caller throws McpArgError on false).
export function keyframePresent(track: { mode: string; value: unknown }, id: string): boolean {
  return track.mode === 'Keyframed' && Array.isArray((track as { value: Array<{ id: string }> }).value)
    && (track as { value: Array<{ id: string }> }).value.some((k) => k.id === id)
}

/** MCP tool → internal dispatch op + renamed args. Throws McpArgError on bad
 *  UUIDs. Explicit-param tools (add_color_layer/add_video_layer/add_marker/
 *  split_layer) are NOT here — they have dedicated arms in actor.mcpCall. */
export const MCP_ARG_PARSERS: Record<string, (a: Record<string, unknown>) => { op: string; args: Record<string, unknown> }> = {
  add_track: (a) => ({ op: 'add_track', args: { label: (a.label as string | undefined) ?? null } }),
  remove_track: (a) => ({ op: 'delete_track', args: { track: parseUuid(a.track_id, 'track_id'), force: (a.force as boolean) ?? false } }),
  duplicate_layer: (a) => ({ op: 'duplicate_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), t_offset_us: a.t_offset_us } }),
  move_track: (a) => ({ op: 'move_track', args: { track: parseUuid(a.track_id, 'track_id'), new_position: a.new_position } }),
  update_layer: (a) => ({ op: 'update_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), patch: a.patch } }),
  update_layer_params: (a) => ({ op: 'update_layer_params', args: { layer: parseUuid(a.layer_id, 'layer_id'), patch: a.patch } }),
  move_layer: (a) => ({ op: 'move_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), to_track: parseUuid(a.new_track_id, 'new_track_id'), t_start_us: a.new_t_start_us, escape_group: (a.escape_group as boolean) ?? false } }),
  trim_layer: (a) => ({ op: 'trim_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), edge: a.edge, new_t_us: a.new_t_us, escape_group: (a.escape_group as boolean) ?? false } }),
  delete_layer: (a) => ({ op: 'delete_layer', args: { layer: parseUuid(a.layer_id, 'layer_id') } }),
  groups_create: (a) => ({ op: 'groups_create', args: { layers: (a.layer_ids as string[]).map((s) => parseUuid(s, 'layer_ids')), label: (a.label as string | undefined) ?? null, reassign: (a.reassign as boolean) ?? false } }),
  groups_dissolve: (a) => ({ op: 'groups_dissolve', args: { group: parseUuid(a.group_id, 'group_id') } }),
  groups_add_members: (a) => ({ op: 'groups_add_members', args: { group: parseUuid(a.group_id, 'group_id'), layers: (a.layer_ids as string[]).map((s) => parseUuid(s, 'layer_ids')), reassign: (a.reassign as boolean) ?? false } }),
  groups_remove_members: (a) => ({ op: 'groups_remove_members', args: { group: parseUuid(a.group_id, 'group_id'), layers: (a.layer_ids as string[]).map((s) => parseUuid(s, 'layer_ids')) } }),
  groups_rename: (a) => ({ op: 'groups_rename', args: { group: parseUuid(a.group_id, 'group_id'), label: (a.label as string | undefined) ?? null } }),
  add_effect: (a) => ({ op: 'add_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), kind: a.kind } }),
  update_effect: (a) => ({ op: 'update_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id'), patch: a.patch } }),
  move_effect: (a) => ({ op: 'move_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id'), new_index: a.new_index } }),
  remove_effect: (a) => ({ op: 'remove_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id') } }),
  set_composition: (a) => ({ op: 'set_composition', args: a.patch as Record<string, unknown> }),
  fit_composition_to_layers: () => ({ op: 'fit_composition_to_layers', args: {} }),
  update_marker: (a) => ({ op: 'update_marker', args: { marker: parseUuid(a.marker_id, 'marker_id'), patch: a.patch } }),
  remove_marker: (a) => ({ op: 'remove_marker', args: { marker: parseUuid(a.marker_id, 'marker_id') } }),
  remove_media: (a) => ({ op: 'remove_media', args: { media: parseUuid(a.media_id, 'media_id'), force: (a.force as boolean) ?? false } }),
  undo: () => ({ op: 'undo', args: {} }),
  redo: () => ({ op: 'redo', args: {} }),
  set_role_gain: (a) => ({ op: 'set_role_gain', args: { role: parseRole(a.role), gain_db: a.gain_db } }),
  set_role_flags: (a) => ({ op: 'update_role_flags', args: { role: parseRole(a.role), patch: { muted: a.muted ?? null, solo: a.solo ?? null } } }),
}

/** MCP tool → ToolResult from the dispatch value. Tools absent here → toolEmpty. */
export const MCP_RESULT_SHAPERS: Record<string, (value: unknown) => ToolResultJson> = {
  add_track: (v) => toolText(v as string),
  duplicate_layer: (v) => toolText(v as string),
  add_effect: (v) => toolText(v as string),
  groups_create: (v) => toolText(v as string),
}

/** All MCP tools this adapter handles (parsers + the dedicated arms). Grows per task. */
export const MCP_TOOLS: ReadonlySet<string> = new Set<string>([
  'add_track', 'remove_track', 'move_track',
  'add_color_layer', 'add_video_layer', 'update_layer', 'update_layer_params',
  'move_layer', 'split_layer', 'delete_layer', 'trim_layer', 'duplicate_layer',
  'groups_create', 'groups_dissolve', 'groups_add_members', 'groups_remove_members', 'groups_rename',
  'add_effect', 'update_effect', 'move_effect', 'remove_effect',
  'set_composition', 'fit_composition_to_layers',
  'add_marker', 'update_marker', 'remove_marker',
  'remove_media', 'undo', 'redo', 'lock_history', 'unlock_history',
  'set_role_gain', 'set_role_flags',
  // Phase 3d-b: keyframes + dry_run
  'set_keyframe', 'get_param_track', 'remove_keyframe', 'retime_keyframe',
  'set_keyframe_easing', 'smooth_keyframes', 'clear_keyframes', 'set_param_track', 'dry_run',
  // Phase 3d-c: checkpoints + agent session
  'checkpoint', 'list_checkpoints', 'restore_checkpoint', 'begin_agent_session',
])
