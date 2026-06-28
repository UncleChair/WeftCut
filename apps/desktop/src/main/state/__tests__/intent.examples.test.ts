// Intent examples mined from fixtures/state-corpus/sequences/*.json.
// Each test pins the SPECIFIC invariant the hand-authored sequence was designed
// to assert — things a snapshot comparison or a generic PBT property cannot
// articulate on their own. The corpus sequences these were mined from will be
// deleted in a later task; this file preserves their encoded knowledge.
import { describe, it, expect } from 'vitest'
import type { DispatchResult } from '../actor'
import { freshActor, wireSnapshot, aRollId, bRollId } from './pbt/harness'

/** Narrow a DispatchResult to its value, failing fast if the dispatch failed.
 *  Keeps test bodies free of repetitive narrowing boilerplate. */
function okValue(r: DispatchResult): unknown {
  if (!r.ok) throw new Error(`dispatch failed: ${JSON.stringify(r.error)}`)
  return r.value
}

describe('timeline mutation intent', () => {

  // ── (a) Mined from: move-reject-overlap.json ──────────────────────────────
  it('rejects an unauthorized same-track overlap (linear-NLE invariant)', () => {
    const a = freshActor()
    const t = aRollId(a)
    const l1 = a.dispatch('add_layer', { track: t, kind: 'color', t_start_us: 0, t_end_us: 4_000_000 })
    expect(l1.ok).toBe(true)
    const l2Id = okValue(a.dispatch('add_layer', { track: t, kind: 'color', t_start_us: 5_000_000, t_end_us: 9_000_000 })) as string
    // Moving L2 to start=2_000_000 would overlap L1 [0,4s] → must be rejected.
    const moved = a.dispatch('move_layer', { layer: l2Id, to_track: t, t_start_us: 2_000_000 })
    expect(moved.ok).toBe(false)
    // State must be unmodified: both layers still at their original positions.
    const snap = wireSnapshot(a)
    const layers = snap.tracks.flatMap((tr) => tr.layers)
    expect(layers).toHaveLength(2)
    const starts = layers.map((l) => l.t_start_us).sort((x, y) => x - y)
    expect(starts).toEqual([0, 5_000_000])
  })

  // ── (b) Mined from: add-color-on-A.json + ADR 0005 ────────────────────────
  it('autofits unpinned composition duration to the last layer end (ADR 0005)', () => {
    const a = freshActor()
    const firstAdd = a.dispatch('add_layer', { track: aRollId(a), kind: 'color', t_start_us: 0, t_end_us: 2_500_000 })
    expect(firstAdd.ok).toBe(true)
    const snap = wireSnapshot(a)
    // Duration must equal the layer end, and must NOT be pinned.
    expect(snap.composition.duration_us).toBe(2_500_000)
    expect(snap.composition.duration_pinned).toBe(false)
    // Adding a shorter layer does NOT shrink duration (high-water mark).
    // It goes on B-roll: a same-track [0,1s] add on A-roll would overlap the
    // existing [0,2.5s] layer and be rejected by the linear-NLE rule, leaving
    // the duration unchanged for the WRONG reason (vacuous). On B-roll the
    // short layer is genuinely present, so the 2.5s high-water mark is exercised.
    const shortAdd = a.dispatch('add_layer', { track: bRollId(a), kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })
    expect(shortAdd.ok).toBe(true)
    expect(wireSnapshot(a).composition.duration_us).toBe(2_500_000)
  })

  // ── (c) Mined from: fit-composition-shrink.json ────────────────────────────
  it('fit_composition_to_layers clamps and unpins the composition duration', () => {
    const a = freshActor()
    const t = aRollId(a)
    a.dispatch('add_layer', { track: t, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 })
    // Manually pin duration to 9s — longer than the layers.
    a.dispatch('set_composition', { duration_us: 9_000_000 })
    expect(wireSnapshot(a).composition.duration_us).toBe(9_000_000)
    expect(wireSnapshot(a).composition.duration_pinned).toBe(true)
    // fit_composition_to_layers: unpin + shrink to layer high-water mark.
    const fit = a.dispatch('fit_composition_to_layers', {})
    expect(fit.ok).toBe(true)
    const snap = wireSnapshot(a)
    expect(snap.composition.duration_us).toBe(2_000_000)
    // After fit the duration is driven by autofit (unpinned) not a user lock.
    expect(snap.composition.duration_pinned).toBe(false)
  })

  // ── (d) Mined from: undo-move.json ────────────────────────────────────────
  it('undo precisely restores the pre-op snapshot state', () => {
    const a = freshActor()
    const t = aRollId(a)
    const lid = okValue(a.dispatch('add_layer', { track: t, kind: 'color', t_start_us: 0, t_end_us: 3_000_000 })) as string
    // Record position before the move.
    const beforeMove = wireSnapshot(a).tracks.flatMap((tr) => tr.layers).find((l) => l.id === lid)
    expect(beforeMove?.t_start_us).toBe(0)
    // Move the layer to a different position. Assert success — a silently
    // rejected move would leave t_start at 0 and make the post-undo "restored
    // to 0" assertion vacuously pass.
    const moveResult = a.dispatch('move_layer', { layer: lid, to_track: t, t_start_us: 5_000_000 })
    expect(moveResult.ok).toBe(true)
    expect(wireSnapshot(a).tracks.flatMap((tr) => tr.layers).find((l) => l.id === lid)?.t_start_us).toBe(5_000_000)
    // Undo must restore exactly.
    const undoResult = a.dispatch('undo', {})
    expect(undoResult.ok).toBe(true)
    const afterUndo = wireSnapshot(a).tracks.flatMap((tr) => tr.layers).find((l) => l.id === lid)
    expect(afterUndo?.t_start_us).toBe(0)
    expect(afterUndo?.t_end_us).toBe(3_000_000)
  })

  // ── (e-i) Mined from: group-trim-coupled.json ────────────────────────────
  // The sequence puts L1 on @A and L2 on @B in the same group, then trims
  // L1's Out edge from 8s → 5s. Because both members share the same Out-edge
  // timestamp, the coupled trim must shift BOTH to 5s.
  it('group trim shifts all aligned members by the same delta (coupled alignment)', () => {
    const a = freshActor()
    const trackA = aRollId(a)
    const trackB = bRollId(a)
    const l1Id = okValue(a.dispatch('add_layer', { track: trackA, kind: 'color', t_start_us: 0, t_end_us: 8_000_000 })) as string
    const l2Id = okValue(a.dispatch('add_layer', { track: trackB, kind: 'text', t_start_us: 0, t_end_us: 8_000_000 })) as string
    a.dispatch('groups_create', { layers: [l1Id, l2Id], label: 'sync' })
    // Trim L1's Out edge from 8s → 5s without escaping the group.
    const trimmed = a.dispatch('trim_layer', { layer: l1Id, edge: 'out', new_t_us: 5_000_000, escape_group: false })
    expect(trimmed.ok).toBe(true)
    const snap = wireSnapshot(a)
    const findLayer = (id: string) => snap.tracks.flatMap((tr) => tr.layers).find((l) => l.id === id)
    // Both members must have been trimmed to the same Out edge (5s).
    expect(findLayer(l1Id)?.t_end_us).toBe(5_000_000)
    expect(findLayer(l2Id)?.t_end_us).toBe(5_000_000)
    // Start edges are untouched.
    expect(findLayer(l1Id)?.t_start_us).toBe(0)
    expect(findLayer(l2Id)?.t_start_us).toBe(0)
  })

  // ── (e-ii) Mined from: group-locked-member-reject.json ────────────────────
  it('group move is rejected when a grouped sibling is locked', () => {
    const a = freshActor()
    const t = aRollId(a)
    const l1Id = okValue(a.dispatch('add_layer', { track: t, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 })) as string
    const l2Id = okValue(a.dispatch('add_layer', { track: t, kind: 'color', t_start_us: 2_000_000, t_end_us: 3_000_000 })) as string
    a.dispatch('groups_create', { layers: [l1Id, l2Id] })
    // Lock L2 — moving L1 within the group must now be rejected (can't drag L2).
    a.dispatch('update_layer', { layer: l2Id, patch: { locked: true } })
    const moved = a.dispatch('move_layer', { layer: l1Id, to_track: t, t_start_us: 5_000_000, escape_group: false })
    expect(moved.ok).toBe(false)
    // Both layers remain at their original positions.
    const layers = wireSnapshot(a).tracks.flatMap((tr) => tr.layers)
    expect(layers.find((l) => l.id === l1Id)?.t_start_us).toBe(0)
    expect(layers.find((l) => l.id === l2Id)?.t_start_us).toBe(2_000_000)
  })

  // ── (f) Mined from: split-inside.json ─────────────────────────────────────
  // Discovery: left half REUSES the original layer id (mutations.rs:815-874
  // / split.ts splitSingleLayer line 53: `return { left: id, right: right.id }`).
  // The original id is NOT gone — it IS the left half.
  it('split produces two contiguous, non-overlapping halves; left reuses the original id', () => {
    const a = freshActor()
    const t = aRollId(a)
    const lid = okValue(a.dispatch('add_layer', { track: t, kind: 'color', t_start_us: 0, t_end_us: 6_000_000 })) as string
    const splitResult = a.dispatch('split_layer', { layer: lid, at_t_us: 3_000_000 })
    expect(splitResult.ok).toBe(true)
    const { left, right } = okValue(splitResult) as { left: string; right: string }
    // The left half reuses the original layer id.
    expect(left).toBe(lid)
    const snap = wireSnapshot(a)
    const findLayer = (id: string) => snap.tracks.flatMap((tr) => tr.layers).find((l) => l.id === id)
    const leftL = findLayer(left)
    const rightL = findLayer(right)
    expect(leftL).toBeDefined()
    expect(rightL).toBeDefined()
    // Left: [0, 3s), Right: [3s, 6s) — contiguous with no gap or overlap.
    expect(leftL!.t_start_us).toBe(0)
    expect(leftL!.t_end_us).toBe(3_000_000)
    expect(rightL!.t_start_us).toBe(3_000_000)
    expect(rightL!.t_end_us).toBe(6_000_000)
    // Exactly two layers on the track after split.
    expect(snap.tracks.flatMap((tr) => tr.layers)).toHaveLength(2)
  })

  // ── (g) Regression: no-op trim must NOT create a phantom history entry ─────
  // Reproduces the Task 3 T3-M2 discovery: applyTrimLayer returns early when
  // requestedDelta===0, so `commit` sees an identical draft and also skips
  // recording (immer returns the same object reference → no history slot).
  // A single `undo` after a no-op trim must step past the trim directly back
  // to the add_layer, proving no phantom entry was inserted.
  it('regression: no-op trim (same-value edge) does not insert a history entry', () => {
    const a = freshActor()
    const t = aRollId(a)
    const lid = okValue(a.dispatch('add_layer', { track: t, kind: 'color', t_start_us: 0, t_end_us: 5_000_000 })) as string
    const histAfterAdd = a.historyStatus().len
    // Trim the Out edge to its CURRENT value — requestedDelta===0 → early return.
    const trimResult = a.dispatch('trim_layer', { layer: lid, edge: 'out', new_t_us: 5_000_000 })
    expect(trimResult.ok).toBe(true)
    // History length must be unchanged — no phantom entry.
    expect(a.historyStatus().len).toBe(histAfterAdd)
    // A single undo must take us all the way back to the empty project (before add).
    const undoResult = a.dispatch('undo', {})
    expect(undoResult.ok).toBe(true)
    const snapAfterUndo = wireSnapshot(a)
    const allLayers = snapAfterUndo.tracks.flatMap((tr) => tr.layers)
    expect(allLayers).toHaveLength(0) // the add_layer was undone; no trim entry to stop at
  })

})
