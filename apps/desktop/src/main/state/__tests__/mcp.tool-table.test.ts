import { describe, it, expect } from 'vitest'
import { MCP_TOOL_DEFS, MCP_ARG_PARSERS, MCP_RESULT_SHAPERS, MCP_TOOLS } from '../mcp-commands'
import { createActor } from '../actor'
import { uuidV7Gen } from '../ids'
import { blankProject } from '../model'

const ALL_50_NAMES = new Set<string>([
  // table-exec tools (30) — transitions trio added by Transitions v1 ticket 04
  'add_track', 'remove_track', 'duplicate_layer', 'move_track',
  'update_layer', 'update_layer_params',
  'move_layer', 'trim_layer', 'delete_layer',
  'groups_create', 'groups_dissolve', 'groups_add_members', 'groups_remove_members', 'groups_rename',
  'add_effect', 'update_effect', 'move_effect', 'remove_effect',
  'add_transition', 'update_transition', 'remove_transition',
  'set_composition', 'fit_composition_to_layers',
  'update_marker', 'remove_marker',
  'remove_media', 'undo', 'redo',
  'set_role_gain', 'set_role_flags',
  // dedicated-exec tools (20) — add_motif added Phase 4a-ii §2.2
  'add_color_layer', 'add_video_layer', 'split_layer', 'add_marker',
  'add_motif',
  'lock_history', 'unlock_history',
  'set_keyframe', 'get_param_track', 'remove_keyframe', 'retime_keyframe',
  'set_keyframe_easing', 'smooth_keyframes', 'clear_keyframes', 'set_param_track',
  'dry_run', 'checkpoint', 'list_checkpoints', 'restore_checkpoint', 'begin_agent_session',
])

describe('MCP tool table projections', () => {
  it('MCP_TOOLS contains exactly the 50 tool names (transitions trio added Transitions v1 ticket 04)', () => {
    expect(MCP_TOOLS).toEqual(ALL_50_NAMES)
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
    expect(dedicated.length).toBe(20) // add_motif added Phase 4a-ii §2.2
    for (const d of dedicated) {
      expect(d.parseArgs, `${d.name} should not have parseArgs`).toBeUndefined()
    }
  })

  it('table-exec defs all have parseArgs', () => {
    const table = MCP_TOOL_DEFS.filter((d) => d.exec === 'table')
    expect(table.length).toBe(30)
    for (const d of table) {
      expect(d.parseArgs, `${d.name} should have parseArgs`).toBeDefined()
    }
  })

  it('shapeResult tools are the expected 5', () => {
    const shapers = MCP_TOOL_DEFS.filter((d) => d.shapeResult).map((d) => d.name).sort()
    expect(shapers).toEqual(['add_effect', 'add_track', 'add_transition', 'duplicate_layer', 'groups_create'])
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

  it('transition tools round-trip valid args to dispatch vocabulary', () => {
    const u1 = '00000000-0000-7000-8000-000000000001'
    const u2 = '00000000-0000-7000-8000-000000000002'
    expect(MCP_ARG_PARSERS['add_transition']({ from_layer_id: u1, to_layer_id: u2, duration_us: 1_000_000, kind: 'Wipe', direction: 'left' }))
      .toEqual({ op: 'add_transition', args: { from: u1, to: u2, duration_us: 1_000_000, kind: 'Wipe', direction: 'left' } })
    // kind omitted = Crossfade default; the raw (absent) fields pass through
    expect(MCP_ARG_PARSERS['add_transition']({ from_layer_id: u1, to_layer_id: u2, duration_us: 500_000 }))
      .toEqual({ op: 'add_transition', args: { from: u1, to: u2, duration_us: 500_000, kind: undefined, direction: undefined } })
    expect(MCP_ARG_PARSERS['update_transition']({ transition_id: u1, duration_us: 250_000, kind: 'Slide', direction: 'down' }))
      .toEqual({ op: 'update_transition', args: { transition: u1, duration_us: 250_000, kind: 'Slide', direction: 'down' } })
    expect(MCP_ARG_PARSERS['remove_transition']({ transition_id: u1 }))
      .toEqual({ op: 'remove_transition', args: { transition: u1 } })
  })

  it('transition parsers reject bad kind/direction combos at the MCP boundary', () => {
    const u1 = '00000000-0000-7000-8000-000000000001'
    const u2 = '00000000-0000-7000-8000-000000000002'
    const base = { from_layer_id: u1, to_layer_id: u2, duration_us: 1_000_000 }
    expect(() => MCP_ARG_PARSERS['add_transition']({ ...base, kind: 'Dissolve' })).toThrow()                       // unknown kind
    expect(() => MCP_ARG_PARSERS['add_transition']({ ...base, kind: 'Wipe' })).toThrow()                           // missing direction
    expect(() => MCP_ARG_PARSERS['add_transition']({ ...base, kind: 'Slide' })).toThrow()                          // missing direction
    expect(() => MCP_ARG_PARSERS['add_transition']({ ...base, kind: 'Wipe', direction: 'diagonal' })).toThrow()    // bad direction
    expect(() => MCP_ARG_PARSERS['add_transition']({ ...base, kind: 'Crossfade', direction: 'left' })).toThrow()   // direction on Crossfade
    expect(() => MCP_ARG_PARSERS['add_transition']({ ...base, direction: 'left' })).toThrow()                      // absent kind = Crossfade → direction rejected
    expect(() => MCP_ARG_PARSERS['update_transition']({ transition_id: u1, kind: 'Wipe' })).toThrow()              // missing direction
    expect(() => MCP_ARG_PARSERS['update_transition']({ transition_id: u1, direction: 'left' })).toThrow()         // direction without kind
    expect(() => MCP_ARG_PARSERS['update_transition']({ transition_id: u1, duration_us: 'long' })).toThrow()       // non-number duration
  })

  it('parseStrOpt hardening: label rejects non-string non-null', () => {
    const u = '00000000-0000-7000-8000-000000000001'
    expect(() => MCP_ARG_PARSERS['groups_create']({ layer_ids: [u], label: 42 })).toThrow()
  })
})

describe('transition tools through mcpCall (table-exec, end to end)', () => {
  /** Actor with A1=[0,2M] → A2=[2M,4M] color layers on the A roll (adjacent cut). */
  function withCut() {
    const idGen = uuidV7Gen()
    const initial = blankProject(idGen, 't')
    const actor = createActor({ initial, idGen, clock: () => '2026-01-01T00:00:00.000Z' })
    const track = initial.tracks[0].id
    const a1 = (actor.dispatch('add_layer', { track, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 }) as { ok: true; value: string }).value
    const a2 = (actor.dispatch('add_layer', { track, kind: 'color', t_start_us: 2_000_000, t_end_us: 4_000_000 }) as { ok: true; value: string }).value
    return { actor, track, a1, a2 }
  }

  it('add → update → remove round-trips through the MCP surface', () => {
    const { actor, a1, a2 } = withCut()
    const add = actor.mcpCall('add_transition', JSON.stringify({ from_layer_id: a1, to_layer_id: a2, duration_us: 1_000_000, kind: 'Wipe', direction: 'left' }))
    expect(add.ok).toBe(true)
    if (!add.ok) return
    const tid = add.result.content[0].text
    expect(actor.snapshot().transitions[0]).toMatchObject({ id: tid, kind: { kind: 'Wipe', direction: 'left' } })
    const upd = actor.mcpCall('update_transition', JSON.stringify({ transition_id: tid, duration_us: 500_000, kind: 'Crossfade' }))
    expect(upd.ok).toBe(true)
    expect(actor.snapshot().transitions[0]).toMatchObject({ duration_us: 500_000, kind: { kind: 'Crossfade' } })
    const rem = actor.mcpCall('remove_transition', JSON.stringify({ transition_id: tid }))
    expect(rem.ok).toBe(true)
    expect(actor.snapshot().transitions).toEqual([])
  })

  it('bad kind / missing direction / direction on Crossfade → clean invalid_params, no commit', () => {
    const { actor, a1, a2 } = withCut()
    const base = { from_layer_id: a1, to_layer_id: a2, duration_us: 1_000_000 }
    for (const args of [
      { ...base, kind: 'Dissolve' },
      { ...base, kind: 'Wipe' },
      { ...base, kind: 'Slide', direction: 'diagonal' },
      { ...base, kind: 'Crossfade', direction: 'left' },
    ]) {
      const r = actor.mcpCall('add_transition', JSON.stringify(args))
      expect(r.ok, JSON.stringify(args)).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('invalid_params')
    }
    expect(actor.snapshot().transitions).toEqual([])
  })

  it('TransitionInsufficientHandle surfaces friendly prose + structured data (available_us)', () => {
    const { actor, track, a1, a2 } = withCut()
    // A video layer with ZERO tail media (src_out == media duration) as the
    // outgoing participant: extending for the transition is impossible.
    const MID = '00000000-0000-7000-8000-0000000000aa'
    actor.dispatch('add_media', { id: MID, kind: 'Video', duration_us: 2_000_000 })
    actor.dispatch('delete_layer', { layer: a1 }) // free [0,2M)
    const v1 = (actor.dispatch('add_layer', { track, kind: 'video', media: MID, src_in_us: 0, src_out_us: 2_000_000, t_start_us: 0, t_end_us: 2_000_000 }) as { ok: true; value: string }).value
    const r = actor.mcpCall('add_transition', JSON.stringify({ from_layer_id: v1, to_layer_id: a2, duration_us: 1_000_000 }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
    expect(r.error.message).toContain('µs remaining')
    expect(r.error.data).toEqual({ error: 'TransitionInsufficientHandle', layer: v1, available_us: 0 })
  })

  it('audio participant → TransitionUnsupportedLayerKind prose + data', () => {
    const { actor, track, a1, a2 } = withCut()
    const MID = '00000000-0000-7000-8000-0000000000ab'
    actor.dispatch('add_media', { id: MID, kind: 'Audio', duration_us: 10_000_000 })
    actor.dispatch('delete_layer', { layer: a1 })
    const au = (actor.dispatch('add_layer', { track, kind: 'audio', media: MID, src_in_us: 0, src_out_us: 2_000_000, t_start_us: 0, t_end_us: 2_000_000 }) as { ok: true; value: string }).value
    const r = actor.mcpCall('add_transition', JSON.stringify({ from_layer_id: au, to_layer_id: a2, duration_us: 1_000_000 }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
    expect(r.error.message).toContain('visual layers only')
    expect(r.error.data).toEqual({ error: 'TransitionUnsupportedLayerKind', layer: au, kind: 'Audio' })
  })
})

describe('dedicated arms reject malformed scalars before commit', () => {
  const mk = () => createActor({ initial: blankProject(uuidV7Gen(), 't'), idGen: uuidV7Gen(), clock: () => '2026-01-01T00:00:00.000Z' })
  it('set_keyframe rejects non-number t_us', () => {
    const r = mk().mcpCall('set_keyframe', JSON.stringify({ layer_id: '00000000-0000-7000-8000-000000000001', param_key: 'opacity', t_us: 'soon', value: 1 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_params')
  })
  it('set_keyframe rejects non-string param_key', () => {
    const r = mk().mcpCall('set_keyframe', JSON.stringify({ layer_id: '00000000-0000-7000-8000-000000000001', param_key: 42, t_us: 0, value: 1 }))
    expect(r.ok).toBe(false)
  })
  it('dry_run rejects non-array operations', () => {
    const r = mk().mcpCall('dry_run', JSON.stringify({ operations: 'nope' }))
    expect(r.ok).toBe(false)
  })
})
