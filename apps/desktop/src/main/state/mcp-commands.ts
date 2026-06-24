// apps/desktop/src/main/state/mcp-commands.ts
// Pure MCP-tool adapter helpers: arg parsing (snake_case MCP vocab → internal
// dispatch vocab), ToolResult shaping, and CommandError → MCP error mapping.
// The byte-exact mcp.differential gate (vs Rust dispatch_tool) is the backstop.
// Mirrors native/src/mcp/{tools.rs,wire.rs}. DORMANT until Phase 3d-d.
import type { CommandError } from './errors'
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

// ── ToolResult shapers (wire.rs:81-93) ──
export function toolText(s: string): ToolResultJson { return { content: [{ type: 'text', text: s }] } }
export function toolEmpty(): ToolResultJson { return { content: [] } }
/** json results travel as a text block whose text is the SERIALIZED JSON with
 *  alpha-sorted keys (Rust serde_json preserve_order OFF → BTreeMap). */
export function toolJson(v: unknown): ToolResultJson { return { content: [{ type: 'text', text: JSON.stringify(canonicalize(v)) }] } }

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

/** MCP tool → internal dispatch op + renamed args. Throws McpArgError on bad
 *  UUIDs. Explicit-param tools (add_color_layer/add_video_layer/add_marker/
 *  split_layer) are NOT here — they have dedicated arms in actor.mcpCall. */
export const MCP_ARG_PARSERS: Record<string, (a: Record<string, unknown>) => { op: string; args: Record<string, unknown> }> = {
  add_track: (a) => ({ op: 'add_track', args: { label: (a.label as string | undefined) ?? null } }),
  remove_track: (a) => ({ op: 'delete_track', args: { track: parseUuid(a.track_id, 'track_id'), force: (a.force as boolean) ?? false } }),
  duplicate_layer: (a) => ({ op: 'duplicate_layer', args: { layer: parseUuid(a.layer_id, 'layer_id'), t_offset_us: a.t_offset_us } }),
}

/** MCP tool → ToolResult from the dispatch value. Tools absent here → toolEmpty. */
export const MCP_RESULT_SHAPERS: Record<string, (value: unknown) => ToolResultJson> = {
  add_track: (v) => toolText(v as string),
  duplicate_layer: (v) => toolText(v as string),
}

/** All MCP tools this adapter handles (parsers + the dedicated arms). Grows per task. */
export const MCP_TOOLS: ReadonlySet<string> = new Set<string>(['add_track', 'add_color_layer', 'add_video_layer', 'add_marker', 'split_layer', 'duplicate_layer', 'remove_track'])
