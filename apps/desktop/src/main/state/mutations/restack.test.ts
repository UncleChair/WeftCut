// apps/desktop/src/main/state/mutations/restack.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Project } from '../model'
import { applyAddLayer, applyAddTrack, colorParams } from './add'
import { applyRestackLayer } from './restack'
import { isCommandFailure } from '../errors'
import type { CommandError } from '../errors'
import { createActor } from '../actor'

function audioL(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = {
    kind: 'Audio', media: 'm', src_in_us: 0, src_out_us: t1 - t0,
    gain_db: { mode: 'Static', value: 0 }, pan: { mode: 'Static', value: 0 },
    fade_in_us: 0, fade_out_us: 0, mute: false, role: 'dialogue',
  }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
const C = colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1)

/** [A-roll, B-roll, wash(x), logo(y)] — two transient overlay lanes above the
 *  reserved skeleton, one visual layer each. Track index = z (0 = bottom). */
function overlayStack(): { p: Project; g: IdGen; washId: string; logoId: string; x: string; y: string } {
  const g = seededGen(); const p = blankProject(g, 't')
  const washId = applyAddTrack(p, g, 'wash') // idx 2
  const logoId = applyAddTrack(p, g, 'logo') // idx 3
  const x = applyAddLayer(p, g, washId, C, 0, 1_000_000)
  const y = applyAddLayer(p, g, logoId, C, 0, 1_000_000)
  return { p, g, washId, logoId, x, y }
}
const order = (p: Project): string[] => p.tracks.map((t) => t.id)
const track = (p: Project, id: string) => p.tracks.find((t) => t.id === id)

function cmdErr(fn: () => void): CommandError {
  try { fn() } catch (e) {
    if (isCommandFailure(e)) return e.err
    throw e
  }
  throw new Error('expected CommandFailure')
}

describe('applyRestackLayer — smart degradation', () => {
  it('sole-occupant mover: the whole track splices above the anchor, keeping id, label, lock and height', () => {
    const { p, g, washId, logoId, x, y } = overlayStack()
    const wash = track(p, washId)!
    wash.locked = true
    wash.height_px = 96
    const ret = applyRestackLayer(p, g, x, y, 'above')
    expect(ret).toBe(washId) // the destination lane IS the moved track
    expect(order(p)).toEqual([p.tracks[0].id, p.tracks[1].id, logoId, washId])
    const moved = track(p, washId)!
    expect(moved.label).toBe('wash')
    expect(moved.locked).toBe(true)
    expect(moved.height_px).toBe(96)
    expect(moved.layers.map((l) => l.id)).toEqual([x])
  })

  it('sole-occupant mover: below splices the track directly beneath the anchor', () => {
    const { p, g, washId, logoId, y } = overlayStack()
    const [aRoll, bRoll] = order(p)
    const ret = applyRestackLayer(p, g, y, /* anchor */ p.tracks[2].layers[0].id, 'below')
    expect(ret).toBe(logoId)
    expect(order(p)).toEqual([aRoll, bRoll, logoId, washId])
  })

  it('shared-track mover (audio co-resident) splits onto a new lane above the anchor; the source keeps its audio', () => {
    const { p, g, washId, x, y } = overlayStack()
    track(p, washId)!.layers.push(audioL('au', 0, 1_000_000))
    const before = order(p)
    const ret = applyRestackLayer(p, g, x, y, 'above')
    expect(ret).not.toBeNull()
    expect(ret).not.toBe(washId) // a fresh lane, not the shared one
    expect(order(p)).toEqual([...before, ret]) // directly above logo = tail
    const fresh = track(p, ret!)!
    expect(fresh.layers.map((l) => l.id)).toEqual([x])
    // new lane carries Track::new() defaults — the name derives from position
    expect(fresh.label).toBeNull()
    expect(fresh.role).toBeNull()
    expect(fresh.transient).toBe(true)
    // the source survives with what it still holds — no prune of a non-empty lane
    expect(track(p, washId)!.layers.map((l) => l.id)).toEqual(['au'])
  })

  it('shared-track mover splits below the anchor at exactly the anchor track position', () => {
    // Three overlay lanes: wash(x + au) / mid / top(w). Dropping x below w is a
    // real move (wash is NOT already adjacent), so the split lands at idx 4.
    const g = seededGen(); const p = blankProject(g, 't')
    const washId = applyAddTrack(p, g, 'wash') // idx 2
    const midId = applyAddTrack(p, g, 'mid')   // idx 3
    const topId = applyAddTrack(p, g, 'top')   // idx 4
    const x = applyAddLayer(p, g, washId, C, 0, 1_000_000)
    applyAddLayer(p, g, midId, C, 0, 1_000_000)
    const w = applyAddLayer(p, g, topId, C, 0, 1_000_000)
    track(p, washId)!.layers.push(audioL('au', 0, 1_000_000))
    const [aRoll, bRoll] = order(p)
    const ret = applyRestackLayer(p, g, x, w, 'below')
    expect(order(p)).toEqual([aRoll, bRoll, washId, midId, ret!, topId])
    expect(track(p, ret!)!.layers.map((l) => l.id)).toEqual([x])
    expect(track(p, washId)!.layers.map((l) => l.id)).toEqual(['au'])
  })

  it('an anchor on the mover own shared track splits the mover off it', () => {
    const g = seededGen(); const p = blankProject(g, 't')
    const washId = applyAddTrack(p, g, 'wash')
    const x = applyAddLayer(p, g, washId, C, 0, 1_000_000)
    const z = applyAddLayer(p, g, washId, C, 2_000_000, 3_000_000) // same class, no overlap
    const ret = applyRestackLayer(p, g, x, z, 'above')
    expect(ret).not.toBe(washId)
    expect(order(p)).toEqual([p.tracks[0].id, p.tracks[1].id, washId, ret!])
    expect(track(p, washId)!.layers.map((l) => l.id)).toEqual([z])
    expect(track(p, ret!)!.layers.map((l) => l.id)).toEqual([x])
  })

  it('a role-stamped source never moves: a sole mover leaving it takes the split path and the emptied skeleton stays put', () => {
    const { p, g, y } = overlayStack()
    const bRoll = p.tracks[1]
    expect(bRoll.role).toBe('BRoll')
    const m = applyAddLayer(p, g, bRoll.id, C, 2_000_000, 3_000_000) // sole occupant of B roll
    const ret = applyRestackLayer(p, g, m, y, 'above')
    expect(ret).not.toBe(bRoll.id)
    // the skeleton is still at index 1, emptied but NOT pruned (reserved lanes are not transient)
    expect(p.tracks[1].id).toBe(bRoll.id)
    expect(p.tracks[1].layers).toEqual([])
    expect(track(p, ret!)!.layers.map((l) => l.id)).toEqual([m])
  })

  // Positive prune wiring. In reachable states the split path can never empty a
  // PRUNABLE lane — a transient, unlocked, sole-occupant source takes the
  // track-move path, and the forced-split sources (role-stamped) are exactly
  // the ones the predicate declines. This synthetic transient-stamped role
  // track violates the `transient == (role is None)` creation invariant on
  // purpose: it proves the split path routes the emptied source through the ONE
  // prune predicate (helpers.pruneEmptiedTrack) rather than deciding for itself.
  it('prune-on-empty rides the single predicate: an emptied source the predicate accepts is removed', () => {
    const { p, g, y } = overlayStack()
    const bRoll = p.tracks[1]
    bRoll.transient = true // synthetic: forces split (role) AND satisfies the predicate
    const m = applyAddLayer(p, g, bRoll.id, C, 2_000_000, 3_000_000)
    applyRestackLayer(p, g, m, y, 'above')
    expect(track(p, bRoll.id)).toBeUndefined() // pruned by the shared predicate
  })

  it('accepts an anchor on a reserved track and places the mover directly above it', () => {
    const { p, g, washId, logoId, x } = overlayStack()
    const [aRollId, bRollId] = order(p)
    const r = applyAddLayer(p, g, aRollId, C, 0, 1_000_000) // anchor ON the A roll
    applyRestackLayer(p, g, x, r, 'above')
    expect(order(p)).toEqual([aRollId, washId, bRollId, logoId])
  })
})

describe('applyRestackLayer — no-op and typed errors', () => {
  it('restacking a layer to where it already sits returns null and leaves the project untouched', () => {
    const { p, g, x, y } = overlayStack()
    const snapshot = JSON.parse(JSON.stringify(p))
    expect(applyRestackLayer(p, g, y, x, 'above')).toBeNull() // logo already directly above wash
    expect(applyRestackLayer(p, g, x, y, 'below')).toBeNull() // wash already directly below logo
    expect(JSON.parse(JSON.stringify(p))).toEqual(snapshot)
  })

  it('a shared-track mover already at the requested side of the anchor is also a no-op (no gratuitous split)', () => {
    const { p, g, washId, x, y } = overlayStack()
    track(p, washId)!.layers.push(audioL('au', 0, 1_000_000))
    const len = p.tracks.length
    expect(applyRestackLayer(p, g, x, y, 'below')).toBeNull()
    expect(p.tracks.length).toBe(len)
  })

  it('unknown mover → LayerNotFound naming the mover', () => {
    const { p, g, y } = overlayStack()
    const e = cmdErr(() => applyRestackLayer(p, g, 'ghost', y, 'above'))
    expect(e).toEqual({ error: 'LayerNotFound', layer: 'ghost' })
  })

  it('unknown anchor → LayerNotFound naming the anchor', () => {
    const { p, g, x } = overlayStack()
    const e = cmdErr(() => applyRestackLayer(p, g, x, 'ghost-anchor', 'above'))
    expect(e).toEqual({ error: 'LayerNotFound', layer: 'ghost-anchor' })
  })

  it('mover == anchor → InvalidArgument on the anchor field', () => {
    const { p, g, x } = overlayStack()
    const e = cmdErr(() => applyRestackLayer(p, g, x, x, 'above'))
    expect(e.error).toBe('InvalidArgument')
    if (e.error === 'InvalidArgument') expect(e.field).toBe('anchor')
  })

  it('audio mover → WrongLayerKind (audio is mixed by role, never stacked)', () => {
    const { p, g, washId, y } = overlayStack()
    track(p, washId)!.layers.push(audioL('au', 0, 1_000_000))
    const e = cmdErr(() => applyRestackLayer(p, g, 'au', y, 'above'))
    expect(e).toEqual({ error: 'WrongLayerKind', layer: 'au', expected: 'visual' })
  })

  it('audio anchor → WrongLayerKind naming the anchor', () => {
    const { p, g, washId, x } = overlayStack()
    track(p, washId)!.layers.push(audioL('au', 2_000_000, 3_000_000))
    const e = cmdErr(() => applyRestackLayer(p, g, x, 'au', 'above'))
    expect(e).toEqual({ error: 'WrongLayerKind', layer: 'au', expected: 'visual' })
  })

  it('a position outside above|below → InvalidArgument on the position field', () => {
    const { p, g, x, y } = overlayStack()
    const e = cmdErr(() => applyRestackLayer(p, g, x, y, 'sideways' as never))
    expect(e.error).toBe('InvalidArgument')
    if (e.error === 'InvalidArgument') expect(e.field).toBe('position')
  })
})

// ── through the actor: one commit, own label, single undo, no-op id contract ──

/** Actor with [A, B, t2(x + co-resident audio), t3(y)] — the split-path scenario. */
function actorWithSharedStack() {
  const idGen = seededGen()
  const actor = createActor({ initial: blankProject(idGen, 't'), idGen, clock: () => '<TS>' })
  const t2 = (actor.dispatch('add_track', { label: 'wash' }) as { ok: true; value: string }).value
  const t3 = (actor.dispatch('add_track', { label: 'logo' }) as { ok: true; value: string }).value
  const x = (actor.dispatch('add_layer', { track: t2, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }) as { ok: true; value: string }).value
  const MID = '00000000-0000-7000-8000-0000000000aa'
  actor.dispatch('add_media', { id: MID, kind: 'Audio', duration_us: 5_000_000 })
  const au = (actor.dispatch('add_layer', { track: t2, kind: 'audio', media: MID, src_in_us: 0, src_out_us: 1_000_000, t_start_us: 0, t_end_us: 1_000_000 }) as { ok: true; value: string }).value
  const y = (actor.dispatch('add_layer', { track: t3, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }) as { ok: true; value: string }).value
  return { actor, t2, t3, x, au, y }
}

describe('restack_layer through the actor', () => {
  it('records ONE entry with its own history label, and a single undo restores layer, lane and source together', () => {
    const { actor, x, y } = actorWithSharedStack()
    const before = actor.snapshot()
    const lenBefore = actor.historyStatus().len
    const r = actor.dispatch('restack_layer', { layer: x, anchor: y, position: 'above' })
    expect(r.ok).toBe(true)
    expect(actor.historyStatus().len).toBe(lenBefore + 1) // exactly one commit
    const last = actor.historyView(10).ops.at(-1)!
    expect(last.label_key).toBe('history.layer.restack')
    expect(last.summary).toBe('Restacked layer')
    // the split landed: a fresh lane above the anchor's track holds x
    expect(actor.snapshot().tracks.length).toBe(before.tracks.length + 1)
    expect(actor.snapshot().tracks.at(-1)!.layers.map((l) => l.id)).toEqual([x])
    // ONE undo puts the layer back on its shared lane and drops the fresh one
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.snapshot()).toEqual(before)
  })

  it('names the mover and its destination lane in the entry`s affected refs', () => {
    const { actor, x, y } = actorWithSharedStack()
    actor.dispatch('restack_layer', { layer: x, anchor: y, position: 'above' })
    const last = actor.historyView(10).ops.at(-1)!
    const dest = actor.snapshot().tracks.at(-1)!.id
    expect(last.affected).toEqual([{ kind: 'Layer', id: x }, { kind: 'Track', id: dest }])
  })

  it('single undo of a sole-occupant restack restores the track order (and its identity)', () => {
    const idGen = seededGen()
    const actor = createActor({ initial: blankProject(idGen, 't'), idGen, clock: () => '<TS>' })
    const t2 = (actor.dispatch('add_track', { label: 'wash' }) as { ok: true; value: string }).value
    const t3 = (actor.dispatch('add_track', { label: 'logo' }) as { ok: true; value: string }).value
    const x = (actor.dispatch('add_layer', { track: t2, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }) as { ok: true; value: string }).value
    const y = (actor.dispatch('add_layer', { track: t3, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }) as { ok: true; value: string }).value
    const before = actor.snapshot()
    expect(actor.dispatch('restack_layer', { layer: x, anchor: y, position: 'above' }).ok).toBe(true)
    expect(actor.snapshot().tracks.at(-1)!.id).toBe(t2) // the whole lane moved
    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.snapshot()).toEqual(before)
  })

  it('an already-in-place restack burns no op id (same contract as move_track)', () => {
    const a1 = actorWithSharedStack()
    const r = a1.actor.dispatch('restack_layer', { layer: a1.y, anchor: a1.x, position: 'above' }) // y already directly above x
    expect(r.ok).toBe(true)
    expect(a1.actor.historyView(10).ops.at(-1)!.label_key).not.toBe('history.layer.restack') // nothing recorded
    const idA = (a1.actor.dispatch('add_layer', { track: a1.t3, kind: 'color', t_start_us: 2_000_000, t_end_us: 3_000_000 }) as { ok: true; value: string }).value
    // a control actor that never issued the no-op mints the SAME next id
    const a2 = actorWithSharedStack()
    const idB = (a2.actor.dispatch('add_layer', { track: a2.t3, kind: 'color', t_start_us: 2_000_000, t_end_us: 3_000_000 }) as { ok: true; value: string }).value
    expect(idA).toBe(idB)
  })
})

describe('restack_layer over MCP', () => {
  it('moves the stack end to end with the same anchor contract', () => {
    const { actor, t2, x, y } = actorWithSharedStack()
    const r = actor.mcpCall('restack_layer', JSON.stringify({ layer_id: x, anchor_layer_id: y, position: 'above' }))
    expect(r.ok).toBe(true)
    const tracks = actor.snapshot().tracks
    expect(tracks.at(-1)!.layers.map((l) => l.id)).toEqual([x])
    expect(tracks.find((t) => t.id === t2)!.layers.map((l) => l.id)).not.toContain(x)
  })

  it('rejects a malformed position and a non-uuid layer id with invalid_params', () => {
    const { actor, x, y } = actorWithSharedStack()
    const bad = actor.mcpCall('restack_layer', JSON.stringify({ layer_id: x, anchor_layer_id: y, position: 'sideways' }))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('invalid_params')
    const badId = actor.mcpCall('restack_layer', JSON.stringify({ layer_id: 'nope', anchor_layer_id: y, position: 'above' }))
    expect(badId.ok).toBe(false)
    if (!badId.ok) expect(badId.error.code).toBe('invalid_params')
  })

  it('maps the audio-anchor refusal to invalid_params without committing', () => {
    const { actor, au, x } = actorWithSharedStack()
    const lenBefore = actor.historyStatus().len
    const r = actor.mcpCall('restack_layer', JSON.stringify({ layer_id: x, anchor_layer_id: au, position: 'above' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_params')
    expect(actor.historyStatus().len).toBe(lenBefore)
  })
})
