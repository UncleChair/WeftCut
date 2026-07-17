// apps/desktop/src/main/state/mcp-commands.ts
// Pure MCP-tool adapter helpers: arg parsing (snake_case MCP vocab → internal
// dispatch vocab), ToolResult shaping, and CommandError → MCP error mapping.
// The byte-exact mcp.differential gate (vs Rust dispatch_tool) is the backstop.
// Mirrors native/src/mcp/{tools.rs,wire.rs}.
import type { CommandError } from './errors'
import type { Animated, Interpolation, Keyframe, Rgba } from './model'
import { sortKeys } from './canonical'

export type McpErrorCode = 'invalid_params' | 'invalid_request' | 'not_found' | 'internal'
export type McpToolErrorJson = { code: McpErrorCode; message: string; data?: unknown }
export type ToolResultJson = { content: Array<{ type: 'text'; text: string }> } // isError omitted when false
export type McpCallResult = { ok: true; result: ToolResultJson } | { ok: false; error: McpToolErrorJson }

/** Thrown by arg parsers on bad input (e.g. malformed UUID) → invalid_params. */
export class McpArgError extends Error {
  constructor(public readonly mcpMessage: string, public readonly field?: string) { super(mcpMessage); this.name = 'McpArgError' }
  toJson(): McpToolErrorJson { return { code: 'invalid_params', message: this.mcpMessage } }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Mirrors tools.rs parse_uuid: validates + errors "<field> not a UUID: …". */
export function parseUuid(s: unknown, field: string): string {
  if (typeof s !== 'string' || !UUID_RE.test(s)) throw new McpArgError(`${field} not a UUID: ${String(s)}`, field)
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
 *  as Rgba` raw, so a string like "#fff" committed garbage to the actor and
 *  wedged it. Mirror Rust's contract here so it never commits. */
export function parseRgba(v: unknown, field: string): Rgba {
  if (v === null || typeof v !== 'object') throw new McpArgError(`${field} must be an {r,g,b,a} color object`, field)
  const o = v as Record<string, unknown>
  const out = { r: 0, g: 0, b: 0, a: 0 }
  for (const k of ['r', 'g', 'b', 'a'] as const) {
    const n = o[k]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255)
      throw new McpArgError(`${field}.${k} must be an integer 0..255`, field)
    out[k] = n
  }
  return out
}

/** Validate a required finite-number wire arg → invalid_params. A raw `as number`
 *  cast would let a string/undefined through as NaN into the actor. */
export function parseNum(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new McpArgError(`${field} must be a number`, field)
  return v
}

/** Optional finite-number variant: undefined/null → undefined (absent). */
export function parseNumOpt(v: unknown, field: string): number | undefined {
  return v === undefined || v === null ? undefined : parseNum(v, field)
}

/** Validate a required string wire arg → invalid_params. */
export function parseStr(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new McpArgError(`${field} must be a string`, field)
  return v
}

/** Validate a required boolean wire arg → invalid_params. */
export function parseBool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new McpArgError(`${field} must be a boolean`, field)
  return v
}

/** Optional boolean variant: undefined/null → dflt. */
export function parseBoolOpt(v: unknown, field: string, dflt: boolean): boolean {
  return v === undefined || v === null ? dflt : parseBool(v, field)
}

/** Optional string variant: undefined/null → null, else validates string. */
export function parseStrOpt(v: unknown, field: string): string | null {
  return v === undefined || v === null ? null : (typeof v === 'string' ? v : (() => { throw new McpArgError(`${field} must be a string`, field) })())
}

function asArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) throw new McpArgError(`${field} must be an array`)
  return v as string[]
}

// ── ToolResult shapers (wire.rs:81-93) ──
export function toolText(s: string): ToolResultJson { return { content: [{ type: 'text', text: s }] } }
export function toolEmpty(): ToolResultJson { return { content: [] } }
/** json results travel as a text block whose text is the SERIALIZED JSON with
 *  alpha-sorted keys (Rust serde_json preserve_order OFF → BTreeMap). Uses
 *  sortKeys (NOT canonicalize): wall-clock fields must stay real here — Rust
 *  returned real DateTime<Utc> (e.g. list_checkpoints.created_at), so the
 *  harness sentinel must not leak to MCP agents. The differential gate compares
 *  via its own canonicalize() of both sides, so this stays green. */
export function toolJson(v: unknown): ToolResultJson { return { content: [{ type: 'text', text: JSON.stringify(sortKeys(v)) }] } }

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
 *  shapeResult). Dedicated-exec tools carry stub records only — their
 *  parseDedicated arms are attached at registration. */
export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  exec: 'table' | 'dedicated'
  parseArgs?: (a: Record<string, unknown>) => { op: string; args: Record<string, unknown> }  // table-exec only
  shapeResult?: (value: unknown) => ToolResultJson                                             // table-exec only (default toolEmpty)
  parseDedicated?: (a: Record<string, unknown>) => Record<string, unknown>                    // dedicated-exec only
}

// ── Single-source MCP tool table ─────────────────────────────────────────────
// Each table-exec entry folds §2.5 hardening into parseArgs: every former
// `a.x as T` cast → parseX(a.x,'x'); optional booleans → parseBoolOpt; patch/
// flags objects stay structural (validated by the downstream mutation), but all
// uuid/number/enum scalars are parser-gated. The 19 dedicated stubs exist only
// so MCP_TOOLS projection stays complete; their behavior lives in actor.ts arms.
export const MCP_TOOL_DEFS: ReadonlyArray<McpToolDef> = [
  // ── table-exec: tracks ───────────────────────────────────────────────────
  { name: 'add_track', exec: 'table',
    description: 'Add a new track to the project. Returns the new track id as a UUID string. Tracks are kind-agnostic — any layer kind can be placed on any track.',
    inputSchema: { type: 'object', properties: { label: { type: ['string', 'null'] } }, required: [] },
    parseArgs: (a) => ({ op: 'add_track', args: { label: parseStrOpt(a.label, 'label') } }),
    shapeResult: (v) => toolText(v as string) },
  { name: 'remove_track', exec: 'table',
    description: 'Remove a track. Rejects if the track has layers unless force=true. Default A roll / B roll tracks cannot be removed.',
    inputSchema: { type: 'object', properties: { track_id: { type: 'string' }, force: { type: ['boolean', 'null'] } }, required: ['track_id'] },
    parseArgs: (a) => ({ op: 'delete_track', args: { track: parseUuid(a.track_id, 'track_id'), force: parseBoolOpt(a.force, 'force', false) } }) },
  { name: 'move_track', exec: 'table',
    description: 'Move a track to a different z-order position. 0 = bottom of stack. Position must be < current track count.',
    inputSchema: { type: 'object', properties: { track_id: { type: 'string' }, new_position: { type: 'integer' } }, required: ['new_position', 'track_id'] },
    parseArgs: (a) => ({ op: 'move_track', args: { track: parseUuid(a.track_id, 'track_id'), new_position: parseNum(a.new_position, 'new_position') } }) },
  // ── table-exec: layers ───────────────────────────────────────────────────
  { name: 'duplicate_layer', exec: 'table',
    description: 'Duplicate a layer with a time offset. The copy is inserted on the same track. Returns the new layer id. The composition duration extends if needed.',
    inputSchema: { type: 'object', properties: { layer_id: { type: 'string' }, t_offset_us: { type: 'integer' } }, required: ['layer_id', 't_offset_us'] },
    parseArgs: (a) => ({ op: 'duplicate_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), t_offset_us: parseNum(a.t_offset_us, 't_offset_us') } }),
    shapeResult: (v) => toolText(v as string) },
  { name: 'update_layer', exec: 'table',
    description: "Update a layer's envelope (label, time range, enabled, locked). Only fields you set are applied. Time range changes go through validation.",
    inputSchema: { type: 'object', properties: { layer_id: { type: 'string' }, patch: {
      type: 'object',
      properties: {
        label: { type: ['string', 'null'] },
        t_start_us: { type: 'integer' },
        t_end_us: { type: 'integer' },
        enabled: { type: 'boolean' },
        locked: { type: 'boolean' },
      },
    } }, required: ['layer_id', 'patch'] },
    parseArgs: (a) => ({ op: 'update_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), patch: a.patch } }) },
  { name: 'update_layer_params', exec: 'table',
    description: "Update a layer's kind-specific params. The patch is tagged with `kind` ('Text' | 'VideoClip' | 'ImageOverlay' | 'Color' | 'Audio') and must match the layer's kind. Audio fields take real effect in both preview and export: `gain_db` (dB; this patch sets a STATIC value, replacing any existing keyframes on the track), `pan` (-1..1 equal-power, same static-replace semantics), `fade_in_us`/`fade_out_us` (linear edge fades), `mute`, and `role` (one of dialogue/music/sfx/voiceover) to reassign the clip's mixing role.",
    inputSchema: { type: 'object', properties: { layer_id: { type: 'string' }, patch: {
      type: 'object',
      description: "Kind-tagged params patch. Must include `kind` matching the layer's kind ('Text' | 'VideoClip' | 'ImageOverlay' | 'Color' | 'Audio'). Only fields you include are applied.",
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['Text', 'VideoClip', 'ImageOverlay', 'Color', 'Audio'] },
        // Audio
        gain_db: { type: 'number' },
        pan: { type: 'number' },
        fade_in_us: { type: 'integer' },
        fade_out_us: { type: 'integer' },
        mute: { type: 'boolean' },
        role: { type: 'string', enum: ['dialogue', 'music', 'sfx', 'voiceover'] },
        src_in_us: { type: 'integer' },
        src_out_us: { type: 'integer' },
        // VideoClip / ImageOverlay / Motif / Color (common spatial)
        x: { type: 'number' },
        y: { type: 'number' },
        scale_x: { type: 'number' },
        scale_y: { type: 'number' },
        opacity: { type: 'number' },
        speed: { type: 'number' },
        flip_h: { type: 'boolean' },
        flip_v: { type: 'boolean' },
        // Color patch
        color: { type: 'object', properties: { r: { type: 'integer' }, g: { type: 'integer' }, b: { type: 'integer' }, a: { type: 'integer' } }, required: ['r', 'g', 'b', 'a'] },
        width: { type: 'integer' },
        height: { type: 'integer' },
        // Text patch
        content: { type: 'string' },
        font_family: { type: 'string' },
        font_size_px: { type: 'number' },
        // Motif patch
        motif_id: { type: 'string' },
        motif_version: { type: 'integer' },
        props: { type: 'object' },
      },
    } }, required: ['layer_id', 'patch'] },
    parseArgs: (a) => ({ op: 'update_layer_params', args: { layer: parseUuid(a.layer_id, 'layer_id'), patch: a.patch } }) },
  { name: 'move_layer', exec: 'table',
    description: 'Move a layer to a different track and/or start time. The end time shifts by the same delta. Cross-track moves are validated against the destination\'s existing layers — overlap rejects with structured options.',
    inputSchema: { type: 'object', properties: { layer_id: { type: 'string' }, new_t_start_us: { type: 'integer' }, new_track_id: { type: 'string' }, escape_group: { type: ['boolean', 'null'] } }, required: ['layer_id', 'new_t_start_us', 'new_track_id'] },
    parseArgs: (a) => ({ op: 'move_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), to_track: parseUuid(a.new_track_id, 'new_track_id'), t_start_us: parseNum(a.new_t_start_us, 'new_t_start_us'), escape_group: parseBoolOpt(a.escape_group, 'escape_group', false) } }) },
  { name: 'trim_layer', exec: 'table',
    description: "Trim one edge of a layer's timeline range. `edge` is 'in' (t_start) or 'out' (t_end). For media-bearing layers the corresponding src bound (src_in_us or src_out_us) moves by the same delta; over-trimming past the source bound is clamped. When the layer is in a group and `escape_group` is false (default), every group member whose corresponding edge sits at the same t as the trimmed edge is moved by the same delta, clamped to the tightest aligned member's bounds. Pass `escape_group=true` to trim only this layer. See `docs/groups.md`.",
    inputSchema: { type: 'object', properties: { layer_id: { type: 'string' }, edge: { type: 'string' }, new_t_us: { type: 'integer' }, escape_group: { type: ['boolean', 'null'] } }, required: ['edge', 'layer_id', 'new_t_us'] },
    parseArgs: (a) => ({ op: 'trim_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), edge: parseStr(a.edge, 'edge'), new_t_us: parseNum(a.new_t_us, 'new_t_us'), escape_group: parseBoolOpt(a.escape_group, 'escape_group', false) } }) },
  { name: 'delete_layer', exec: 'table',
    description: 'Delete a layer. When the project setting `auto_delete_empty_tracks` is on (default) and this empties a non-reserved, unlocked track, the track is deleted in the same history entry (one undo restores both). A/B-roll and other role-stamped tracks always stay.',
    inputSchema: { type: 'object', properties: { layer_id: { type: 'string' } }, required: ['layer_id'] },
    parseArgs: (a) => ({ op: 'delete_layer', args: { layer: parseUuid(a.layer_id, 'layer_id') } }) },
  // ── table-exec: groups ───────────────────────────────────────────────────
  { name: 'groups_create', exec: 'table',
    description: 'Create a new group from >=2 distinct layer ids. Optional `label`. If any layer is already in another group, the op fails unless `reassign=true`, which removes them from their prior group(s) first (auto-dissolving any group that falls below 2 members). Returns the new group id.',
    inputSchema: { type: 'object', properties: { layer_ids: { type: 'array' }, label: { type: ['string', 'null'] }, reassign: { type: ['boolean', 'null'] } }, required: ['layer_ids'] },
    parseArgs: (a) => ({ op: 'groups_create', args: { layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')), label: parseStrOpt(a.label, 'label'), reassign: parseBoolOpt(a.reassign, 'reassign', false) } }),
    shapeResult: (v) => toolText(v as string) },
  { name: 'groups_dissolve', exec: 'table',
    description: 'Dissolve (delete) a group. The member layers themselves are not deleted.',
    inputSchema: { type: 'object', properties: { group_id: { type: 'string' } }, required: ['group_id'] },
    parseArgs: (a) => ({ op: 'groups_dissolve', args: { group: parseUuid(a.group_id, 'group_id') } }) },
  { name: 'groups_add_members', exec: 'table',
    description: 'Add member layers to an existing group. Same reassign semantics as groups_create.',
    inputSchema: { type: 'object', properties: { group_id: { type: 'string' }, layer_ids: { type: 'array' }, reassign: { type: ['boolean', 'null'] } }, required: ['group_id', 'layer_ids'] },
    parseArgs: (a) => ({ op: 'groups_add_members', args: { group: parseUuid(a.group_id, 'group_id'), layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')), reassign: parseBoolOpt(a.reassign, 'reassign', false) } }) },
  { name: 'groups_remove_members', exec: 'table',
    description: 'Remove member layers from a group. If the remaining membership falls below 2, the group auto-dissolves.',
    inputSchema: { type: 'object', properties: { group_id: { type: 'string' }, layer_ids: { type: 'array' } }, required: ['group_id', 'layer_ids'] },
    parseArgs: (a) => ({ op: 'groups_remove_members', args: { group: parseUuid(a.group_id, 'group_id'), layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')) } }) },
  { name: 'groups_rename', exec: 'table',
    description: "Update a group's label. Pass `label: null` to clear it.",
    inputSchema: { type: 'object', properties: { group_id: { type: 'string' }, label: { type: ['string', 'null'] } }, required: ['group_id'] },
    parseArgs: (a) => ({ op: 'groups_rename', args: { group: parseUuid(a.group_id, 'group_id'), label: parseStrOpt(a.label, 'label') } }) },
  // ── table-exec: effects ──────────────────────────────────────────────────
  { name: 'add_effect', exec: 'table',
    description: 'Add an effect to a layer\'s chain (appended to the end of the chain, applied last). `kind` is the catalog key ("blur", "chromakey"). Returns the new effect id. The effect is created with no params set; use update_effect to set a static value first, then set_keyframe to keyframe it.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string' }, layer_id: { type: 'string' } }, required: ['kind', 'layer_id'] },
    parseArgs: (a) => ({ op: 'add_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), kind: parseStr(a.kind, 'kind') } }),
    shapeResult: (v) => toolText(v as string) },
  { name: 'update_effect', exec: 'table',
    description: 'Update an effect: patch is `{ enabled?, params? }` where params is `{ paramKey: { "mode": "Static", "value": <number> } }` (v1 params are scalar). For keyframed params use set_keyframe with param_key "effects[<effect_id>].params[<key>]".',
    inputSchema: { type: 'object', properties: { effect_id: { type: 'string' }, layer_id: { type: 'string' }, patch: {} }, required: ['effect_id', 'layer_id', 'patch'] },
    parseArgs: (a) => ({ op: 'update_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id'), patch: a.patch } }) },
  { name: 'move_effect', exec: 'table',
    description: 'Reorder an effect within its layer\'s chain. new_index is 0-based; 0 = first applied. Must be < effect count.',
    inputSchema: { type: 'object', properties: { effect_id: { type: 'string' }, layer_id: { type: 'string' }, new_index: { type: 'integer' } }, required: ['effect_id', 'layer_id', 'new_index'] },
    parseArgs: (a) => ({ op: 'move_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id'), new_index: parseNum(a.new_index, 'new_index') } }) },
  { name: 'remove_effect', exec: 'table',
    description: 'Remove an effect from a layer by id.',
    inputSchema: { type: 'object', properties: { effect_id: { type: 'string' }, layer_id: { type: 'string' } }, required: ['effect_id', 'layer_id'] },
    parseArgs: (a) => ({ op: 'remove_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id') } }) },
  // ── table-exec: composition ──────────────────────────────────────────────
  { name: 'set_composition', exec: 'table',
    description: 'Update composition envelope (canvas size, fps, sample rate, channels, color space, background, duration). Only fields you set are applied. Width/height must be positive; fps denominator must be non-zero. Setting `duration_us` pins the composition duration — subsequent layer edits will no longer auto-fit it (except an overflow guard if a layer extends past the pinned value). Use `fit_composition_to_layers` to clear the pin and snap duration back to the layer high-water mark.',
    inputSchema: { type: 'object', properties: { patch: {} }, required: ['patch'] },
    parseArgs: (a) => ({ op: 'set_composition', args: a.patch as Record<string, unknown> }) },
  { name: 'fit_composition_to_layers', exec: 'table',
    description: "Clear the composition's duration pin and set `duration_us` to `max(layer.t_end_us)`. The inverse of `set_composition { duration_us }`: that pins, this unpins. After this call, subsequent layer edits track duration in both directions (grow on adds, shrink on deletes/inward trims).",
    inputSchema: { type: 'object', properties: {}, required: [] },
    parseArgs: () => ({ op: 'fit_composition_to_layers', args: {} }) },
  // ── table-exec: markers ──────────────────────────────────────────────────
  { name: 'update_marker', exec: 'table',
    description: 'Update a marker. Setting `t_us` re-sorts the marker list.',
    inputSchema: { type: 'object', properties: { marker_id: { type: 'string' }, patch: {} }, required: ['marker_id', 'patch'] },
    parseArgs: (a) => ({ op: 'update_marker', args: { marker: parseUuid(a.marker_id, 'marker_id'), patch: a.patch } }) },
  { name: 'remove_marker', exec: 'table',
    description: 'Remove a marker.',
    inputSchema: { type: 'object', properties: { marker_id: { type: 'string' } }, required: ['marker_id'] },
    parseArgs: (a) => ({ op: 'remove_marker', args: { marker: parseUuid(a.marker_id, 'marker_id') } }) },
  // ── table-exec: media ────────────────────────────────────────────────────
  { name: 'remove_media', exec: 'table',
    description: 'Remove a media item. Rejects if any layer references it unless force=true. With force=true, also deletes the referencing layers in one atomic commit.',
    inputSchema: { type: 'object', properties: { media_id: { type: 'string' }, force: { type: ['boolean', 'null'] } }, required: ['media_id'] },
    parseArgs: (a) => ({ op: 'remove_media', args: { media: parseUuid(a.media_id, 'media_id'), force: parseBoolOpt(a.force, 'force', false) } }) },
  // ── table-exec: history ──────────────────────────────────────────────────
  { name: 'undo', exec: 'table',
    description: 'Undo the most recent edit (linear history). Errors with NothingToUndo at the origin. Only timeline edits (layers, tracks, markers, transitions, composition duration, and cascade-deleting media removals) record onto the undo stack. The following sit OUTSIDE it and are unaffected by undo: media imports and removals of unreferenced media, canvas setup changes (width/height/fps/sample_rate/channels/color_space/background), and loading or creating a project (which resets history).',
    inputSchema: { type: 'object', properties: {}, required: [] },
    parseArgs: () => ({ op: 'undo', args: {} }) },
  { name: 'redo', exec: 'table',
    description: 'Redo the next edit. Errors with NothingToRedo if no redo is available. A new commit truncates the redo tail.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    parseArgs: () => ({ op: 'redo', args: {} }) },
  // ── table-exec: audio roles ──────────────────────────────────────────────
  { name: 'set_role_gain', exec: 'table',
    description: 'Set an audio role\'s mix gain (dB). role ∈ {dialogue,music,sfx,voiceover}. Recorded (undoable). Folds into every layer of that role at mix time.',
    inputSchema: { type: 'object', properties: { gain_db: { type: 'number' }, role: { type: 'string', enum: ['dialogue', 'music', 'sfx', 'voiceover'] } }, required: ['gain_db', 'role'] },
    parseArgs: (a) => ({ op: 'set_role_gain', args: { role: parseRole(a.role), gain_db: parseNum(a.gain_db, 'gain_db') } }) },
  // set_role_flags: patch stays structural (muted/solo are nullable booleans validated by the mutation)
  { name: 'set_role_flags', exec: 'table',
    description: 'Mute/solo an audio role. role ∈ {dialogue,music,sfx,voiceover}. Unrecorded (not undoable). Mute wins over solo; any solo silences non-soloed roles.',
    inputSchema: { type: 'object', properties: { role: { type: 'string', enum: ['dialogue', 'music', 'sfx', 'voiceover'] }, muted: { type: ['boolean', 'null'] }, solo: { type: ['boolean', 'null'] } }, required: ['role'] },
    parseArgs: (a) => ({ op: 'update_role_flags', args: { role: parseRole(a.role), patch: { muted: a.muted ?? null, solo: a.solo ?? null } } }) },
  // ── dedicated-exec (19) — parseDedicated validates and maps MCP args; behavior lives in actor.ts arms ──
  { name: 'add_color_layer', exec: 'dedicated',
    description: 'Add a solid-color layer to a track. Returns the new layer id. `t_start_us` and `t_end_us` are timeline microseconds (start inclusive, end exclusive). Layer cannot overlap existing layers on the same track.',
    inputSchema: { type: 'object', properties: { color: { type: 'object', properties: { r: { type: 'integer' }, g: { type: 'integer' }, b: { type: 'integer' }, a: { type: 'integer' } }, required: ['r', 'g', 'b', 'a'] }, height: { type: ['integer', 'null'] }, t_end_us: { type: 'integer' }, t_start_us: { type: 'integer' }, track_id: { type: 'string' }, width: { type: ['integer', 'null'] } }, required: ['color', 't_end_us', 't_start_us', 'track_id'] },
    parseDedicated: (a) => ({ track: parseUuid(a.track_id, 'track_id'), color: parseRgba(a.color, 'color'),
      width: parseNumOpt(a.width, 'width'), height: parseNumOpt(a.height, 'height'),
      t_start_us: parseNum(a.t_start_us, 't_start_us'), t_end_us: parseNum(a.t_end_us, 't_end_us') }) },
  { name: 'add_video_layer', exec: 'dedicated',
    description: "Add a visual media layer from an imported media item onto a track. For Video media, `src_in_us`/`src_out_us` are the in/out points within the source media; `t_start_us`/`t_end_us` are where the clip lives on the timeline. For Image media, this creates an ImageOverlay over the timeline range, and `src_in_us`/`src_out_us` are accepted for schema compatibility but ignored. Video source and timeline ranges should be the same length unless `speed` is later changed. When a Video source has an audio stream and the project's `auto_pair_audio_on_import` setting is on (default), this also creates a paired Audio layer on an audio track at the same time bounds and groups the two so they move/trim/split together. Returns either the visual layer id (legacy mode) or `{ video_layer_id, audio_layer_id, group_id }` when a pair was created.",
    inputSchema: { type: 'object', properties: { media_id: { type: 'string' }, src_in_us: { type: 'integer' }, src_out_us: { type: 'integer' }, t_end_us: { type: 'integer' }, t_start_us: { type: 'integer' }, track_id: { type: 'string' } }, required: ['media_id', 'src_in_us', 'src_out_us', 't_end_us', 't_start_us', 'track_id'] },
    parseDedicated: (a) => ({ track: parseUuid(a.track_id, 'track_id'), media: parseUuid(a.media_id, 'media_id'),
      src_in_us: parseNum(a.src_in_us, 'src_in_us'), src_out_us: parseNum(a.src_out_us, 'src_out_us'),
      t_start_us: parseNum(a.t_start_us, 't_start_us'), t_end_us: parseNum(a.t_end_us, 't_end_us') }) },
  { name: 'split_layer', exec: 'dedicated',
    description: 'Split a layer into two halves at the given timeline microsecond. Returns {left, right} layer ids. `at_t_us` must be strictly between the layer\'s t_start_us and t_end_us. For media-bearing layers (VideoClip, Audio) the source offsets are adjusted at speed=1 — variable speed support is deferred.',
    inputSchema: { type: 'object', properties: { at_t_us: { type: 'integer' }, escape_group: { type: ['boolean', 'null'] }, layer_id: { type: 'string' } }, required: ['at_t_us', 'layer_id'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'),
      at_t_us: parseNum(a.at_t_us, 'at_t_us'), escape_group: a.escape_group }) },
  { name: 'add_marker', exec: 'dedicated',
    description: 'Add a marker (point or region) to the timeline. Returns the new marker id. Set `end_t_us` to make it a region marker.',
    inputSchema: { type: 'object', properties: { color: { type: 'object', properties: { r: { type: 'integer' }, g: { type: 'integer' }, b: { type: 'integer' }, a: { type: 'integer' } }, required: ['r', 'g', 'b', 'a'] }, end_t_us: { type: ['integer', 'null'] }, label: { type: 'string' }, t_us: { type: 'integer' } }, required: ['color', 'label', 't_us'] },
    parseDedicated: (a) => ({ color: parseRgba(a.color, 'color'), t_us: parseNum(a.t_us, 't_us'),
      end_t_us: parseNumOpt(a.end_t_us, 'end_t_us'), label: parseStr(a.label, 'label') }) },
  { name: 'lock_history', exec: 'dedicated',
    description: 'Block the user from reverting (undo / redo / restore_checkpoint) while the agent is mid-batch. `reason` is shown next to the lock badge in the record-panel header and as the error returned to revert attempts. Last-writer-wins. Always pair with an unlock_history call; releases also happen on workspace change and on user-side agent-mode exit.',
    inputSchema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    parseDedicated: (a) => ({ reason: parseStr(a.reason, 'reason') }) },
  { name: 'unlock_history', exec: 'dedicated',
    description: 'Release the revert-lock taken by lock_history. Idempotent — calling while already unlocked is a no-op.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    parseDedicated: (_a) => ({}) },
  { name: 'set_keyframe', exec: 'dedicated',
    description: 'Insert or update a keyframe on a layer param. `t_us` is timeline-absolute. A Static track is lifted to Keyframed. An existing key at the same frame is updated in place. `interp` (optional) sets the easing for the segment leaving this key (e.g. {"kind":"Linear"}, {"kind":"EaseIn"}, {"kind":"Bezier","p1":[x,y],"p2":[x,y]}); omit to inherit the preceding key\'s easing (or Linear).',
    inputSchema: { type: 'object', properties: { interp: {}, layer_id: { type: 'string' }, param_key: { type: 'string' }, t_us: { type: 'integer' }, value: { type: 'number' } }, required: ['interp', 'layer_id', 'param_key', 't_us', 'value'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), param_key: parseStr(a.param_key, 'param_key'),
      t_us: parseNum(a.t_us, 't_us'), value: parseNum(a.value, 'value'), interp: parseInterpOpt(a.interp) }) },
  { name: 'get_param_track', exec: 'dedicated',
    description: 'Read a layer param\'s animation track, flattened for editing. Returns {"mode":"Static","value":n} or {"mode":"Keyframed","keyframes":[{id, t_us, t_local_us, value, interp}]}. `t_us` is timeline-absolute; `t_local_us` is layer-local (the stored base). Use this to discover keyframe ids before editing.',
    inputSchema: { type: 'object', properties: { layer_id: { type: 'string' }, param_key: { type: 'string' } }, required: ['layer_id', 'param_key'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), param_key: parseStr(a.param_key, 'param_key') }) },
  { name: 'remove_keyframe', exec: 'dedicated',
    description: 'Remove a keyframe by id from a layer param. Get the id from get_param_track. When it was the last key, the track collapses to Static holding that key\'s value.',
    inputSchema: { type: 'object', properties: { keyframe_id: { type: 'string' }, layer_id: { type: 'string' }, param_key: { type: 'string' } }, required: ['keyframe_id', 'layer_id', 'param_key'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), keyframe_id: parseUuid(a.keyframe_id, 'keyframe_id'),
      param_key: parseStr(a.param_key, 'param_key') }) },
  { name: 'retime_keyframe', exec: 'dedicated',
    description: 'Move a keyframe to a new timeline-absolute time. The track re-sorts.',
    inputSchema: { type: 'object', properties: { keyframe_id: { type: 'string' }, layer_id: { type: 'string' }, param_key: { type: 'string' }, t_us: { type: 'integer' } }, required: ['keyframe_id', 'layer_id', 'param_key', 't_us'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), keyframe_id: parseUuid(a.keyframe_id, 'keyframe_id'),
      param_key: parseStr(a.param_key, 'param_key'), t_us: parseNum(a.t_us, 't_us') }) },
  { name: 'set_keyframe_easing', exec: 'dedicated',
    description: 'Set the easing of the segment leaving a keyframe. `interp`: {"kind":"Hold"} | {"kind":"Linear"} | {"kind":"EaseIn"} | {"kind":"EaseOut"} | {"kind":"Bezier","p1":[x,y],"p2":[x,y]}.',
    inputSchema: { type: 'object', properties: { interp: {}, keyframe_id: { type: 'string' }, layer_id: { type: 'string' }, param_key: { type: 'string' } }, required: ['interp', 'keyframe_id', 'layer_id', 'param_key'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), keyframe_id: parseUuid(a.keyframe_id, 'keyframe_id'),
      param_key: parseStr(a.param_key, 'param_key'), interp: parseInterp(a.interp) }) },
  { name: 'smooth_keyframes', exec: 'dedicated',
    description: 'Bake monotone (no-overshoot) smooth tangents. With `keyframe_id`, smooths that one key; without it, smooths the whole track.',
    inputSchema: { type: 'object', properties: { keyframe_id: { type: ['string', 'null'] }, layer_id: { type: 'string' }, param_key: { type: 'string' } }, required: ['layer_id', 'param_key'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), param_key: parseStr(a.param_key, 'param_key'),
      keyframe_id: a.keyframe_id != null ? parseUuid(a.keyframe_id, 'keyframe_id') : null }) },
  { name: 'clear_keyframes', exec: 'dedicated',
    description: "Collapse a param's animation back to a single Static value. `value` (optional) is the value to hold; when omitted, defaults to the first keyframe's value. No-op on an already-Static track.",
    inputSchema: { type: 'object', properties: { layer_id: { type: 'string' }, param_key: { type: 'string' }, value: { type: ['number', 'null'] } }, required: ['layer_id', 'param_key'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), param_key: parseStr(a.param_key, 'param_key'),
      value: parseNumOpt(a.value, 'value') }) },
  { name: 'set_param_track', exec: 'dedicated',
    description: 'Low-level: replace a layer param\'s whole animation track. `track` is an AnimTrack<f64>: {"mode":"Static","value":n} or {"mode":"Keyframed","value":[{id, t_us, value, interp}]} with keyframe `t_us` timeline-absolute. Use the granular tools (set_keyframe etc.) unless you need bulk authoring.',
    inputSchema: { type: 'object', properties: { layer_id: { type: 'string' }, param_key: { type: 'string' }, track: {} }, required: ['layer_id', 'param_key', 'track'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), param_key: parseStr(a.param_key, 'param_key'),
      track: parseAnimatedF64(a.track) }) },
  { name: 'dry_run', exec: 'dedicated',
    description: 'Try-run a sequence of edit operations against a clone of the current project WITHOUT committing. Useful for previewing complex multi-step edits — agents can detect overlap / invariant violations before mutating real state. Validates after each op (matching real `commit()` behaviour) and HALTS at the first error so subsequent ops don\'t dry-run against a state real execution wouldn\'t reach. Returns `{ results: [{ index, status, output? | error? }, ...] }`. Supports add_color_layer, add_video_layer, update_layer, update_layer_params, move_layer, split_layer, delete_layer. Other tools (motifs, caption import, media import, undo/redo) are not dry-runnable in v1.',
    inputSchema: { type: 'object', properties: { operations: { type: 'array' } }, required: ['operations'] },
    parseDedicated: (a) => ({ operations: asArray(a.operations, 'operations') }) },
  { name: 'add_motif', exec: 'dedicated',
    description: "Add a motif layer to a track. The motif is rasterized to a PNG sequence on first render and cached content-addressably; subsequent renders are folder lookups. Args: `motif_id` (from `list_motifs`), `t_start_us` (timeline microseconds), optional `t_end_us` (defaults to `t_start_us + default_duration_s * 1e6`), optional `track_id` (when omitted, always spawns a fresh track labeled 'Overlay' — never reuses an existing track, so consecutive auto-inserts can't collide), optional `props` (JSON object matched against the motif's `props_schema`; unknown keys reject, missing keys fall back to defaults). Returns the new layer id.",
    inputSchema: { '$schema': 'http://json-schema.org/draft-07/schema#', type: 'object',
      properties: {
        motif_id: { type: 'string', description: 'Motif id from `list_motifs` (e.g. "lower-third-simple", "title-card").' },
        t_start_us: { type: 'integer', format: 'int64', description: 'Layer start in timeline microseconds.' },
        t_end_us: { type: ['integer', 'null'], format: 'int64', description: 'Layer end in timeline microseconds. Defaults to `t_start_us + default_duration_s * 1_000_000` when omitted.' },
        track_id: { type: ['string', 'null'], description: 'Target track id. If omitted, a fresh track labeled "Overlay" is created.' },
        props: { description: 'Motif props as a JSON object. Keys must match the motif\'s `props_schema`; unknown keys reject; missing keys fill from defaults.' },
      },
      required: ['motif_id', 'props', 't_start_us'] },
    parseDedicated: (a) => ({
      motif_id: parseStr(a.motif_id, 'motif_id'),
      t_start_us: parseNum(a.t_start_us, 't_start_us'),
      t_end_us: parseNumOpt(a.t_end_us, 't_end_us') ?? null,
      track_id: a.track_id != null ? parseUuid(a.track_id, 'track_id') : null,
      props: a.props ?? null,
    }) },
  { name: 'checkpoint', exec: 'dedicated',
    description: 'Create an explicit named checkpoint of the current state. Checkpoints survive new commits (they don\'t get truncated like the redo tail) and persist in the .vproj save file. Returns the new checkpoint id. The human\'s agent-mode record panel renders each created checkpoint as a pin-style row with a Restore button — use this at logical batch boundaries.',
    inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
    parseDedicated: (a) => ({ label: parseStr(a.label, 'label') }) },
  { name: 'list_checkpoints', exec: 'dedicated',
    description: 'List all named checkpoints, oldest first. Returns id, label, actor, created_at per checkpoint (no project snapshot).',
    inputSchema: { type: 'object', properties: {}, required: [] },
    parseDedicated: (_a) => ({}) },
  { name: 'restore_checkpoint', exec: 'dedicated',
    description: 'Restore a named checkpoint. Records a new history entry — undo will return to the pre-restore state. Errors with CheckpointNotFound if the id doesn\'t exist. The agent-mode record panel prunes the rolled-back agent actions from view; a small \'↩ Restored to <label>\' row marks the boundary.',
    inputSchema: { type: 'object', properties: { checkpoint_id: { type: 'string' } }, required: ['checkpoint_id'] },
    parseDedicated: (a) => ({ checkpoint_id: parseUuid(a.checkpoint_id, 'checkpoint_id') }) },
  { name: 'begin_agent_session', exec: 'dedicated',
    description: "Enter agent mode: flip the human's UI to a simplified preview / scrub / record-only layout while the agent makes changes. `reason` is a short free-text label shown in the record panel header (e.g. 'cutting filler words'). Creates an automatic checkpoint named 'Pre-agent: {reason}' so the human can revert the entire session in one click. Calling this while already in agent mode replaces the session. The human exits via the UI; there is no end_agent_session tool.",
    inputSchema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    parseDedicated: (a) => ({ reason: parseStr(a.reason, 'reason') }) },
]

const DEF_BY_NAME: Map<string, McpToolDef> = new Map(MCP_TOOL_DEFS.map((d) => [d.name, d]))
export function mcpDef(name: string): McpToolDef { const d = DEF_BY_NAME.get(name); if (!d) throw new Error(`no MCP def for ${name}`); return d }

/** MCP tool → internal dispatch op + renamed args. Projection of MCP_TOOL_DEFS.
 *  Explicit-param tools (add_color_layer/add_video_layer/add_marker/split_layer
 *  etc.) are NOT here — they have dedicated arms in actor.mcpCall. */
export const MCP_ARG_PARSERS: Record<string, (a: Record<string, unknown>) => { op: string; args: Record<string, unknown> }> =
  Object.fromEntries(MCP_TOOL_DEFS.flatMap((d) => d.parseArgs ? [[d.name, d.parseArgs] as const] : []))

/** MCP tool → ToolResult from the dispatch value. Projection of MCP_TOOL_DEFS.
 *  Tools absent here → toolEmpty. */
export const MCP_RESULT_SHAPERS: Record<string, (value: unknown) => ToolResultJson> =
  Object.fromEntries(MCP_TOOL_DEFS.flatMap((d) => d.shapeResult ? [[d.name, d.shapeResult] as const] : []))

/** All MCP tools this adapter handles (parsers + the dedicated arms). Projection of MCP_TOOL_DEFS. */
export const MCP_TOOLS: ReadonlySet<string> = new Set(MCP_TOOL_DEFS.map((d) => d.name))
