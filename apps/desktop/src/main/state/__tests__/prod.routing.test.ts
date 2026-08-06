// apps/desktop/src/main/state/__tests__/prod.routing.test.ts
// Focused production adapter routing tests: verifies that actor.command() routes
// channel names → mutations (valid calls succeed + state changes as expected) and
// rejects malformed args with a structured error envelope (no throw). One
// describe block per channel, tagged rich or mechanical.
import { describe, it, expect } from 'vitest'
import { freshActor, aRollId, bRollId } from './pbt/harness'

// ── helpers ──────────────────────────────────────────────────────────────────

function totalLayerCount(actor: ReturnType<typeof freshActor>): number {
  return actor.snapshot().tracks.reduce((n, t) => n + t.layers.length, 0)
}

/** Add a color layer via the production adapter and return the new layer id. */
function addColorLayerCmd(actor: ReturnType<typeof freshActor>, trackId: string, tStartUs = 0, durationUs = 2_000_000): string {
  const r = actor.command('add_color_layer', { trackId, tStartUs, durationUs })
  expect(r.ok, 'setup add_color_layer must succeed').toBe(true)
  if (!r.ok) throw new Error('setup failed')
  return r.value as string
}

// ── Rich channel: add_color_layer ─────────────────────────────────────────────

describe('production adapter routing — add_color_layer (rich)', () => {
  it('valid call routes, returns a layer id, and layer appears in state', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    const r = a.command('add_color_layer', { trackId, tStartUs: 0, durationUs: 5_000_000 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const layerId = r.value as string
    expect(typeof layerId).toBe('string')
    expect(layerId.length).toBeGreaterThan(0)
    const track = a.snapshot().tracks.find((t) => t.id === trackId)!
    expect(track.layers).toHaveLength(1)
    expect(track.layers[0].id).toBe(layerId)
    expect(track.layers[0].params.kind).toBe('Color')
    expect(track.layers[0].t_start_us).toBe(0)
    expect(track.layers[0].t_end_us).toBe(5_000_000)
  })

  it('tStartUs missing (not a number) → structured InvalidArgument error, no throw, no layer added', () => {
    const a = freshActor()
    const r = a.command('add_color_layer', { trackId: aRollId(a), tStartUs: 'now' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    // parseNum('now','tStartUs') throws McpArgError → rich command() catch → InvalidArgument
    expect(r.error.error).toBe('InvalidArgument')
    expect(totalLayerCount(a)).toBe(0)
  })

  it('malformed trackId (non-UUID) → structured InvalidArgument error, no throw, no layer added', () => {
    const a = freshActor()
    const r = a.command('add_color_layer', { trackId: 'bad', tStartUs: 0 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.error).toBe('InvalidArgument')
    expect(totalLayerCount(a)).toBe(0)
  })
})

// ── Rich channel: add_text_layer ──────────────────────────────────────────────

describe('production adapter routing — add_text_layer (rich)', () => {
  it('valid call routes, returns a layer id, and a Text layer appears in state', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    const r = a.command('add_text_layer', { trackId, tStartUs: 0 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const layerId = r.value as string
    expect(typeof layerId).toBe('string')
    const track = a.snapshot().tracks.find((t) => t.id === trackId)!
    expect(track.layers).toHaveLength(1)
    expect(track.layers[0].params.kind).toBe('Text')
    // Verify defaults: content='Text', font Arial 72
    const params = track.layers[0].params as { kind: 'Text'; content: string; font: { family: string; size_px: number } }
    expect(params.content).toBe('Text')
    expect(params.font.family).toBe('Arial')
    expect(params.font.size_px).toBe(72)
  })

  it('tStartUs missing (not a number) → structured InvalidArgument error, no throw', () => {
    const a = freshActor()
    // tStartUs absent → parseNum(undefined,'tStartUs') throws → rich command() catch → InvalidArgument
    const r = a.command('add_text_layer', { trackId: aRollId(a) })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.error).toBe('InvalidArgument')
    expect(totalLayerCount(a)).toBe(0)
  })
})

// ── Rich channel: paste_layer ─────────────────────────────────────────────────

describe('production adapter routing — paste_layer (rich)', () => {
  it('uses an explicit target track for an Alt-drag duplicate', () => {
    const a = freshActor()
    const sourceId = addColorLayerCmd(a, aRollId(a), 0, 2_000_000)
    const targetTrackId = bRollId(a)
    const historyLenBefore = a.historyView(10).len

    const r = a.command('paste_layer', {
      layerId: sourceId,
      tStartUs: 3_000_000,
      targetTrackId,
    })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    const pastedId = r.value as string
    const sourceTrack = a.snapshot().tracks.find((track) => track.id === aRollId(a))!
    const targetTrack = a.snapshot().tracks.find((track) => track.id === targetTrackId)!
    expect(sourceTrack.layers.map((layer) => layer.id)).toEqual([sourceId])
    expect(targetTrack.layers.find((layer) => layer.id === pastedId)).toMatchObject({
      t_start_us: 3_000_000,
      t_end_us: 5_000_000,
    })
    expect(a.historyView(10).len).toBe(historyLenBefore + 1)
  })

  it('clones the whole layer at the requested time and auto-creates an Overlay track', () => {
    const a = freshActor()
    const sourceId = addColorLayerCmd(a, aRollId(a), 0, 2_000_000)
    a.command('update_layer', { layerId: sourceId, patch: { label: 'Copied clip' } })
    a.command('add_effect', { layerId: sourceId, kind: 'blur' })
    const source = a.snapshot().tracks[0].layers[0]

    const r = a.command('paste_layer', { layerId: sourceId, tStartUs: 3_000_000 })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    const pastedId = r.value as string
    const snap = a.snapshot()
    const target = snap.tracks.find((track) => track.layers.some((layer) => layer.id === pastedId))!
    const pasted = target.layers.find((layer) => layer.id === pastedId)!
    expect(target.role).toBeNull()
    expect(target.label).toBe('Overlay')
    expect(pasted.id).not.toBe(sourceId)
    expect(pasted.label).toBe('Copied clip')
    expect(pasted.params).toEqual(source.params)
    expect(pasted.effects).toEqual(source.effects)
    expect(pasted.t_start_us).toBe(3_000_000)
    expect(pasted.t_end_us).toBe(5_000_000)
  })

  it('reuses a free automatic track, then creates another when the interval conflicts', () => {
    const a = freshActor()
    const sourceId = addColorLayerCmd(a, aRollId(a), 0, 2_000_000)

    const first = a.command('paste_layer', { layerId: sourceId, tStartUs: 3_000_000 })
    expect(first.ok).toBe(true)
    const firstTarget = a.snapshot().tracks.find((track) =>
      track.layers.some((layer) => layer.id === (first.ok ? first.value : null)),
    )!.id

    const second = a.command('paste_layer', { layerId: sourceId, tStartUs: 6_000_000 })
    expect(second.ok).toBe(true)
    const secondTarget = a.snapshot().tracks.find((track) =>
      track.layers.some((layer) => layer.id === (second.ok ? second.value : null)),
    )!.id
    expect(secondTarget).toBe(firstTarget)
    expect(a.snapshot().tracks).toHaveLength(3)

    const conflicting = a.command('paste_layer', { layerId: sourceId, tStartUs: 6_000_000 })
    expect(conflicting.ok).toBe(true)
    const conflictingTarget = a.snapshot().tracks.find((track) =>
      track.layers.some((layer) => layer.id === (conflicting.ok ? conflicting.value : null)),
    )!.id
    expect(conflictingTarget).not.toBe(firstTarget)
    expect(a.snapshot().tracks).toHaveLength(4)
  })

  it('rejects a missing copied layer before creating a track', () => {
    const a = freshActor()
    const r = a.command('paste_layer', {
      layerId: '00000000-0000-0000-0000-000000000099',
      tStartUs: 0,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.error).toBe('LayerNotFound')
    expect(a.snapshot().tracks).toHaveLength(2)
  })
})

// ── Rich channel: add_demo_color_layer ────────────────────────────────────────

describe('production adapter routing — add_demo_color_layer (rich)', () => {
  it('valid call routes with no args, places a Color layer on the first track', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    const r = a.command('add_demo_color_layer', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const layerId = r.value as string
    expect(typeof layerId).toBe('string')
    // Layer lands on the first (A-roll) track
    const track = a.snapshot().tracks.find((t) => t.id === trackId)!
    expect(track.layers).toHaveLength(1)
    expect(track.layers[0].id).toBe(layerId)
    expect(track.layers[0].params.kind).toBe('Color')
    // Duration is 2s (actor.ts's add_demo_color_layer arm)
    expect(track.layers[0].t_end_us - track.layers[0].t_start_us).toBe(2_000_000)
  })

  it('consecutive calls append layers sequentially', () => {
    const a = freshActor()
    a.command('add_demo_color_layer', {})
    a.command('add_demo_color_layer', {})
    const track = a.snapshot().tracks[0]
    expect(track.layers).toHaveLength(2)
    // Second layer starts where first ends
    expect(track.layers[1].t_start_us).toBe(track.layers[0].t_end_us)
  })
})

// ── Rich channel: add_demo_text_layer ─────────────────────────────────────────

describe('production adapter routing — add_demo_text_layer (rich)', () => {
  it('valid call routes with no args, places a Text layer on the last track', () => {
    const a = freshActor()
    const r = a.command('add_demo_text_layer', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const layerId = r.value as string
    const snap = a.snapshot()
    const lastTrack = snap.tracks[snap.tracks.length - 1]
    expect(lastTrack.layers.some((l) => l.id === layerId)).toBe(true)
    const layer = lastTrack.layers.find((l) => l.id === layerId)!
    expect(layer.params.kind).toBe('Text')
    const params = layer.params as Extract<typeof layer.params, { kind: 'Text' }>
    expect(params.content).toBe('TEXT')
    expect(params.font.size_px).toBe(96)
    // Duration is 3s (actor.ts's add_demo_text_layer arm)
    expect(layer.t_end_us - layer.t_start_us).toBe(3_000_000)
  })
})

// ── Mechanical channel: update_layer ──────────────────────────────────────────

describe('production adapter routing — update_layer (mechanical)', () => {
  it('valid call routes and label is updated in state', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    const layerId = addColorLayerCmd(a, trackId)

    const r = a.command('update_layer', { layerId, patch: { label: 'Hero Clip' } })
    expect(r.ok).toBe(true)
    const track = a.snapshot().tracks.find((t) => t.id === trackId)!
    expect(track.layers[0].label).toBe('Hero Clip')
  })

  it('malformed layerId (absent) → structured LayerNotFound error, no throw, layer unchanged', () => {
    const a = freshActor()
    const r = a.command('update_layer', { patch: { label: 'x' } })
    expect(r.ok).toBe(false)
    if (r.ok) return
    // layerId forwarded as undefined → checkTrackLock can't locate it → LayerNotFound
    expect(r.error.error).toBe('LayerNotFound')
    // No layers were mutated
    expect(totalLayerCount(a)).toBe(0)
  })
})

// ── Mechanical channel: move_layer ────────────────────────────────────────────

describe('production adapter routing — move_layer (mechanical)', () => {
  it('valid call routes and layer moves to destination track', () => {
    const a = freshActor()
    const srcTrackId = aRollId(a)
    const dstTrackId = bRollId(a)
    const layerId = addColorLayerCmd(a, srcTrackId, 0, 2_000_000)

    const r = a.command('move_layer', { layerId, newTrackId: dstTrackId, newTStartUs: 0 })
    expect(r.ok).toBe(true)
    const dst = a.snapshot().tracks.find((t) => t.id === dstTrackId)!
    expect(dst.layers.some((l) => l.id === layerId)).toBe(true)
    const src = a.snapshot().tracks.find((t) => t.id === srcTrackId)!
    expect(src.layers.some((l) => l.id === layerId)).toBe(false)
  })

  it('missing newTrackId → structured TrackNotFound error, no throw, layer stays on original track', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    const layerId = addColorLayerCmd(a, trackId, 0, 2_000_000)
    // newTrackId forwarded as undefined → applyMoveLayer locates the source layer
    // (exists) then fails to find the destination track → TrackNotFound.
    const r = a.command('move_layer', { layerId, newTStartUs: 0 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.error).toBe('TrackNotFound')
    // Layer must still be on the source track
    const src = a.snapshot().tracks.find((t) => t.id === trackId)!
    expect(src.layers.some((l) => l.id === layerId)).toBe(true)
  })
})

// ── Mechanical channel: trim_layer ────────────────────────────────────────────

describe('production adapter routing — trim_layer (mechanical)', () => {
  it('valid call routes and layer end time changes', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    const layerId = addColorLayerCmd(a, trackId, 0, 4_000_000)

    const r = a.command('trim_layer', { layerId, edge: 'out', newTUs: 2_000_000 })
    expect(r.ok).toBe(true)
    const track = a.snapshot().tracks.find((t) => t.id === trackId)!
    expect(track.layers[0].t_end_us).toBe(2_000_000)
  })

  it('missing newTUs (undefined, non-parseable) → structured error, no throw, layer unchanged', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    const layerId = addColorLayerCmd(a, trackId, 0, 4_000_000)

    // newTUs absent → the dispatch core's parseNum(undefined,'new_t_us') throws an
    // McpArgError that the dispatch catch maps to InvalidArgument.
    const r = a.command('trim_layer', { layerId, edge: 'out' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.error).toBe('InvalidArgument')
    // Layer end must be unchanged
    const track = a.snapshot().tracks.find((t) => t.id === trackId)!
    expect(track.layers[0].t_end_us).toBe(4_000_000)
  })
})

// ── Mechanical channel: delete_layer ─────────────────────────────────────────

describe('production adapter routing — delete_layer (mechanical)', () => {
  it('valid call routes and layer is removed from state', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    const layerId = addColorLayerCmd(a, trackId)

    expect(totalLayerCount(a)).toBe(1)
    const r = a.command('delete_layer', { layerId })
    expect(r.ok).toBe(true)
    expect(totalLayerCount(a)).toBe(0)
  })

  it('non-existent layerId → structured LayerNotFound error, no throw', () => {
    const a = freshActor()
    const r = a.command('delete_layer', { layerId: '00000000-0000-0000-0000-000000000000' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.error).toBe('LayerNotFound')
    expect(totalLayerCount(a)).toBe(0)
  })
})

// ── Mechanical channel: duplicate_layer ───────────────────────────────────────

describe('production adapter routing — duplicate_layer (mechanical)', () => {
  it('valid call routes, returns a new layer id, and track has two layers', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    const layerId = addColorLayerCmd(a, trackId, 0, 2_000_000)

    const r = a.command('duplicate_layer', { layerId, tOffsetUs: 2_000_000 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const newId = r.value as string
    expect(newId).not.toBe(layerId)
    const track = a.snapshot().tracks.find((t) => t.id === trackId)!
    expect(track.layers).toHaveLength(2)
    // Duplicate starts at offset
    const dup = track.layers.find((l) => l.id === newId)!
    expect(dup.t_start_us).toBe(2_000_000)
  })

  it('non-existent layerId → structured LayerNotFound error, no throw, no layer added', () => {
    const a = freshActor()
    const r = a.command('duplicate_layer', { layerId: '00000000-0000-0000-0000-000000000000', tOffsetUs: 0 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    // prod command() error envelope is a CommandError: the structured field is `error.error`
    expect(r.error.error).toBe('LayerNotFound')
    expect(totalLayerCount(a)).toBe(0)
  })
})

// ── Mechanical channel: groups_create ────────────────────────────────────────

describe('production adapter routing — groups_create (mechanical)', () => {
  it('valid call routes, returns a group id, and group appears in state', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    const id1 = addColorLayerCmd(a, trackId, 0, 2_000_000)
    const id2 = addColorLayerCmd(a, trackId, 2_000_000, 4_000_000)

    const r = a.command('groups_create', { layerIds: [id1, id2] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const groupId = r.value as string
    expect(typeof groupId).toBe('string')
    const groups = a.snapshot().groups
    expect(groups.some((g) => g.id === groupId && g.members.includes(id1) && g.members.includes(id2))).toBe(true)
  })

  it('single layer id → structured GroupCreateNeedsTwoLayers error, no throw', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    const id1 = addColorLayerCmd(a, trackId)
    // groups_create requires at least 2 distinct layer ids
    const r = a.command('groups_create', { layerIds: [id1] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.error).toBe('GroupCreateNeedsTwoLayers')
    expect(a.snapshot().groups).toHaveLength(0)
  })
})

// ── Mechanical channel: set_role_gain ────────────────────────────────────────

describe('production adapter routing — set_role_gain (mechanical)', () => {
  it('valid call routes and role gain is updated in state', () => {
    const a = freshActor()
    const r = a.command('set_role_gain', { role: 'dialogue', gainDb: -3 })
    expect(r.ok).toBe(true)
    const roles = a.snapshot().audio_roles
    expect(roles['dialogue']?.gain_db).toBe(-3)
  })

  it('gainDb missing (undefined) → structured InvalidArgument error, no throw', () => {
    const a = freshActor()
    // The prod mechanical adapter does NOT parse-reject: it forwards gain_db: undefined
    // straight through (commands.ts MECHANICAL.set_role_gain). The rejection happens
    // DOWNSTREAM in the dispatch core, where parseNum(undefined,'gain_db') throws an
    // McpArgError that the dispatch catch maps to InvalidArgument. (The MCP side, by
    // contrast, parse-rejects at the adapter via parseNum in parseArgs.)
    const r = a.command('set_role_gain', { role: 'dialogue' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.error).toBe('InvalidArgument')
  })
})

// ── Mechanical channel: fit_composition_to_layers ────────────────────────────

describe('production adapter routing — fit_composition_to_layers (mechanical)', () => {
  it('valid call routes and composition duration matches the layer high-water mark', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    // Add a layer ending at 8s
    addColorLayerCmd(a, trackId, 0, 8_000_000)
    // Pin duration to something else
    a.command('set_composition', { patch: { duration_us: 20_000_000 } })
    expect(a.snapshot().composition.duration_pinned).toBe(true)

    const r = a.command('fit_composition_to_layers', {})
    expect(r.ok).toBe(true)
    const comp = a.snapshot().composition
    expect(comp.duration_us).toBe(8_000_000)
    expect(comp.duration_pinned).toBe(false)
  })
})

// ── Mechanical channel: project_undo / project_redo ──────────────────────────

describe('production adapter routing — project_undo / project_redo (mechanical)', () => {
  it('project_undo routes and reverses the last mutation', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    addColorLayerCmd(a, trackId)
    expect(totalLayerCount(a)).toBe(1)

    const r = a.command('project_undo', {})
    expect(r.ok).toBe(true)
    expect(totalLayerCount(a)).toBe(0)
  })

  it('project_redo routes and re-applies the undone mutation', () => {
    const a = freshActor()
    const trackId = aRollId(a)
    addColorLayerCmd(a, trackId)
    a.command('project_undo', {})
    expect(totalLayerCount(a)).toBe(0)

    const r = a.command('project_redo', {})
    expect(r.ok).toBe(true)
    expect(totalLayerCount(a)).toBe(1)
  })

  it('project_undo at origin → structured NothingToUndo error, no throw', () => {
    const a = freshActor()
    const r = a.command('project_undo', {})
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.error).toBe('NothingToUndo')
  })
})

// ── Unknown channel ───────────────────────────────────────────────────────────

describe('production adapter routing — unknown channel', () => {
  it('unknown channel → structured InvalidArgument error, no throw', () => {
    const a = freshActor()
    const r = a.command('does_not_exist', {})
    expect(r.ok).toBe(false)
    if (r.ok) return
    // command()'s default arm returns { error: 'InvalidArgument', field: 'op', ... }
    expect(r.error.error).toBe('InvalidArgument')
  })
})
