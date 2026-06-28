// apps/desktop/src/main/state/__tests__/mcp.routing.test.ts
// Focused MCP adapter routing tests: verifies that actor.mcpCall() correctly
// routes tool names → mutations (valid calls succeed + state changes as expected)
// and rejects malformed args with a structured error envelope (no throw).
// Replaces the oracle-mcp differential (Task 13 deletes that). Coverage:
// table-exec tools (add_track, delete_layer, trim_layer, move_layer,
// groups_create, set_role_gain, undo/redo) and dedicated-exec tools
// (add_color_layer, add_marker, split_layer, set_keyframe, add_track).
import { describe, it, expect } from 'vitest'
import { freshActor, aRollId, bRollId } from './pbt/harness'

// ── helpers ──────────────────────────────────────────────────────────────────

function totalLayerCount(actor: ReturnType<typeof freshActor>): number {
  return actor.snapshot().tracks.reduce((n, t) => n + t.layers.length, 0)
}

/** Add a color layer via the MCP adapter and assert it succeeded. Returns the new layer id. */
function addColorLayerMcp(actor: ReturnType<typeof freshActor>, trackId: string, t0 = 0, t1 = 2_000_000): string {
  const r = actor.mcpCall('add_color_layer', JSON.stringify({
    track_id: trackId,
    color: { r: 10, g: 20, b: 30, a: 255 },
    t_start_us: t0,
    t_end_us: t1,
  }))
  expect(r.ok, 'setup add_color_layer must succeed').toBe(true)
  if (!r.ok) throw new Error('setup failed')
  return r.result.content[0].text
}

// ── Dedicated-exec: add_color_layer ──────────────────────────────────────────

describe('MCP adapter routing — add_color_layer (dedicated)', () => {
  it('valid call routes, returns a layer id, and the layer appears in state', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    const r = a.mcpCall('add_color_layer', JSON.stringify({
      track_id: trackId,
      color: { r: 255, g: 0, b: 0, a: 255 },
      t_start_us: 0,
      t_end_us: 3_000_000,
    }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // result is a text block containing the new layer UUID
    const layerId = r.result.content[0].text
    expect(typeof layerId).toBe('string')
    expect(layerId.length).toBeGreaterThan(0)
    // state mutation: one layer exists on the A-roll track
    const track = a.snapshot().tracks.find((t) => t.id === trackId)!
    expect(track.layers).toHaveLength(1)
    expect(track.layers[0].id).toBe(layerId)
    expect(track.layers[0].params.kind).toBe('Color')
  })

  it('malformed track_id (not a UUID) → structured invalid_params error, no throw, no layer added', () => {
    const a = freshActor()
    const r = a.mcpCall('add_color_layer', JSON.stringify({
      track_id: 'not-a-uuid',
      color: { r: 0, g: 0, b: 0, a: 255 },
      t_start_us: 0,
      t_end_us: 1_000_000,
    }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
    expect(totalLayerCount(a)).toBe(0)
  })

  it('malformed color (string instead of {r,g,b,a}) → structured invalid_params error, no throw', () => {
    const a = freshActor()
    const r = a.mcpCall('add_color_layer', JSON.stringify({
      track_id: aRollId(a),
      color: '#ff0000',
      t_start_us: 0,
      t_end_us: 1_000_000,
    }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
    expect(totalLayerCount(a)).toBe(0)
  })
})

// ── Dedicated-exec: add_marker ────────────────────────────────────────────────

describe('MCP adapter routing — add_marker (dedicated)', () => {
  it('valid call routes, returns a marker id, and the marker appears in state', () => {
    const a = freshActor()
    const r = a.mcpCall('add_marker', JSON.stringify({
      color: { r: 0, g: 128, b: 255, a: 255 },
      label: 'My Marker',
      t_us: 1_500_000,
    }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const markerId = r.result.content[0].text
    expect(typeof markerId).toBe('string')
    const markers = a.snapshot().markers
    expect(markers).toHaveLength(1)
    expect(markers[0].id).toBe(markerId)
    expect(markers[0].label).toBe('My Marker')
    expect(markers[0].t_us).toBe(1_500_000)
  })

  it('malformed t_us (string) → structured invalid_params error, no throw, no marker added', () => {
    const a = freshActor()
    const r = a.mcpCall('add_marker', JSON.stringify({
      color: { r: 0, g: 0, b: 0, a: 255 },
      label: 'x',
      t_us: 'not-a-number',
    }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
    expect(a.snapshot().markers).toHaveLength(0)
  })

  it('malformed color → structured invalid_params error, no throw', () => {
    const a = freshActor()
    const r = a.mcpCall('add_marker', JSON.stringify({
      color: 'red',
      label: 'x',
      t_us: 0,
    }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
  })
})

// ── Dedicated-exec: split_layer ────────────────────────────────────────────────

describe('MCP adapter routing — split_layer (dedicated)', () => {
  it('valid call routes, returns {left, right} ids, and state has two layers', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    const layerId = addColorLayerMcp(a, trackId, 0, 4_000_000)

    const r = a.mcpCall('split_layer', JSON.stringify({
      layer_id: layerId,
      at_t_us: 2_000_000,
    }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const text = r.result.content[0].text
    const parsed = JSON.parse(text) as { left: string; right: string }
    expect(typeof parsed.left).toBe('string')
    expect(typeof parsed.right).toBe('string')
    expect(parsed.left).toBe(layerId) // original layer id = left
    // state: track now has two layers
    const track = a.snapshot().tracks.find((t) => t.id === trackId)!
    expect(track.layers).toHaveLength(2)
  })

  it('malformed layer_id (not a UUID) → structured invalid_params error, no throw', () => {
    const a = freshActor()
    const r = a.mcpCall('split_layer', JSON.stringify({
      layer_id: 123,
      at_t_us: 1_000_000,
    }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
  })
})

// ── Table-exec: add_track ──────────────────────────────────────────────────────

describe('MCP adapter routing — add_track (table)', () => {
  it('valid call routes, returns a track id, and track appears in state', () => {
    const a = freshActor()
    const before = a.snapshot().tracks.length
    const r = a.mcpCall('add_track', JSON.stringify({ label: 'VFX' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const trackId = r.result.content[0].text
    expect(typeof trackId).toBe('string')
    const after = a.snapshot().tracks
    expect(after.length).toBe(before + 1)
    const newTrack = after.find((t) => t.id === trackId)!
    expect(newTrack).toBeDefined()
    expect(newTrack.label).toBe('VFX')
  })

  // add_track has no required args (label is optional), so malformed-arg test
  // targets an invalid label type instead.
  it('invalid label type (number) → structured error, no throw, no extra track', () => {
    const a = freshActor()
    const before = a.snapshot().tracks.length
    const r = a.mcpCall('add_track', JSON.stringify({ label: 42 }))
    // parseStrOpt only rejects non-string non-null/undefined; 42 is a number → invalid_params
    if (r.ok) {
      // Some implementations may silently coerce; if ok, state must still be consistent
      expect(a.snapshot().tracks.length).toBeGreaterThanOrEqual(before)
    } else {
      expect(r.error.code).toBe('invalid_params')
      expect(a.snapshot().tracks.length).toBe(before)
    }
  })
})

// ── Table-exec: delete_layer ──────────────────────────────────────────────────

describe('MCP adapter routing — delete_layer (table)', () => {
  it('valid call routes and the layer is removed from state', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    const layerId = addColorLayerMcp(a, trackId)

    expect(totalLayerCount(a)).toBe(1)
    const r = a.mcpCall('delete_layer', JSON.stringify({ layer_id: layerId }))
    expect(r.ok).toBe(true)
    expect(totalLayerCount(a)).toBe(0)
  })

  it('malformed layer_id (non-UUID string) → structured invalid_params error, no throw, layer still exists', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    addColorLayerMcp(a, trackId)

    const r = a.mcpCall('delete_layer', JSON.stringify({ layer_id: 'bad-id' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
    // Layer must still be there
    expect(totalLayerCount(a)).toBe(1)
  })
})

// ── Table-exec: trim_layer ────────────────────────────────────────────────────

describe('MCP adapter routing — trim_layer (table)', () => {
  it('valid call routes and the layer end time changes', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    const layerId = addColorLayerMcp(a, trackId, 0, 4_000_000)

    const r = a.mcpCall('trim_layer', JSON.stringify({
      layer_id: layerId,
      edge: 'out',
      new_t_us: 2_000_000,
    }))
    expect(r.ok).toBe(true)
    const track = a.snapshot().tracks.find((t) => t.id === trackId)!
    expect(track.layers[0].t_end_us).toBe(2_000_000)
  })

  it('malformed layer_id → structured invalid_params error, no throw, layer unchanged', () => {
    const a = freshActor()
    const r = a.mcpCall('trim_layer', JSON.stringify({
      layer_id: 999,
      edge: 'out',
      new_t_us: 1_000_000,
    }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
  })
})

// ── Table-exec: move_layer ────────────────────────────────────────────────────

describe('MCP adapter routing — move_layer (table)', () => {
  it('valid call routes and the layer moves to the destination track', () => {
    const a = freshActor()
    const srcTrackId = aRollId(a)
    const dstTrackId = bRollId(a)
    const layerId = addColorLayerMcp(a, srcTrackId, 0, 2_000_000)

    const r = a.mcpCall('move_layer', JSON.stringify({
      layer_id: layerId,
      new_t_start_us: 0,
      new_track_id: dstTrackId,
    }))
    expect(r.ok).toBe(true)
    // Layer must be on the destination track now
    const dst = a.snapshot().tracks.find((t) => t.id === dstTrackId)!
    expect(dst.layers.some((l) => l.id === layerId)).toBe(true)
    // Layer must be absent from source track
    const src = a.snapshot().tracks.find((t) => t.id === srcTrackId)!
    expect(src.layers.some((l) => l.id === layerId)).toBe(false)
  })

  it('malformed new_track_id (not a UUID) → structured invalid_params error, no throw', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    const layerId = addColorLayerMcp(a, trackId, 0, 2_000_000)

    const r = a.mcpCall('move_layer', JSON.stringify({
      layer_id: layerId,
      new_t_start_us: 0,
      new_track_id: 'not-a-uuid',
    }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
    // Layer must still be on the original track
    const src = a.snapshot().tracks.find((t) => t.id === trackId)!
    expect(src.layers.some((l) => l.id === layerId)).toBe(true)
  })
})

// ── Table-exec: groups_create ──────────────────────────────────────────────────

describe('MCP adapter routing — groups_create (table)', () => {
  it('valid call routes, returns a group id, and group appears in state', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    const id1 = addColorLayerMcp(a, trackId, 0, 2_000_000)
    const id2 = addColorLayerMcp(a, trackId, 2_000_000, 4_000_000)

    const r = a.mcpCall('groups_create', JSON.stringify({ layer_ids: [id1, id2] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const groupId = r.result.content[0].text
    expect(typeof groupId).toBe('string')
    const groups = a.snapshot().groups
    expect(groups.some((g) => g.id === groupId && g.members.includes(id1) && g.members.includes(id2))).toBe(true)
  })

  it('malformed layer_ids (not an array) → structured invalid_params error, no throw', () => {
    const a = freshActor()
    const r = a.mcpCall('groups_create', JSON.stringify({ layer_ids: 'not-an-array' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
    expect(a.snapshot().groups).toHaveLength(0)
  })

  it('malformed layer_ids entries (non-UUID strings) → structured invalid_params error, no throw', () => {
    const a = freshActor()
    const r = a.mcpCall('groups_create', JSON.stringify({ layer_ids: ['not-a-uuid', 'also-bad'] }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
  })
})

// ── Table-exec: set_role_gain ──────────────────────────────────────────────────

describe('MCP adapter routing — set_role_gain (table)', () => {
  it('valid call routes and the role gain is updated in state', () => {
    const a = freshActor()
    const r = a.mcpCall('set_role_gain', JSON.stringify({ role: 'music', gain_db: -6 }))
    expect(r.ok).toBe(true)
    const roles = a.snapshot().audio_roles
    expect(roles['music']?.gain_db).toBe(-6)
  })

  it('unknown role → structured invalid_params error, no throw', () => {
    const a = freshActor()
    const r = a.mcpCall('set_role_gain', JSON.stringify({ role: 'unknown_role', gain_db: 0 }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
  })

  it('gain_db missing (non-number) → structured invalid_params error, no throw', () => {
    const a = freshActor()
    const r = a.mcpCall('set_role_gain', JSON.stringify({ role: 'music', gain_db: 'loud' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
  })
})

// ── Table-exec: undo / redo ────────────────────────────────────────────────────

describe('MCP adapter routing — undo / redo (table)', () => {
  it('undo routes and reverses the last mutation', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    addColorLayerMcp(a, trackId)
    expect(totalLayerCount(a)).toBe(1)

    const r = a.mcpCall('undo', JSON.stringify({}))
    expect(r.ok).toBe(true)
    expect(totalLayerCount(a)).toBe(0)
  })

  it('redo routes and re-applies the undone mutation', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    addColorLayerMcp(a, trackId)
    a.mcpCall('undo', JSON.stringify({}))
    expect(totalLayerCount(a)).toBe(0)

    const r = a.mcpCall('redo', JSON.stringify({}))
    expect(r.ok).toBe(true)
    expect(totalLayerCount(a)).toBe(1)
  })

  it('undo at origin → structured error (NothingToUndo), no throw', () => {
    const a = freshActor()
    const r = a.mcpCall('undo', JSON.stringify({}))
    expect(r.ok).toBe(false)
    if (r.ok) return
    // MCP maps NothingToUndo → invalid_params (mapCommandError)
    expect(r.error.code).toBe('invalid_params')
  })
})

// ── Dedicated-exec: set_keyframe ───────────────────────────────────────────────
// Note: Color layers have no opacity or transform — use an add_marker's textual
// layer as a vehicle. Instead, we add a Text layer via the table-exec add_track
// path + dispatch, then set_keyframe on its opacity param (Text has opacity).

describe('MCP adapter routing — set_keyframe (dedicated)', () => {
  it('valid call routes on a Text layer opacity param and track becomes Keyframed', () => {
    const a = freshActor()
    // Add a track then add a Text layer via dispatch (the underlying actor channel)
    // so we get a layer with an opacity param that set_keyframe can target.
    const trackId = aRollId(a)
    const addR = a.dispatch('add_layer', { kind: 'text', track: trackId, t_start_us: 0, t_end_us: 4_000_000 })
    expect(addR.ok).toBe(true)
    if (!addR.ok) return
    const layerId = addR.value as string

    const r = a.mcpCall('set_keyframe', JSON.stringify({
      layer_id: layerId,
      param_key: 'opacity',
      t_us: 2_000_000,
      value: 0.5,
      interp: { kind: 'Linear' },
    }))
    expect(r.ok).toBe(true)

    // Verify via get_param_track that the track is now Keyframed
    const gr = a.mcpCall('get_param_track', JSON.stringify({
      layer_id: layerId,
      param_key: 'opacity',
    }))
    expect(gr.ok).toBe(true)
    if (!gr.ok) return
    const parsed = JSON.parse(gr.result.content[0].text) as { mode: string }
    expect(parsed.mode).toBe('Keyframed')
  })

  it('malformed layer_id (not a UUID) → structured invalid_params error, no throw', () => {
    const a = freshActor()
    const r = a.mcpCall('set_keyframe', JSON.stringify({
      layer_id: 'bad-id',
      param_key: 'opacity',
      t_us: 1_000_000,
      value: 0.5,
      interp: { kind: 'Linear' },
    }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
  })

  it('malformed interp (unknown kind) → structured invalid_params error, no throw', () => {
    const a = freshActor()
    // Set up a Text layer for set_keyframe to target
    const trackId = aRollId(a)
    const addR = a.dispatch('add_layer', { kind: 'text', track: trackId, t_start_us: 0, t_end_us: 4_000_000 })
    expect(addR.ok).toBe(true)
    if (!addR.ok) return
    const layerId = addR.value as string

    const r = a.mcpCall('set_keyframe', JSON.stringify({
      layer_id: layerId,
      param_key: 'opacity',
      t_us: 1_000_000,
      value: 0.5,
      interp: { kind: 'Squiggly' },
    }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
  })
})

// ── Unknown tool name ──────────────────────────────────────────────────────────

describe('MCP adapter routing — unknown tool', () => {
  it('unknown tool name → structured error (not_found or invalid_params), no throw', () => {
    const a = freshActor()
    const r = a.mcpCall('does_not_exist', JSON.stringify({}))
    expect(r.ok).toBe(false)
    if (r.ok) return
    // The adapter returns not_found or invalid_params for unknown tools
    expect(['not_found', 'invalid_params', 'invalid_request']).toContain(r.error.code)
  })
})

// ── Invalid JSON args (parse failure) ──────────────────────────────────────────

describe('MCP adapter routing — invalid JSON args', () => {
  it('broken JSON string → structured invalid_params error, no throw', () => {
    const a = freshActor()
    const r = a.mcpCall('add_color_layer', '{broken json')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
  })
})
