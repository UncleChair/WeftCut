import { describe, it, expect } from 'vitest'
import { MCP_TOOL_DEFS, MCP_ARG_PARSERS, MCP_RESULT_SHAPERS, MCP_TOOLS } from '../mcp-commands'

const ALL_46_NAMES = new Set<string>([
  // table-exec tools (27)
  'add_track', 'remove_track', 'duplicate_layer', 'move_track',
  'update_layer', 'update_layer_params',
  'move_layer', 'trim_layer', 'delete_layer',
  'groups_create', 'groups_dissolve', 'groups_add_members', 'groups_remove_members', 'groups_rename',
  'add_effect', 'update_effect', 'move_effect', 'remove_effect',
  'set_composition', 'fit_composition_to_layers',
  'update_marker', 'remove_marker',
  'remove_media', 'undo', 'redo',
  'set_role_gain', 'set_role_flags',
  // dedicated-exec tools (19)
  'add_color_layer', 'add_video_layer', 'split_layer', 'add_marker',
  'lock_history', 'unlock_history',
  'set_keyframe', 'get_param_track', 'remove_keyframe', 'retime_keyframe',
  'set_keyframe_easing', 'smooth_keyframes', 'clear_keyframes', 'set_param_track',
  'dry_run', 'checkpoint', 'list_checkpoints', 'restore_checkpoint', 'begin_agent_session',
])

describe('MCP tool table projections', () => {
  it('MCP_TOOLS contains exactly the original 46 tool names', () => {
    expect(MCP_TOOLS).toEqual(ALL_46_NAMES)
  })

  it('MCP_TOOLS equals the set of def names', () => {
    expect(MCP_TOOLS).toEqual(new Set(MCP_TOOL_DEFS.map((d) => d.name)))
  })

  it('MCP_ARG_PARSERS keys match the table-exec defs', () => {
    const tableExecNames = new Set(MCP_TOOL_DEFS.filter((d) => d.parseArgs).map((d) => d.name))
    expect(new Set(Object.keys(MCP_ARG_PARSERS))).toEqual(tableExecNames)
  })

  it('MCP_RESULT_SHAPERS keys match the shapeResult defs', () => {
    const shaperNames = new Set(MCP_TOOL_DEFS.filter((d) => d.shapeResult).map((d) => d.name))
    expect(new Set(Object.keys(MCP_RESULT_SHAPERS))).toEqual(shaperNames)
  })

  it('every table-exec def round-trips a representative valid arg set identically to its prior parser', () => {
    const u = '00000000-0000-7000-8000-000000000001'
    expect(MCP_ARG_PARSERS['remove_track']({ track_id: u })).toEqual({ op: 'delete_track', args: { track: u, force: false } })
    expect(MCP_ARG_PARSERS['set_role_gain']({ role: 'music', gain_db: -3 })).toEqual({ op: 'set_role_gain', args: { role: 'music', gain_db: -3 } })
  })

  it('hardened parseArgs rejects malformed input (was a silent as-cast)', () => {
    // force must be a boolean; previously `(a.force as boolean) ?? false` let a string through
    expect(() => MCP_ARG_PARSERS['remove_track']({ track_id: '00000000-0000-7000-8000-000000000001', force: 'yes' })).toThrow()
    // gain_db must be a finite number (was `a.gain_db` raw)
    expect(() => MCP_ARG_PARSERS['set_role_gain']({ role: 'music', gain_db: 'loud' })).toThrow()
  })

  it('dedicated-exec defs have no parseArgs', () => {
    const dedicated = MCP_TOOL_DEFS.filter((d) => d.exec === 'dedicated')
    expect(dedicated.length).toBe(19)
    for (const d of dedicated) {
      expect(d.parseArgs, `${d.name} should not have parseArgs`).toBeUndefined()
    }
  })

  it('table-exec defs all have parseArgs', () => {
    const table = MCP_TOOL_DEFS.filter((d) => d.exec === 'table')
    expect(table.length).toBe(27)
    for (const d of table) {
      expect(d.parseArgs, `${d.name} should have parseArgs`).toBeDefined()
    }
  })

  it('shapeResult tools are the expected 4', () => {
    const shapers = MCP_TOOL_DEFS.filter((d) => d.shapeResult).map((d) => d.name).sort()
    expect(shapers).toEqual(['add_effect', 'add_track', 'duplicate_layer', 'groups_create'])
  })

  it('parseBoolOpt hardening: escape_group rejects non-boolean', () => {
    const u = '00000000-0000-7000-8000-000000000001'
    const u2 = '00000000-0000-7000-8000-000000000002'
    expect(() => MCP_ARG_PARSERS['move_layer']({ layer_id: u, new_track_id: u2, new_t_start_us: 0, escape_group: 'true' })).toThrow()
  })

  it('asArray hardening: layer_ids rejects non-array', () => {
    const u = '00000000-0000-7000-8000-000000000001'
    expect(() => MCP_ARG_PARSERS['groups_create']({ layer_ids: u, label: null })).toThrow()
  })

  it('parseStrOpt hardening: label rejects non-string non-null', () => {
    const u = '00000000-0000-7000-8000-000000000001'
    expect(() => MCP_ARG_PARSERS['groups_create']({ layer_ids: [u], label: 42 })).toThrow()
  })
})
