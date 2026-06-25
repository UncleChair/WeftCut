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

/** Validate a required boolean wire arg → invalid_params. */
export function parseBool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new McpArgError(`${field} must be a boolean`)
  return v
}

/** Optional boolean variant: undefined/null → dflt. */
export function parseBoolOpt(v: unknown, field: string, dflt: boolean): boolean {
  return v === undefined || v === null ? dflt : parseBool(v, field)
}

/** Optional string variant: undefined/null → null, else validates string. */
export function parseStrOpt(v: unknown, field: string): string | null {
  return v === undefined || v === null ? null : (typeof v === 'string' ? v : (() => { throw new McpArgError(`${field} must be a string`) })())
}

function asArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) throw new McpArgError(`${field} must be an array`)
  return v as string[]
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

/** Single-source record per MCP tool. Table-exec tools carry parseArgs (+ optional
 *  shapeResult). Dedicated-exec tools carry stub records only — their parseDedicated
 *  arms are attached in Task 5. description/inputSchema seeded '' / {} here;
 *  // FILLED IN TASK 6 */
export interface McpToolDef {
  name: string
  description: string                   // FILLED IN TASK 6
  inputSchema: Record<string, unknown>  // FILLED IN TASK 6
  exec: 'table' | 'dedicated'
  parseArgs?: (a: Record<string, unknown>) => { op: string; args: Record<string, unknown> }  // table-exec only
  shapeResult?: (value: unknown) => ToolResultJson                                             // table-exec only (default toolEmpty)
  parseDedicated?: (a: Record<string, unknown>) => Record<string, unknown>                    // dedicated-exec only (Task 5)
}

// ── Single-source MCP tool table ─────────────────────────────────────────────
// Each table-exec entry folds §2.5 hardening into parseArgs: every former
// `a.x as T` cast → parseX(a.x,'x'); optional booleans → parseBoolOpt; patch/
// flags objects stay structural (validated by the downstream mutation), but all
// uuid/number/enum scalars are parser-gated. The 19 dedicated stubs exist only
// so MCP_TOOLS projection stays complete; their behavior lives in actor.ts arms.
// FILLED IN TASK 6: description/inputSchema on every entry.
export const MCP_TOOL_DEFS: ReadonlyArray<McpToolDef> = [
  // ── table-exec: tracks ───────────────────────────────────────────────────
  { name: 'add_track', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'add_track', args: { label: parseStrOpt(a.label, 'label') } }),
    shapeResult: (v) => toolText(v as string) },
  { name: 'remove_track', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'delete_track', args: { track: parseUuid(a.track_id, 'track_id'), force: parseBoolOpt(a.force, 'force', false) } }) },
  { name: 'move_track', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'move_track', args: { track: parseUuid(a.track_id, 'track_id'), new_position: a.new_position } }) },
  // ── table-exec: layers ───────────────────────────────────────────────────
  { name: 'duplicate_layer', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'duplicate_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), t_offset_us: a.t_offset_us } }),
    shapeResult: (v) => toolText(v as string) },
  { name: 'update_layer', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'update_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), patch: a.patch } }) },
  { name: 'update_layer_params', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'update_layer_params', args: { layer: parseUuid(a.layer_id, 'layer_id'), patch: a.patch } }) },
  { name: 'move_layer', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'move_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), to_track: parseUuid(a.new_track_id, 'new_track_id'), t_start_us: a.new_t_start_us, escape_group: parseBoolOpt(a.escape_group, 'escape_group', false) } }) },
  { name: 'trim_layer', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'trim_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), edge: a.edge, new_t_us: a.new_t_us, escape_group: parseBoolOpt(a.escape_group, 'escape_group', false) } }) },
  { name: 'delete_layer', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'delete_layer', args: { layer: parseUuid(a.layer_id, 'layer_id') } }) },
  // ── table-exec: groups ───────────────────────────────────────────────────
  { name: 'groups_create', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'groups_create', args: { layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')), label: parseStrOpt(a.label, 'label'), reassign: parseBoolOpt(a.reassign, 'reassign', false) } }),
    shapeResult: (v) => toolText(v as string) },
  { name: 'groups_dissolve', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'groups_dissolve', args: { group: parseUuid(a.group_id, 'group_id') } }) },
  { name: 'groups_add_members', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'groups_add_members', args: { group: parseUuid(a.group_id, 'group_id'), layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')), reassign: parseBoolOpt(a.reassign, 'reassign', false) } }) },
  { name: 'groups_remove_members', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'groups_remove_members', args: { group: parseUuid(a.group_id, 'group_id'), layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')) } }) },
  { name: 'groups_rename', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'groups_rename', args: { group: parseUuid(a.group_id, 'group_id'), label: parseStrOpt(a.label, 'label') } }) },
  // ── table-exec: effects ──────────────────────────────────────────────────
  { name: 'add_effect', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'add_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), kind: a.kind } }),
    shapeResult: (v) => toolText(v as string) },
  { name: 'update_effect', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'update_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id'), patch: a.patch } }) },
  { name: 'move_effect', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'move_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id'), new_index: a.new_index } }) },
  { name: 'remove_effect', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'remove_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id') } }) },
  // ── table-exec: composition ──────────────────────────────────────────────
  { name: 'set_composition', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'set_composition', args: a.patch as Record<string, unknown> }) },
  { name: 'fit_composition_to_layers', exec: 'table', description: '', inputSchema: {},
    parseArgs: () => ({ op: 'fit_composition_to_layers', args: {} }) },
  // ── table-exec: markers ──────────────────────────────────────────────────
  { name: 'update_marker', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'update_marker', args: { marker: parseUuid(a.marker_id, 'marker_id'), patch: a.patch } }) },
  { name: 'remove_marker', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'remove_marker', args: { marker: parseUuid(a.marker_id, 'marker_id') } }) },
  // ── table-exec: media ────────────────────────────────────────────────────
  { name: 'remove_media', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'remove_media', args: { media: parseUuid(a.media_id, 'media_id'), force: parseBoolOpt(a.force, 'force', false) } }) },
  // ── table-exec: history ──────────────────────────────────────────────────
  { name: 'undo', exec: 'table', description: '', inputSchema: {},
    parseArgs: () => ({ op: 'undo', args: {} }) },
  { name: 'redo', exec: 'table', description: '', inputSchema: {},
    parseArgs: () => ({ op: 'redo', args: {} }) },
  // ── table-exec: audio roles ──────────────────────────────────────────────
  { name: 'set_role_gain', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'set_role_gain', args: { role: parseRole(a.role), gain_db: parseNum(a.gain_db, 'gain_db') } }) },
  // set_role_flags: patch stays structural (muted/solo are nullable booleans validated by the mutation)
  { name: 'set_role_flags', exec: 'table', description: '', inputSchema: {},
    parseArgs: (a) => ({ op: 'update_role_flags', args: { role: parseRole(a.role), patch: { muted: a.muted ?? null, solo: a.solo ?? null } } }) },
  // ── dedicated-exec (19) — parseDedicated validates and maps MCP args; behavior lives in actor.ts arms ──
  { name: 'add_color_layer', exec: 'dedicated', description: '', inputSchema: {},
    parseDedicated: (a) => ({ track: parseUuid(a.track_id, 'track_id'), color: parseRgba(a.color, 'color'),
      width: parseNumOpt(a.width, 'width'), height: parseNumOpt(a.height, 'height'),
      t_start_us: parseNum(a.t_start_us, 't_start_us'), t_end_us: parseNum(a.t_end_us, 't_end_us') }) },
  { name: 'add_video_layer', exec: 'dedicated', description: '', inputSchema: {},
    parseDedicated: (a) => ({ track: parseUuid(a.track_id, 'track_id'), media: parseUuid(a.media_id, 'media_id'),
      src_in_us: parseNum(a.src_in_us, 'src_in_us'), src_out_us: parseNum(a.src_out_us, 'src_out_us'),
      t_start_us: parseNum(a.t_start_us, 't_start_us'), t_end_us: parseNum(a.t_end_us, 't_end_us') }) },
  { name: 'split_layer', exec: 'dedicated', description: '', inputSchema: {},
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'),
      at_t_us: parseNum(a.at_t_us, 'at_t_us'), escape_group: a.escape_group }) },
  { name: 'add_marker', exec: 'dedicated', description: '', inputSchema: {},
    parseDedicated: (a) => ({ color: parseRgba(a.color, 'color'), t_us: parseNum(a.t_us, 't_us'),
      end_t_us: parseNumOpt(a.end_t_us, 'end_t_us'), label: parseStr(a.label, 'label') }) },
  { name: 'lock_history', exec: 'dedicated', description: '', inputSchema: {},
    parseDedicated: (a) => ({ reason: parseStr(a.reason, 'reason') }) },
  { name: 'unlock_history', exec: 'dedicated', description: '', inputSchema: {},
    parseDedicated: (_a) => ({}) },
  { name: 'set_keyframe', exec: 'dedicated', description: '', inputSchema: {},
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), param_key: parseStr(a.param_key, 'param_key'),
      t_us: parseNum(a.t_us, 't_us'), value: parseNum(a.value, 'value'), interp: parseInterpOpt(a.interp) }) },
  { name: 'get_param_track', exec: 'dedicated', description: '', inputSchema: {},
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), param_key: parseStr(a.param_key, 'param_key') }) },
  { name: 'remove_keyframe', exec: 'dedicated', description: '', inputSchema: {},
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), keyframe_id: parseUuid(a.keyframe_id, 'keyframe_id'),
      param_key: parseStr(a.param_key, 'param_key') }) },
  { name: 'retime_keyframe', exec: 'dedicated', description: '', inputSchema: {},
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), keyframe_id: parseUuid(a.keyframe_id, 'keyframe_id'),
      param_key: parseStr(a.param_key, 'param_key'), t_us: parseNum(a.t_us, 't_us') }) },
  { name: 'set_keyframe_easing', exec: 'dedicated', description: '', inputSchema: {},
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), keyframe_id: parseUuid(a.keyframe_id, 'keyframe_id'),
      param_key: parseStr(a.param_key, 'param_key'), interp: parseInterp(a.interp) }) },
  { name: 'smooth_keyframes', exec: 'dedicated', description: '', inputSchema: {},
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), param_key: parseStr(a.param_key, 'param_key'),
      keyframe_id: a.keyframe_id != null ? parseUuid(a.keyframe_id, 'keyframe_id') : null }) },
  { name: 'clear_keyframes', exec: 'dedicated', description: '', inputSchema: {},
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), param_key: parseStr(a.param_key, 'param_key'),
      value: parseNumOpt(a.value, 'value') }) },
  { name: 'set_param_track', exec: 'dedicated', description: '', inputSchema: {},
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), param_key: parseStr(a.param_key, 'param_key'),
      track: parseAnimatedF64(a.track) }) },
  { name: 'dry_run', exec: 'dedicated', description: '', inputSchema: {},
    parseDedicated: (a) => ({ operations: asArray(a.operations, 'operations') }) },
  { name: 'checkpoint', exec: 'dedicated', description: '', inputSchema: {},
    parseDedicated: (a) => ({ label: parseStr(a.label, 'label') }) },
  { name: 'list_checkpoints', exec: 'dedicated', description: '', inputSchema: {},
    parseDedicated: (_a) => ({}) },
  { name: 'restore_checkpoint', exec: 'dedicated', description: '', inputSchema: {},
    parseDedicated: (a) => ({ checkpoint_id: parseUuid(a.checkpoint_id, 'checkpoint_id') }) },
  { name: 'begin_agent_session', exec: 'dedicated', description: '', inputSchema: {},
    parseDedicated: (a) => ({ reason: parseStr(a.reason, 'reason') }) },
]

const DEF_BY_NAME: Map<string, McpToolDef> = new Map(MCP_TOOL_DEFS.map((d) => [d.name, d]))
export function mcpDef(name: string): McpToolDef { const d = DEF_BY_NAME.get(name); if (!d) throw new Error(`no MCP def for ${name}`); return d }

/** MCP tool → internal dispatch op + renamed args. Projection of MCP_TOOL_DEFS.
 *  Explicit-param tools (add_color_layer/add_video_layer/add_marker/split_layer
 *  etc.) are NOT here — they have dedicated arms in actor.mcpCall. */
export const MCP_ARG_PARSERS: Record<string, (a: Record<string, unknown>) => { op: string; args: Record<string, unknown> }> =
  Object.fromEntries(MCP_TOOL_DEFS.filter((d) => d.parseArgs).map((d) => [d.name, d.parseArgs!]))

/** MCP tool → ToolResult from the dispatch value. Projection of MCP_TOOL_DEFS.
 *  Tools absent here → toolEmpty. */
export const MCP_RESULT_SHAPERS: Record<string, (value: unknown) => ToolResultJson> =
  Object.fromEntries(MCP_TOOL_DEFS.filter((d) => d.shapeResult).map((d) => [d.name, d.shapeResult!]))

/** All MCP tools this adapter handles (parsers + the dedicated arms). Projection of MCP_TOOL_DEFS. */
export const MCP_TOOLS: ReadonlySet<string> = new Set(MCP_TOOL_DEFS.map((d) => d.name))
