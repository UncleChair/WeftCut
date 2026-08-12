import { describe, it, expect } from 'vitest'
import { History } from '../history'
import { blankProject } from '../model'
import { uuidV7Gen, seededGen } from '../ids'
import { createActor } from '../actor'

describe('HistoryView checkpoints carry actor', () => {
  it('includes the checkpoint actor', () => {
    const idGen = uuidV7Gen()
    const h = new History(blankProject(idGen, 'x'), { kind: 'User' }, idGen())
    h.checkpoint('cp', { kind: 'Agent', client: 'mcp' }, idGen())
    const v = h.view(10)
    expect(v.checkpoints[0].actor).toEqual({ kind: 'Agent', client: 'mcp' })
  })
})

function twoLayers() {
  const idGen = seededGen(); const initial = blankProject(idGen, 'hv'); const track = initial.tracks[0].id
  const actor = createActor({ initial, idGen, clock: () => '<TS>' })
  const val = (r: ReturnType<typeof actor.dispatch>): string => (r as { ok: true; value: string }).value
  const l1 = val(actor.dispatch('add_layer', { track, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 }))
  const l2 = val(actor.dispatch('add_layer', { track, kind: 'color', t_start_us: 2_000_000, t_end_us: 4_000_000 }))
  actor.dispatch('update_layer', { layer: l1, patch: { label: 'Clip 01' } })
  actor.dispatch('update_layer', { layer: l2, patch: { label: 'Clip 02' } })
  return { actor, l1, l2, val }
}
const head = (actor: ReturnType<typeof createActor>) => actor.historyView(50).ops.at(-1)!

describe('HistoryView rows carry label_key + entity_labels', () => {
  it('records the summary key next to the unchanged English summary', () => {
    const { actor } = twoLayers()
    expect(head(actor)).toMatchObject({ summary: 'Updated layer', label_key: 'history.layer.update' })
    expect(actor.historyView(50).ops[0]).toMatchObject({ summary: 'Initial', label_key: 'history.initial' })
  })
  it('names the affected layer with the label the timeline shows', () => {
    const { actor } = twoLayers()
    expect(head(actor).entity_labels).toEqual([{ text: 'Clip 02' }])
  })
  // `summary` embeds the role inline for MCP; label_args carries it structurally
  // so the panel can rebuild the row in its own language.
  it('carries label_args for a templated summary, and none for a plain one', () => {
    const { actor } = twoLayers()
    actor.dispatch('set_role_gain', { role: 'music', gain_db: -3 })
    expect(head(actor)).toMatchObject({
      summary: 'Set music role gain', label_key: 'history.audio.set_role_gain', label_args: { role: 'music' },
    })
    expect(actor.historyView(50).ops[0].label_args).toBeUndefined() // Initial takes no args
  })
})

// The add-shaped ops mint their entity id INSIDE the recipe, so `affected` is
// derived from the recipe's return value (commit()'s function form).
describe('derived affected', () => {
  it('names the layer / track / marker an add op created', () => {
    const idGen = seededGen(); const initial = blankProject(idGen, 'add')
    const actor = createActor({ initial, idGen, clock: () => '<TS>' })
    const val = (r: ReturnType<typeof actor.dispatch>): string => (r as { ok: true; value: string }).value
    const trackId = val(actor.dispatch('add_track', { label: 'B-Roll' }))
    expect(head(actor)).toMatchObject({ summary: 'Added track', affected: [{ kind: 'Track', id: trackId }], entity_labels: [{ text: 'B-Roll' }] })
    const layerId = val(actor.dispatch('add_layer', { track: trackId, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }))
    expect(head(actor)).toMatchObject({ summary: 'Added layer', affected: [{ kind: 'Layer', id: layerId }] })
    expect(head(actor).entity_labels).toEqual([{ label_key: 'kinds.color' }]) // no label, no media → kind key
    const markerId = val(actor.dispatch('add_marker', { t_us: 0, label: 'Intro' }))
    expect(head(actor)).toMatchObject({ summary: 'Added marker', affected: [{ kind: 'Marker', id: markerId }], entity_labels: [{ text: 'Intro' }] })
  })
  it('names both halves of a split', () => {
    const { actor, l1 } = twoLayers()
    const r = actor.dispatch('split_layer', { layer: l1, at_t_us: 1_000_000 }) as { ok: true; value: { left: string; right: string } }
    expect(head(actor)).toMatchObject({
      summary: 'Split layer',
      affected: [{ kind: 'Layer', id: r.value.left }, { kind: 'Layer', id: r.value.right }],
    })
  })
  it('does not run the callback when the commit is rejected', () => {
    const { actor, l1 } = twoLayers()
    const lenBefore = actor.historyView(50).len
    // Off-grid split time → ValidationFailed after the recipe; no entry, no refs.
    expect(actor.dispatch('split_layer', { layer: l1, at_t_us: 99_000_000 }).ok).toBe(false)
    expect(actor.historyView(50).len).toBe(lenBefore)
  })
})

// spec § "Backfill the six empty affected arrays" — an empty `affected` means the
// row resolves no name AND selects nothing on click.
describe('affected backfill', () => {
  it('add_transition / update_transition / remove_transition name both side layers', () => {
    const { actor, l1, l2, val } = twoLayers()
    const tid = val(actor.dispatch('add_transition', { from: l1, to: l2, duration_us: 1_000_000 }))
    expect(head(actor).entity_labels).toEqual([{ text: 'Clip 01' }, { text: 'Clip 02' }])
    actor.dispatch('update_transition', { transition: tid, duration_us: 500_000 })
    expect(head(actor)).toMatchObject({ summary: 'Updated transition', entity_labels: [{ text: 'Clip 01' }, { text: 'Clip 02' }] })
    actor.dispatch('remove_transition', { transition: tid })
    expect(head(actor)).toMatchObject({ summary: 'Removed transition', entity_labels: [{ text: 'Clip 01' }, { text: 'Clip 02' }] })
  })
  it('group create / add / remove name the layers named in the call', () => {
    const { actor, l1, l2, val } = twoLayers()
    const l3 = val(actor.dispatch('add_layer', { track: actor.snapshot().tracks[0].id, kind: 'color', t_start_us: 4_000_000, t_end_us: 5_000_000 }))
    actor.dispatch('update_layer', { layer: l3, patch: { label: 'Clip 03' } })
    const gid = val(actor.dispatch('groups_create', { layers: [l1, l2] }))
    expect(head(actor)).toMatchObject({ summary: 'Created group', entity_labels: [{ text: 'Clip 01' }, { text: 'Clip 02' }] })
    actor.dispatch('groups_add_members', { group: gid, layers: [l3] })
    expect(head(actor)).toMatchObject({ summary: 'Added group members', entity_labels: [{ text: 'Clip 03' }] })
    actor.dispatch('groups_remove_members', { group: gid, layers: [l3] })
    expect(head(actor)).toMatchObject({ summary: 'Removed group members', entity_labels: [{ text: 'Clip 03' }] })
  })
  it('group rename / dissolve name the members read off the pre-mutation snapshot', () => {
    const { actor, l1, l2, val } = twoLayers()
    const gid = val(actor.dispatch('groups_create', { layers: [l1, l2] }))
    actor.dispatch('groups_rename', { group: gid, label: 'Pair' })
    expect(head(actor)).toMatchObject({ summary: 'Renamed group', entity_labels: [{ text: 'Clip 01' }, { text: 'Clip 02' }] })
    actor.dispatch('groups_dissolve', { group: gid })
    expect(head(actor)).toMatchObject({ summary: 'Dissolved group', entity_labels: [{ text: 'Clip 01' }, { text: 'Clip 02' }] })
  })
})
