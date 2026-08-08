// apps/desktop/src/main/state/mcp-commands.ts
// Pure MCP-tool adapter helpers: arg parsing (snake_case MCP vocab → internal
// dispatch vocab), ToolResult shaping, and CommandError → MCP error mapping.
// The byte-exact mcp.differential gate (vs Rust dispatch_tool) is the backstop.
// Mirrors native/src/mcp/{tools.rs,wire.rs}.
import type { CommandError } from './errors'
import type { Animated, EaseDir, Interpolation, Keyframe, Rgba, TransitionDirection, TransitionKind } from './model'
import type { EffectPatch } from './mutations/effects'
import type { MarkerPatch } from './mutations/markers'
import { sortKeys } from './canonical'
import { EASING_PRESETS, ELASTIC_DEFAULT_AMPLITUDE, ELASTIC_DEFAULT_PERIOD, cloneInterp, presetIdForInterp } from '../../shared/easing'

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

const INTERP_KINDS = `'Hold' | 'Linear' | 'Bezier' | 'Elastic' | 'Bounce'`
const EASE_DIRS = new Set<string>(['In', 'Out', 'InOut'])
const isPair = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number'

function parseEaseDir(v: unknown, kind: string): EaseDir {
  if (typeof v !== 'string' || !EASE_DIRS.has(v))
    throw new McpArgError(`invalid interp: ${kind} needs dir 'In' | 'Out' | 'InOut', got ${String(v)}`)
  return v as EaseDir
}

/** Validate an Interpolation — the closed wire union single-sourced in
 *  src/shared/easing.ts (Hold | Linear | Bezier | Elastic | Bounce). Elastic
 *  amplitude/period may be omitted and take the shared authoring defaults, so
 *  the parsed value is always a complete wire object. Bezier control-point x
 *  is gated to [0, 1] — x is segment time, and the solver is single-valued
 *  only on that range. Throws McpArgError on malformed input → invalid_params. */
export function parseInterp(v: unknown): Interpolation {
  if (v === null || typeof v !== 'object') throw new McpArgError(`invalid interp: not an object`)
  const o = v as Record<string, unknown>
  const kind = o.kind
  if (typeof kind !== 'string') {
    if (typeof o.preset === 'string')
      throw new McpArgError(`invalid interp: preset ids are a set_keyframe_easing payload — this argument takes a raw kind ${INTERP_KINDS}`)
    throw new McpArgError(`invalid interp: missing 'kind' (${INTERP_KINDS})`)
  }
  if (kind === 'Hold' || kind === 'Linear') return { kind }
  if (kind === 'Bezier') {
    const p1 = o.p1
    const p2 = o.p2
    if (!isPair(p1) || !isPair(p2)) throw new McpArgError(`invalid interp: Bezier needs p1/p2 as [number, number]`)
    if (!(p1[0] >= 0 && p1[0] <= 1)) throw new McpArgError(`invalid interp: Bezier p1[0] (x) must be within [0, 1], got ${p1[0]} — x is segment time; only y may overshoot`)
    if (!(p2[0] >= 0 && p2[0] <= 1)) throw new McpArgError(`invalid interp: Bezier p2[0] (x) must be within [0, 1], got ${p2[0]} — x is segment time; only y may overshoot`)
    return { kind: 'Bezier', p1, p2 }
  }
  if (kind === 'Elastic') {
    const dir = parseEaseDir(o.dir, 'Elastic')
    const amplitude = o.amplitude === undefined || o.amplitude === null ? ELASTIC_DEFAULT_AMPLITUDE : parseNum(o.amplitude, 'interp.amplitude')
    if (amplitude < 1) throw new McpArgError(`invalid interp: Elastic amplitude must be >= 1, got ${amplitude} (omit it for the default ${ELASTIC_DEFAULT_AMPLITUDE})`)
    const period = o.period === undefined || o.period === null ? ELASTIC_DEFAULT_PERIOD : parseNum(o.period, 'interp.period')
    if (period <= 0) throw new McpArgError(`invalid interp: Elastic period must be > 0, got ${period} (omit it for the default ${ELASTIC_DEFAULT_PERIOD})`)
    return { kind: 'Elastic', dir, amplitude, period }
  }
  if (kind === 'Bounce') return { kind: 'Bounce', dir: parseEaseDir(o.dir, 'Bounce') }
  if (kind === 'EaseIn' || kind === 'EaseOut')
    throw new McpArgError(`invalid interp: '${kind}' is not a kind — named eases are presets (set_keyframe_easing takes {"preset":"${kind === 'EaseIn' ? 'ease_in' : 'ease_out'}"}); kinds: ${INTERP_KINDS}`)
  throw new McpArgError(`invalid interp: unknown kind '${kind}' — expected ${INTERP_KINDS}`)
}

/** Optional variant: undefined passes through (set_keyframe's interp is Option). */
export function parseInterpOpt(v: unknown): Interpolation | undefined {
  return v === undefined ? undefined : parseInterp(v)
}

/** set_keyframe_easing's payload union: {"preset":"<id>"} bakes to a fresh
 *  copy of the canonical table entry's params (cloneInterp — the table IS the
 *  params, nothing is re-derived here); anything else parses as a raw
 *  Interpolation. Exactly one of preset/kind: both together is ambiguous and
 *  rejects. The unknown-preset error carries the full live id list in the
 *  MESSAGE — the client drops error.data, so options must ride the message. */
export function parseEasing(v: unknown): Interpolation {
  if (v === null || typeof v !== 'object') throw new McpArgError(`invalid interp: not an object`)
  const o = v as Record<string, unknown>
  if (o.preset === undefined || o.preset === null) {
    if (o.kind === undefined) throw new McpArgError(`invalid interp: send {"preset":"<id>"} or a raw kind ${INTERP_KINDS}`)
    return parseInterp(v)
  }
  if (o.kind !== undefined) throw new McpArgError(`invalid interp: send either {"preset":"<id>"} or a raw {"kind":...}, not both`)
  const hit = typeof o.preset === 'string' ? EASING_PRESETS.find((p) => p.id === o.preset) : undefined
  if (!hit) throw new McpArgError(`invalid interp: unknown preset '${String(o.preset)}' — presets: ${EASING_PRESETS.map((p) => p.id).join(', ')}`)
  return cloneInterp(hit.interp)
}

/** Validate an Animated<number> (model.ts) — mirrors the Rust serde form of
 *  Animated<f64> in state/animated.rs. Throws McpArgError → invalid_params. */
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

/** Gate a structural patch/props argument: a plain JSON object, never a
 *  string/array/null. Every apply* mutation reads patch fields through `typeof`
 *  guards, so an unparsed patch (e.g. the JSON-encoded string an MCP client
 *  sends for an untyped schema field) would commit nothing and still report
 *  success — the one failure mode worse than rejection. */
export function parseObj(v: unknown, field: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v))
    throw new McpArgError(`${field} must be a JSON object, got ${Array.isArray(v) ? 'an array' : typeof v}`, field)
  return v as Record<string, unknown>
}

/** Strict update_effect patch — mirrors EffectPatch (mutations/effects.ts).
 *  Unknown keys and malformed values reject; applyUpdateEffect would otherwise
 *  silently skip them (issue 02, .scratch/mcp-agent-hardening). */
export function parseEffectPatch(v: unknown): EffectPatch {
  const o = parseObj(v, 'patch')
  for (const k of Object.keys(o)) {
    if (k !== 'enabled' && k !== 'params')
      throw new McpArgError(`invalid patch: unknown key '${k}' — expected { enabled?: boolean, params?: { "<param>": { "mode": "Static", "value": <number> } } }`)
  }
  const out: EffectPatch = {}
  if (o.enabled !== undefined && o.enabled !== null) {
    if (typeof o.enabled !== 'boolean') throw new McpArgError(`invalid patch: enabled must be a boolean`)
    out.enabled = o.enabled
  }
  if (o.params !== undefined && o.params !== null) {
    const p = parseObj(o.params, 'patch.params')
    const params: Record<string, Animated<number>> = {}
    for (const [k, pv] of Object.entries(p)) {
      try { params[k] = parseAnimatedF64(pv) }
      catch (e) { throw new McpArgError(`invalid patch: params['${k}']: ${e instanceof McpArgError ? e.mcpMessage : String(e)}`) }
    }
    out.params = params
  }
  return out
}

/** Strict update_marker patch — same lie-prevention as parseEffectPatch.
 *  null = "don't touch" (end_t_us can be set, never cleared: remove+add). */
export function parseMarkerPatch(v: unknown): MarkerPatch {
  const o = parseObj(v, 'patch')
  for (const k of Object.keys(o)) {
    if (k !== 't_us' && k !== 'end_t_us' && k !== 'label' && k !== 'color')
      throw new McpArgError(`invalid patch: unknown key '${k}' — expected { t_us?, end_t_us?, label?, color? }`)
  }
  parseNumOpt(o.t_us, 'patch.t_us')
  parseNumOpt(o.end_t_us, 'patch.end_t_us')
  if (o.label !== undefined && o.label !== null && typeof o.label !== 'string')
    throw new McpArgError(`patch.label must be a string`, 'patch')
  if (o.color !== undefined && o.color !== null) parseRgba(o.color, 'patch.color')
  return o as MarkerPatch
}

const AUDIO_ROLES = new Set(['dialogue', 'music', 'sfx', 'voiceover'])
/** Validate an AudioRole (audio_role.rs kebab-case). Rust rejects an unknown
 *  role at the serde boundary → invalid_params; mirror that here. */
export function parseRole(v: unknown): string {
  if (typeof v !== 'string' || !AUDIO_ROLES.has(v)) throw new McpArgError(`unknown audio role '${String(v)}'`)
  return v
}

const TRANSITION_KINDS = new Set(['Crossfade', 'Wipe', 'Slide'])
const TRANSITION_DIRECTIONS = new Set(['left', 'right', 'up', 'down'])
/** Flat (kind, direction) wire args → TransitionKind (model.ts). Strict on
 *  the pairing so agents get a precise error instead of a silently ignored
 *  field: Wipe/Slide REQUIRE direction; Crossfade REJECTS one. Shared by the
 *  actor dispatch arms and the MCP parsers (single source — no drift). */
export function parseTransitionKind(kind: unknown, direction: unknown): TransitionKind {
  if (typeof kind !== 'string' || !TRANSITION_KINDS.has(kind))
    throw new McpArgError(`unknown transition kind '${String(kind)}' (expected 'Crossfade' | 'Wipe' | 'Slide')`, 'kind')
  if (kind === 'Crossfade') {
    if (direction !== undefined && direction !== null)
      throw new McpArgError(`direction does not apply to Crossfade — omit it (only Wipe/Slide take one)`, 'direction')
    return { kind: 'Crossfade' }
  }
  if (typeof direction !== 'string' || !TRANSITION_DIRECTIONS.has(direction))
    throw new McpArgError(`${kind} requires direction 'left' | 'right' | 'up' | 'down', got ${String(direction)}`, 'direction')
  return { kind: kind as 'Wipe' | 'Slide', direction: direction as TransitionDirection }
}

/** update_transition's optional (kind, direction) pair → TransitionKind or
 *  undefined (no kind patch). direction rides INSIDE kind, so direction
 *  without kind is rejected — patch both together. */
export function parseTransitionKindOpt(kind: unknown, direction: unknown): TransitionKind | undefined {
  if (kind === undefined || kind === null) {
    if (direction !== undefined && direction !== null)
      throw new McpArgError(`direction requires kind ('Wipe' | 'Slide') in the same patch`, 'direction')
    return undefined
  }
  return parseTransitionKind(kind, direction)
}

/** Validate an Rgba (color.rs: four u8 fields). A non-object or out-of-range
 *  color must reject here → invalid_params; an ungated `a.color as Rgba` lets a
 *  string like "#fff" commit garbage to the actor. */
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

/** get_param_track result shape (NOT the raw Animated serde): Static →
 *  {mode,value}; Keyframed → {mode, keyframes:[{id, t_us (timeline-absolute =
 *  local + t_start), t_local_us (stored base), value, interp, preset_id?}]}.
 *  preset_id is the exact-match reverse lookup against the canonical easing
 *  table — present only when the stored params ARE a table entry's (a
 *  hand-tuned curve carries none; the field is omitted, never null). Caller
 *  wraps in toolJson (sorted keys, mirrors Rust json!/BTreeMap). */
export function shapeGetParamTrack(track: { mode: 'Static'; value: number } | { mode: 'Keyframed'; value: Array<{ id: string; t_us: number; value: number; interp: Interpolation }> }, tStartUs: number): unknown {
  if (track.mode === 'Static') return { mode: 'Static', value: track.value }
  return {
    mode: 'Keyframed',
    keyframes: track.value.map((k) => {
      const presetId = presetIdForInterp(k.interp)
      return { id: k.id, t_us: k.t_us + tStartUs, t_local_us: k.t_us, value: k.value, interp: k.interp, ...(presetId === undefined ? {} : { preset_id: presetId }) }
    }),
  }
}

/** Reasonable, NON-asserted prose for a failed dry-run op (the differential
 *  gate uses succeeding-ops-only sequences, so this string is never gated;
 *  the halt/error shape is unit-tested in mcp.dryrun.test.ts). */
export function dryRunErrorString(e: CommandError): string {
  if (e.error === 'InvalidArgument') return `${e.field}: ${e.detail}`
  if (e.error === 'Backend') return e.detail
  if (e.error === 'ValidationFailed') {
    const d = e.detail
    // The two grid rules carry the corrected value, so say it even in dry-run prose:
    // an agent planning a batch can fix the op without a second round trip.
    if (d.rule === 'OffGridLayerBoundary' || d.rule === 'OffGridTime') return `validation failed: ${d.rule} (${d.field} ${d.t} µs → send ${d.snap_to})`
    return `validation failed: ${d.rule}`
  }
  if (e.error === 'TransitionInsufficientHandle') return `insufficient tail media on the outgoing layer ${e.layer}: ${e.available_us} µs available`
  if (e.error === 'TransitionUnsupportedLayerKind') return `transitions are for visual layers only: layer ${e.layer} is ${e.kind}`
  return e.error
}

/** Dry-run response: per-op {index, status, output|error} flattened, plus
 *  halted_at (the first failing index, or null). DryRunOutput is kind-tagged,
 *  snake_case: add_layer{layer_id} / split_layer{left_id, right_id} / void.
 *  Wrapped in toolJson (sorted keys). */
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

/** CommandError → MCP error JSON. Only the structured `data`
 *  (LayerOverlap/MediaInUse) + InvalidArgument message are gated byte-exact;
 *  other prose messages are reasonable-but-ungated. */
export function mapCommandError(e: CommandError): McpToolErrorJson {
  if (e.error === 'InvalidArgument') return { code: 'invalid_params', message: `${e.field}: ${e.detail}` }
  if (e.error === 'Backend') return { code: 'internal', message: e.detail }
  if (e.error === 'ValidationFailed' && e.detail.rule === 'LayerOverlap') {
    const d = e.detail
    // The full cause + options go into the MESSAGE, not only `data`: MCP
    // clients (Claude Code verified against the hero-capture traces) surface
    // only `code: message` to the model and drop `error.data`, so a bare
    // 'layer overlap' left agents blind-retrying (.scratch/mcp-agent-hardening 04).
    return { code: 'invalid_params', message:
      `layer overlap on track ${d.track}: the requested range [${d.b_start}, ${d.b_end}) µs collides with layer ${d.a} at [${d.a_start}, ${d.a_end}) µs. Layers of the same class collide per track (each track has ONE visual lane and ONE audio lane — a track that looks empty can still hold audio, e.g. another clip's auto-paired dialogue). Options: create_new_track and retry there; trim_existing (trim ${d.a} to t_end_us ${d.b_start}); split_at_t (split ${d.a} at ${d.b_start}).`,
    data: {
      error: 'LayerOverlap', track: d.track, blocking_layer: d.a,
      blocking_range_us: [d.a_start, d.a_end], requested_range_us: [d.b_start, d.b_end],
      options: [
        { action: 'create_new_track', kind: 'Video' },
        { action: 'trim_existing', layer_id: d.a, new_t_end_us: d.b_start },
        { action: 'split_at_t', layer_id: d.a, at_t_us: d.b_start },
      ],
    } }
  }
  // ── Grid + bounds rules: the only ValidationErrors an agent can fix mechanically ──
  // These three carry `snap_to` (computed in validate.ts, where the lattice is in
  // hand), so surface it — the agent must not re-derive the lattice arithmetic.
  if (e.error === 'ValidationFailed' && e.detail.rule === 'OffGridLayerBoundary') {
    const d = e.detail
    // Name the lattice, not just the numbers: an Audio rejection reports fps 48000/1
    // and would otherwise read as an absurd 48000 fps composition.
    const lattice = d.grid === 'sample' ? `the ${d.fps.num} Hz audio sample lattice` : `the ${d.fps.num}/${d.fps.den} composition frame grid`
    return { code: 'invalid_params', message: `layer ${d.layer} ${d.field} ${d.t} µs is not on ${lattice}; nearest is ${d.snap_to}`, data: {
      error: 'OffGridLayerBoundary', layer: d.layer, field: d.field,
      requested_us: d.t, snap_to_us: d.snap_to, grid: d.grid, rate: [d.fps.num, d.fps.den],
      options: [{ action: 'retry_snapped', field: d.field, t_us: d.snap_to }],
    } }
  }
  if (e.error === 'ValidationFailed' && e.detail.rule === 'OffGridTime') {
    const d = e.detail
    return { code: 'invalid_params', message: `${d.entity} ${d.field} ${d.t} µs is not on the ${d.fps.num}/${d.fps.den} composition frame grid; nearest is ${d.snap_to}`, data: {
      error: 'OffGridTime', entity: d.entity, id: d.id, field: d.field,
      requested_us: d.t, snap_to_us: d.snap_to, grid: 'frame', rate: [d.fps.num, d.fps.den],
      options: [{ action: 'retry_snapped', field: d.field, t_us: d.snap_to }],
    } }
  }
  if (e.error === 'ValidationFailed' && e.detail.rule === 'NegativeLayerStart') {
    const d = e.detail
    return { code: 'invalid_params', message: `layer ${d.layer} would start at ${d.t_start} µs; timeline time starts at 0`, data: {
      error: 'NegativeLayerStart', layer: d.layer, requested_us: d.t_start,
      options: [{ action: 'retry_clamped', t_start_us: 0 }],
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
  if (e.error === 'TransitionInsufficientHandle') {
    return { code: 'invalid_params', message: `insufficient tail media on the outgoing layer: only ${e.available_us} µs remaining past its source out-point — shorten the transition to at most that`, data: {
      error: 'TransitionInsufficientHandle', layer: e.layer, available_us: e.available_us,
    } }
  }
  if (e.error === 'TransitionUnsupportedLayerKind') {
    return { code: 'invalid_params', message: `transitions are for visual layers only: layer ${e.layer} is ${e.kind} (audio crossfades are not supported yet)`, data: {
      error: 'TransitionUnsupportedLayerKind', layer: e.layer, kind: e.kind,
    } }
  }
  return { code: 'invalid_params', message: e.error }
}

// Presence check; the caller throws McpArgError on false.
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

// ── Shared schema fragments ──────────────────────────────────────────────────
// Every advertised property MUST carry a "type": MCP clients (Claude Code
// verified) coerce untyped fields to `type: string`, which FORCES the model to
// send nested payloads as JSON-encoded strings no matter how it is prompted —
// the server then rejects or, worse, silently ignores them
// (.scratch/mcp-agent-hardening). mcp.catalog-bijection.test.ts gates this
// catalog-wide.
const RGBA_SCHEMA = { type: 'object', properties: { r: { type: 'integer' }, g: { type: 'integer' }, b: { type: 'integer' }, a: { type: 'integer' } }, required: ['r', 'g', 'b', 'a'] }
const INTERP_SCHEMA = {
  type: 'object',
  description: 'Easing: {"kind":"Hold"} | {"kind":"Linear"} | {"kind":"Bezier","p1":[x,y],"p2":[x,y]} | {"kind":"Elastic","dir",amplitude?,period?} | {"kind":"Bounce","dir"}.',
  properties: {
    kind: { type: 'string', enum: ['Hold', 'Linear', 'Bezier', 'Elastic', 'Bounce'] },
    p1: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Bezier only: first control point [x, y]; x within [0, 1].' },
    p2: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Bezier only: second control point [x, y]; x within [0, 1].' },
    dir: { type: 'string', enum: ['In', 'Out', 'InOut'], description: 'Elastic/Bounce only: easing direction.' },
    amplitude: { type: 'number', description: `Elastic only: overshoot amplitude, >= 1. Omit for the default ${ELASTIC_DEFAULT_AMPLITUDE}.` },
    period: { type: 'number', description: `Elastic only: oscillation period, > 0. Omit for the default ${ELASTIC_DEFAULT_PERIOD}.` },
  },
  required: ['kind'],
}
// set_keyframe_easing's interp: the raw INTERP_SCHEMA kinds PLUS the preset
// form. `required` is empty — the two forms share no mandatory field; the
// exactly-one-of rule is parseEasing's. The preset enum derives from the
// canonical table, so the advertised ids can never drift from what bakes.
const EASING_SCHEMA = {
  type: 'object',
  description: 'Either {"preset":"<id>"} — a canonical named preset, baked to its params — or a raw kind (same forms as set_keyframe interp).',
  properties: {
    preset: { type: 'string', enum: EASING_PRESETS.map((p) => p.id), description: 'Preset id from the canonical easing table (e.g. "ease_in_out", "ease_out_expo", "ease_in_out_bounce").' },
    ...INTERP_SCHEMA.properties,
  },
  required: [],
}
const ANIM_TRACK_SCHEMA = {
  type: 'object',
  description: 'AnimTrack<f64>: {"mode":"Static","value":<number>} or {"mode":"Keyframed","value":[{id, t_us, value, interp}, ...]}.',
  properties: {
    mode: { type: 'string', enum: ['Static', 'Keyframed'] },
    value: {
      type: ['number', 'array'],
      description: 'Static: the held number. Keyframed: the keyframe array.',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, t_us: { type: 'integer' }, value: { type: 'number' }, interp: INTERP_SCHEMA },
        required: ['id', 't_us', 'value', 'interp'],
      },
    },
  },
  required: ['mode', 'value'],
}

// ── Single-source MCP tool table ─────────────────────────────────────────────
// Every scalar and patch arg of a table-exec entry is parser-gated in parseArgs:
// uuid/number/enum/boolean scalars through parseX, patch objects through parseObj
// at minimum — a non-object patch must reject, never commit-nothing-and-succeed.
// The dedicated stubs exist only so the MCP_TOOLS projection stays complete;
// their behavior lives in actor.ts arms.
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
    parseArgs: (a) => ({ op: 'update_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), patch: parseObj(a.patch, 'patch') } }) },
  { name: 'update_layer_params', exec: 'table',
    description: "Update a layer's kind-specific params. The patch is tagged with `kind` ('Text' | 'VideoClip' | 'ImageOverlay' | 'Color' | 'Audio') and must match the layer's kind. Audio fields take real effect in both preview and export: `gain_db` (dB; this patch sets a STATIC value, replacing any existing keyframes on the track), `pan` (-1..1 equal-power, same static-replace semantics), `fade_in_us`/`fade_out_us` (linear edge fades), `mute`, and `role` (one of dialogue/music/sfx/voiceover) to reassign the clip's mixing role. On a scale-linked layer (`scale_linked` in the layer view), a patch leaving scale_x ≠ scale_y auto-clears the link in the same commit; patch both axes to the same value to keep it.",
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
        color: RGBA_SCHEMA,
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
    parseArgs: (a) => ({ op: 'update_layer_params', args: { layer: parseUuid(a.layer_id, 'layer_id'), patch: parseObj(a.patch, 'patch') } }) },
  { name: 'set_scale_linked', exec: 'table',
    description: "Toggle a layer's uniform-scale link (visual kinds only; Color/Audio reject). `linked=true` snaps scale_y to a whole-track COPY of scale_x — keyframes included, fresh key ids — in the same commit (one undo restores both track and flag). `linked=false` clears only the flag; the tracks stay equal until the next divergent edit. Invariant: while linked, any write that leaves the two scale tracks unequal (a single-axis update_layer_params / set_keyframe / remove_keyframe) auto-clears the flag in that same commit — write both axes identically to keep the link.",
    inputSchema: { type: 'object', properties: { layer_id: { type: 'string' }, linked: { type: 'boolean' } }, required: ['layer_id', 'linked'] },
    parseArgs: (a) => ({ op: 'set_scale_linked', args: { layer: parseUuid(a.layer_id, 'layer_id'), linked: parseBool(a.linked, 'linked') } }) },
  { name: 'move_layer', exec: 'table',
    description: 'Move a layer to a different track and/or start time. The end time shifts by the same delta. Cross-track moves are validated against the destination\'s existing layers — overlap rejects with structured options.',
    inputSchema: { type: 'object', properties: { layer_id: { type: 'string' }, new_t_start_us: { type: 'integer' }, new_track_id: { type: 'string' }, escape_group: { type: ['boolean', 'null'] } }, required: ['layer_id', 'new_t_start_us', 'new_track_id'] },
    parseArgs: (a) => ({ op: 'move_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), to_track: parseUuid(a.new_track_id, 'new_track_id'), t_start_us: parseNum(a.new_t_start_us, 'new_t_start_us'), escape_group: parseBoolOpt(a.escape_group, 'escape_group', false) } }) },
  { name: 'trim_layer', exec: 'table',
    description: "Trim one edge of a layer's timeline range. `edge` is 'in' (t_start) or 'out' (t_end). For media-bearing layers the corresponding src bound (src_in_us or src_out_us) moves by the same delta; over-trimming past the source bound is clamped. When the layer is in a group and `escape_group` is false (default), every group member whose corresponding edge sits at the same t as the trimmed edge is moved by the same delta, clamped to the tightest aligned member's bounds. Pass `escape_group=true` to trim only this layer. See `docs/features.md#groups`.",
    inputSchema: { type: 'object', properties: { layer_id: { type: 'string' }, edge: { type: 'string' }, new_t_us: { type: 'integer' }, escape_group: { type: ['boolean', 'null'] } }, required: ['edge', 'layer_id', 'new_t_us'] },
    parseArgs: (a) => ({ op: 'trim_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), edge: parseStr(a.edge, 'edge'), new_t_us: parseNum(a.new_t_us, 'new_t_us'), escape_group: parseBoolOpt(a.escape_group, 'escape_group', false) } }) },
  { name: 'delete_layer', exec: 'table',
    description: 'Delete a layer. When the project setting `auto_delete_empty_tracks` is on (default) and this empties a non-reserved, unlocked track, the track is deleted in the same history entry (one undo restores both). A/B-roll and other role-stamped tracks always stay.',
    inputSchema: { type: 'object', properties: { layer_id: { type: 'string' } }, required: ['layer_id'] },
    parseArgs: (a) => ({ op: 'delete_layer', args: { layer: parseUuid(a.layer_id, 'layer_id') } }) },
  // ── table-exec: groups ───────────────────────────────────────────────────
  { name: 'groups_create', exec: 'table',
    description: 'Create a new group from >=2 distinct layer ids. Optional `label`. If any layer is already in another group, the op fails unless `reassign=true`, which removes them from their prior group(s) first (auto-dissolving any group that falls below 2 members). Returns the new group id.',
    inputSchema: { type: 'object', properties: { layer_ids: { type: 'array', items: { type: 'string' } }, label: { type: ['string', 'null'] }, reassign: { type: ['boolean', 'null'] } }, required: ['layer_ids'] },
    parseArgs: (a) => ({ op: 'groups_create', args: { layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')), label: parseStrOpt(a.label, 'label'), reassign: parseBoolOpt(a.reassign, 'reassign', false) } }),
    shapeResult: (v) => toolText(v as string) },
  { name: 'groups_dissolve', exec: 'table',
    description: 'Dissolve (delete) a group. The member layers themselves are not deleted.',
    inputSchema: { type: 'object', properties: { group_id: { type: 'string' } }, required: ['group_id'] },
    parseArgs: (a) => ({ op: 'groups_dissolve', args: { group: parseUuid(a.group_id, 'group_id') } }) },
  { name: 'groups_add_members', exec: 'table',
    description: 'Add member layers to an existing group. Same reassign semantics as groups_create.',
    inputSchema: { type: 'object', properties: { group_id: { type: 'string' }, layer_ids: { type: 'array', items: { type: 'string' } }, reassign: { type: ['boolean', 'null'] } }, required: ['group_id', 'layer_ids'] },
    parseArgs: (a) => ({ op: 'groups_add_members', args: { group: parseUuid(a.group_id, 'group_id'), layers: asArray(a.layer_ids, 'layer_ids').map((s) => parseUuid(s, 'layer_ids')), reassign: parseBoolOpt(a.reassign, 'reassign', false) } }) },
  { name: 'groups_remove_members', exec: 'table',
    description: 'Remove member layers from a group. If the remaining membership falls below 2, the group auto-dissolves.',
    inputSchema: { type: 'object', properties: { group_id: { type: 'string' }, layer_ids: { type: 'array', items: { type: 'string' } } }, required: ['group_id', 'layer_ids'] },
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
    description: 'Update an effect: patch is `{ enabled?, params? }` where params is `{ paramKey: { "mode": "Static", "value": <number> } }` (v1 params are scalar). For keyframed params use set_keyframe with param_key "effects[<effect_id>].params[<key>]". An unparseable patch (non-object, unknown key, malformed param value) rejects with invalid_params — it never partially applies.',
    inputSchema: { type: 'object', properties: { effect_id: { type: 'string' }, layer_id: { type: 'string' }, patch: {
      type: 'object',
      description: 'Effect patch. Only fields you set are applied; `params` merges key-by-key.',
      properties: {
        enabled: { type: ['boolean', 'null'] },
        params: { type: 'object', description: 'Param key → AnimTrack. v1 effect params are scalar, e.g. {"strength": {"mode":"Static","value":8}}.', additionalProperties: ANIM_TRACK_SCHEMA },
      },
    } }, required: ['effect_id', 'layer_id', 'patch'] },
    parseArgs: (a) => ({ op: 'update_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id'), patch: parseEffectPatch(a.patch) } }) },
  { name: 'move_effect', exec: 'table',
    description: 'Reorder an effect within its layer\'s chain. new_index is 0-based; 0 = first applied. Must be < effect count.',
    inputSchema: { type: 'object', properties: { effect_id: { type: 'string' }, layer_id: { type: 'string' }, new_index: { type: 'integer' } }, required: ['effect_id', 'layer_id', 'new_index'] },
    parseArgs: (a) => ({ op: 'move_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id'), new_index: parseNum(a.new_index, 'new_index') } }) },
  { name: 'remove_effect', exec: 'table',
    description: 'Remove an effect from a layer by id.',
    inputSchema: { type: 'object', properties: { effect_id: { type: 'string' }, layer_id: { type: 'string' } }, required: ['effect_id', 'layer_id'] },
    parseArgs: (a) => ({ op: 'remove_effect', args: { layer: parseUuid(a.layer_id, 'layer_id'), effect: parseUuid(a.effect_id, 'effect_id') } }) },
  // ── table-exec: transitions ──────────────────────────────────────────────
  { name: 'add_transition', exec: 'table',
    description: "Add a transition at the cut between two layers on the SAME track. `from_layer_id` (outgoing) and `to_layer_id` (incoming) must be adjacent — the outgoing layer's t_end_us equal to the incoming layer's t_start_us. Alignment is start-at-cut: the outgoing layer auto-extends forward by `duration_us` and the transition occupies the incoming layer's FIRST `duration_us` microseconds. `kind` ∈ 'Crossfade' (default when omitted) | 'Wipe' | 'Slide'. `direction` is the MOTION direction ('left' = the wipe boundary / sliding content moves leftward); it is required for Wipe/Slide and rejected for Crossfade. Visual layers only (video, image, text, color, motif) — an Audio participant fails with TransitionUnsupportedLayerKind. If the outgoing layer has too little tail media to extend, fails with TransitionInsufficientHandle carrying `available_us` (the maximum extension possible) — shorten `duration_us` to at most that and retry. Returns the new transition id. Recorded (one undo restores the outgoing layer's original length too).",
    inputSchema: { type: 'object', properties: {
      direction: { type: 'string', enum: ['left', 'right', 'up', 'down'] },
      duration_us: { type: 'integer' },
      from_layer_id: { type: 'string' },
      kind: { type: 'string', enum: ['Crossfade', 'Wipe', 'Slide'] },
      to_layer_id: { type: 'string' },
    }, required: ['duration_us', 'from_layer_id', 'to_layer_id'] },
    parseArgs: (a) => {
      parseTransitionKind(a.kind ?? 'Crossfade', a.direction) // strict enum gate at the MCP boundary; dispatch re-derives from the raw args below
      return { op: 'add_transition', args: { from: parseUuid(a.from_layer_id, 'from_layer_id'), to: parseUuid(a.to_layer_id, 'to_layer_id'), duration_us: parseNum(a.duration_us, 'duration_us'), kind: a.kind, direction: a.direction } }
    },
    shapeResult: (v) => toolText(v as string) },
  { name: 'update_transition', exec: 'table',
    description: "Patch a transition's `duration_us`, `kind`, and/or `direction` in ONE recorded commit (one undo step). Only fields you set are applied. `direction` rides inside `kind`: changing kind to Wipe/Slide requires `direction` in the same call, and `direction` alone (without `kind`) or alongside Crossfade is rejected. Duration changes move the OUTGOING layer's auto-extended tail (start-at-cut alignment — the incoming layer never moves); growth is pre-checked against the outgoing layer's remaining tail media and fails with TransitionInsufficientHandle carrying `available_us`. Errors with TransitionNotFound for an unknown id.",
    inputSchema: { type: 'object', properties: {
      direction: { type: 'string', enum: ['left', 'right', 'up', 'down'] },
      duration_us: { type: 'integer' },
      kind: { type: 'string', enum: ['Crossfade', 'Wipe', 'Slide'] },
      transition_id: { type: 'string' },
    }, required: ['transition_id'] },
    parseArgs: (a) => {
      parseTransitionKindOpt(a.kind, a.direction) // strict enum gate; dispatch re-derives
      parseNumOpt(a.duration_us, 'duration_us')
      return { op: 'update_transition', args: { transition: parseUuid(a.transition_id, 'transition_id'), duration_us: a.duration_us, kind: a.kind, direction: a.direction } }
    } },
  { name: 'remove_transition', exec: 'table',
    description: "Remove a transition by id. The outgoing layer's auto-extension is undone — its end shrinks back by the transition's duration, restoring the hard cut. Recorded (undoable). Errors with TransitionNotFound for an unknown id.",
    inputSchema: { type: 'object', properties: { transition_id: { type: 'string' } }, required: ['transition_id'] },
    parseArgs: (a) => ({ op: 'remove_transition', args: { transition: parseUuid(a.transition_id, 'transition_id') } }) },
  // ── table-exec: composition ──────────────────────────────────────────────
  { name: 'set_composition', exec: 'table',
    description: 'Update composition envelope (canvas size, fps, sample rate, channels, color space, background, duration). Only fields you set are applied. Width/height must be positive; fps denominator must be non-zero. NOTHING here records onto the undo stack — the whole envelope is setup, so the change is patched into every history snapshot and survives undo/redo. `fps` is LOCKED once the timeline holds a layer OR any history snapshot or checkpoint does: the patch is rejected with FpsLockedByContent (carrying the current rate, the requested rate, the live layer count, and `locked_by`: "current" or "history") because changing the rate moves every edit point by up to half a frame and can collapse a short layer. With locked_by "history" the live layer count is 0 and the timeline looks empty — undo could still bring old-grid layers back, which is why it is still refused. Set the rate on a project that has never held a layer; to clear a history-scoped lock, empty the timeline and reopen the project (opening resets history). Markers, a pinned duration, and imported-but-unplaced media never lock the rate. `sample_rate` is an export target, not an editing grid, and is never locked. Setting `duration_us` pins the composition duration — subsequent layer edits will no longer auto-fit it (except an overflow guard if a layer extends past the pinned value). Use `fit_composition_to_layers` to clear the pin and snap duration back to the layer high-water mark.',
    inputSchema: { type: 'object', properties: { patch: {
      type: 'object',
      description: 'Composition envelope patch. Only fields you set are applied.',
      properties: {
        width: { type: 'integer' },
        height: { type: 'integer' },
        fps: { type: 'object', properties: { num: { type: 'integer' }, den: { type: 'integer' } }, required: ['num', 'den'] },
        duration_us: { type: 'integer', description: 'Setting this pins the composition duration (see description).' },
        sample_rate: { type: 'integer' },
        channels: { type: 'integer' },
        color_space: { type: 'string', enum: ['Bt709', 'Bt601', 'Bt2020', 'SRgb'] },
        background: RGBA_SCHEMA,
      },
    } }, required: ['patch'] },
    parseArgs: (a) => ({ op: 'set_composition', args: parseObj(a.patch, 'patch') }) },
  { name: 'fit_composition_to_layers', exec: 'table',
    description: "Clear the composition's duration pin and set `duration_us` to `max(layer.t_end_us)`. The inverse of `set_composition { duration_us }`: that pins, this unpins. After this call, subsequent layer edits track duration in both directions (grow on adds, shrink on deletes/inward trims).",
    inputSchema: { type: 'object', properties: {}, required: [] },
    parseArgs: () => ({ op: 'fit_composition_to_layers', args: {} }) },
  // ── table-exec: markers ──────────────────────────────────────────────────
  { name: 'update_marker', exec: 'table',
    description: 'Update a marker. Setting `t_us` re-sorts the marker list.',
    inputSchema: { type: 'object', properties: { marker_id: { type: 'string' }, patch: {
      type: 'object',
      description: 'Marker patch; only fields you set are applied. `end_t_us` can be set, never cleared (clear = remove + re-add).',
      properties: {
        t_us: { type: ['integer', 'null'] },
        end_t_us: { type: ['integer', 'null'] },
        label: { type: ['string', 'null'] },
        color: RGBA_SCHEMA,
      },
    } }, required: ['marker_id', 'patch'] },
    parseArgs: (a) => ({ op: 'update_marker', args: { marker: parseUuid(a.marker_id, 'marker_id'), patch: parseMarkerPatch(a.patch) } }) },
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
    description: 'Undo the most recent edit (linear history). Errors with NothingToUndo at the origin. Only timeline edits (layers, tracks, markers, transitions, and cascade-deleting media removals) record onto the undo stack. The following sit OUTSIDE it and are unaffected by undo: media imports and removals of unreferenced media, the entire composition envelope (`set_composition` and `fit_composition_to_layers` — canvas size, fps, sample rate, channels, color space, background AND duration/duration_pinned), and loading or creating a project (which resets history).',
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
  // ── dedicated-exec — parseDedicated validates and maps MCP args; behavior lives in actor.ts arms ──
  { name: 'add_color_layer', exec: 'dedicated',
    description: 'Add a solid-color layer to a track. Returns the new layer id. `t_start_us` and `t_end_us` are timeline microseconds (start inclusive, end exclusive). Layer cannot overlap existing layers on the same track.',
    inputSchema: { type: 'object', properties: { color: RGBA_SCHEMA, height: { type: ['integer', 'null'] }, t_end_us: { type: 'integer' }, t_start_us: { type: 'integer' }, track_id: { type: 'string' }, width: { type: ['integer', 'null'] } }, required: ['color', 't_end_us', 't_start_us', 'track_id'] },
    parseDedicated: (a) => ({ track: parseUuid(a.track_id, 'track_id'), color: parseRgba(a.color, 'color'),
      width: parseNumOpt(a.width, 'width'), height: parseNumOpt(a.height, 'height'),
      t_start_us: parseNum(a.t_start_us, 't_start_us'), t_end_us: parseNum(a.t_end_us, 't_end_us') }) },
  { name: 'add_video_layer', exec: 'dedicated',
    description: "Add a visual media layer from an imported media item onto a track. For Video media, `src_in_us`/`src_out_us` are the in/out points within the source media; `t_start_us`/`t_end_us` are where the clip lives on the timeline. For Image media, this creates an ImageOverlay over the timeline range, and `src_in_us`/`src_out_us` are accepted for schema compatibility but ignored. Video source and timeline ranges should be the same length unless `speed` is later changed. When a Video source has an audio stream and the project's `auto_pair_audio_on_import` setting is on (default), this also creates a paired dialogue Audio layer on the SAME track's audio lane (every track holds one visual lane plus one audio lane) at the same time bounds and groups the two so they move/trim/split together. The whole call is atomic: video, paired audio, and group commit together or not at all — if the audio lane is occupied the call rejects naming the blocking layer, and nothing lands on the timeline. Returns either the visual layer id (no pairing) or `{ video_layer_id, audio_layer_id, group_id }` when a pair was created.",
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
    inputSchema: { type: 'object', properties: { color: RGBA_SCHEMA, end_t_us: { type: ['integer', 'null'] }, label: { type: 'string' }, t_us: { type: 'integer' } }, required: ['color', 'label', 't_us'] },
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
    description: 'Insert or update a keyframe on a layer param. `t_us` is timeline-absolute. A Static track is lifted to Keyframed. An existing key at the same frame is updated in place. `interp` (optional) sets the easing for the segment leaving this key as a raw kind (e.g. {"kind":"Linear"}, {"kind":"Bezier","p1":[x,y],"p2":[x,y]}, {"kind":"Elastic","dir":"Out"}; named presets go through set_keyframe_easing); omit to inherit the preceding key\'s easing (or Linear). Keying only scale_x or scale_y on a scale-linked layer diverges the pair and auto-clears the link in the same commit (see set_scale_linked).',
    inputSchema: { type: 'object', properties: { interp: INTERP_SCHEMA, layer_id: { type: 'string' }, param_key: { type: 'string' }, t_us: { type: 'integer' }, value: { type: 'number' } }, required: ['layer_id', 'param_key', 't_us', 'value'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), param_key: parseStr(a.param_key, 'param_key'),
      t_us: parseNum(a.t_us, 't_us'), value: parseNum(a.value, 'value'), interp: parseInterpOpt(a.interp) }) },
  { name: 'get_param_track', exec: 'dedicated',
    description: 'Read a layer param\'s animation track, flattened for editing. Returns {"mode":"Static","value":n} or {"mode":"Keyframed","keyframes":[{id, t_us, t_local_us, value, interp, preset_id?}]}. `t_us` is timeline-absolute; `t_local_us` is layer-local (the stored base). `preset_id` names the canonical easing preset whose params exactly match the key\'s interp; a hand-tuned curve carries none. Use this to discover keyframe ids before editing.',
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
    description: 'Set the easing of the segment leaving a keyframe. `interp` is {"preset":"<id>"} — a named preset from the canonical easing table, baked to its params at write time (get_param_track reads the params back plus the matching preset_id) — or a raw kind: {"kind":"Hold"} | {"kind":"Linear"} | {"kind":"Bezier","p1":[x,y],"p2":[x,y]} (x within [0,1]) | {"kind":"Elastic","dir":"In"|"Out"|"InOut","amplitude"?,"period"?} | {"kind":"Bounce","dir":"In"|"Out"|"InOut"}.',
    inputSchema: { type: 'object', properties: { interp: EASING_SCHEMA, keyframe_id: { type: 'string' }, layer_id: { type: 'string' }, param_key: { type: 'string' } }, required: ['interp', 'keyframe_id', 'layer_id', 'param_key'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), keyframe_id: parseUuid(a.keyframe_id, 'keyframe_id'),
      param_key: parseStr(a.param_key, 'param_key'), interp: parseEasing(a.interp) }) },
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
    description: 'Low-level: replace a layer param\'s whole animation track. `track` is an AnimTrack<f64>: {"mode":"Static","value":n} or {"mode":"Keyframed","value":[{id, t_us, value, interp}]} with keyframe `t_us` timeline-absolute. Use the granular tools (set_keyframe etc.) unless you need bulk authoring. Replacing only one scale axis on a scale-linked layer diverges the pair and auto-clears the link in the same commit (see set_scale_linked).',
    inputSchema: { type: 'object', properties: { layer_id: { type: 'string' }, param_key: { type: 'string' }, track: ANIM_TRACK_SCHEMA }, required: ['layer_id', 'param_key', 'track'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), param_key: parseStr(a.param_key, 'param_key'),
      track: parseAnimatedF64(a.track) }) },
  { name: 'dry_run', exec: 'dedicated',
    description: 'Try-run a sequence of edit operations against a clone of the current project WITHOUT committing. Useful for previewing complex multi-step edits — agents can detect overlap / invariant violations before mutating real state. Validates after each op (matching real `commit()` behaviour) and HALTS at the first error so subsequent ops don\'t dry-run against a state real execution wouldn\'t reach. Returns `{ results: [{ index, status, output? | error? }, ...] }`. Supports add_color_layer, add_video_layer, update_layer, update_layer_params, move_layer, split_layer, delete_layer. Other tools (motifs, caption import, media import, undo/redo) are not dry-runnable in v1.',
    inputSchema: { type: 'object', properties: { operations: {
      type: 'array',
      items: { type: 'object', description: "OperationSpec: {\"kind\": \"add_color_layer\" | \"add_video_layer\" | \"update_layer\" | \"update_layer_params\" | \"move_layer\" | \"split_layer\" | \"delete_layer\", ...that tool's snake_case args}." },
    } }, required: ['operations'] },
    parseDedicated: (a) => ({ operations: asArray(a.operations, 'operations') }) },
  { name: 'add_motif', exec: 'dedicated',
    description: "Add a motif layer to a track. The motif is rasterized to a PNG sequence on first render and cached content-addressably; subsequent renders are folder lookups. Args: `motif_id` (from `list_motifs`), `t_start_us` (timeline microseconds), optional `t_end_us` (defaults to `t_start_us + default_duration_s * 1e6`), optional `track_id` (when omitted, always spawns a fresh track labeled 'Overlay' — never reuses an existing track, so consecutive auto-inserts can't collide), optional `props` (JSON object matched against the motif's `props_schema`; unknown keys reject, missing keys fall back to defaults). Returns the new layer id.",
    inputSchema: { '$schema': 'http://json-schema.org/draft-07/schema#', type: 'object',
      properties: {
        motif_id: { type: 'string', description: 'Motif id from `list_motifs` (e.g. "lower-third-simple", "title-card").' },
        t_start_us: { type: 'integer', format: 'int64', description: 'Layer start in timeline microseconds.' },
        t_end_us: { type: ['integer', 'null'], format: 'int64', description: 'Layer end in timeline microseconds. Defaults to `t_start_us + default_duration_s * 1_000_000` when omitted.' },
        track_id: { type: ['string', 'null'], description: 'Target track id. If omitted, a fresh track labeled "Overlay" is created.' },
        props: { type: 'object', description: 'Motif props as a JSON object. Keys must match the motif\'s `props_schema`; unknown keys reject; missing keys fill from defaults. Omit entirely to use all defaults.' },
      },
      required: ['motif_id', 't_start_us'] },
    parseDedicated: (a) => ({
      motif_id: parseStr(a.motif_id, 'motif_id'),
      t_start_us: parseNum(a.t_start_us, 't_start_us'),
      t_end_us: parseNumOpt(a.t_end_us, 't_end_us') ?? null,
      track_id: a.track_id != null ? parseUuid(a.track_id, 'track_id') : null,
      props: a.props != null ? parseObj(a.props, 'props') : null,
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
  // ── hybrid def (TS-owned) — executed by runHybrid (routeMcpTool → 'hybrid'),
  //    NOT an actor.mcpCall arm. It lives here (not the Rust catalog like the
  //    other hybrids) because its cuts compute in Rust but its splits write
  //    through the TS actor, and its def must merge into the advertised catalog
  //    from the TS side. parseDedicated is the bijection gate's required-scalar
  //    check only; runHybrid re-validates layer_id itself. ──
  { name: 'auto_split_by_shot', exec: 'dedicated',
    description: "Detect shot cuts in a VideoClip layer and split it at every in-window cut, as ONE undoable step. `min_shot_us` (optional) is the minimum shot length for cut detection (closer cuts merge; default 500000 = 0.5s). `drop_short=true` additionally deletes any resulting segment shorter than `min_shot_us`. Returns `{ layer_ids }` — the new segment layer ids in timeline order (or the single unchanged layer id when no interior cut is found). Pure convenience: reproducible with `analyze_clip` + `split_layer`, and it reads the SAME cached shot report as `analyze_clip`.",
    inputSchema: { type: 'object', properties: { layer_id: { type: 'string' }, min_shot_us: { type: ['integer', 'null'] }, drop_short: { type: ['boolean', 'null'] } }, required: ['layer_id'] },
    parseDedicated: (a) => ({ layer: parseUuid(a.layer_id, 'layer_id'), min_shot_us: parseNumOpt(a.min_shot_us, 'min_shot_us'), drop_short: parseBoolOpt(a.drop_short, 'drop_short', false) }) },
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
