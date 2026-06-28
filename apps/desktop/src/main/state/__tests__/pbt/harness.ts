// Shared primitives for the state-corpus property-based test suite.
// Every fc.assert in this suite passes { seed: PBT_SEED, numRuns: PBT_RUNS }
// so CI is deterministic and Stryker can shrink runs via WEFTCUT_PBT_RUNS.
import { seededGen } from '../../ids'
import { blankProject } from '../../model'
import { createActor } from '../../actor'
import { serializeProject } from '../../serialize'
import { canonicalString } from '../../canonical'

export const PBT_SEED = 0x5747_4354 // "WGCT" — fixed; do not randomize.
export const PBT_RUNS = Number(process.env.WEFTCUT_PBT_RUNS ?? 200)

export interface WireLayer { id: string; t_start_us: number; t_end_us: number; params: { kind: string } }
export interface WireTrack { id: string; layers: WireLayer[] }
export interface WireGroup { id: string; members: string[] }
export interface WireTransition { id: string; from_layer: string; to_layer: string; duration_us: number }
export interface WireProject {
  composition: { duration_us: number; duration_pinned: boolean; fps: { num: number; den: number }; width: number; height: number }
  tracks: WireTrack[]
  groups: WireGroup[]
  transitions: WireTransition[]
}

/** Fresh blank project + actor with seeded ids (#1 A-roll, #2 B-roll, #3 project),
 *  matching the deleted replay_driver setup. Clock is constant so timestamps never
 *  perturb canonical comparison. */
export function freshActor() {
  const idGen = seededGen()
  const initial = blankProject(idGen, 'replay')
  return createActor({ initial, idGen, clock: () => '<TS>' })
}

export function aRollId(actor: ReturnType<typeof createActor>): string { return actor.snapshot().tracks[0].id }
export function bRollId(actor: ReturnType<typeof createActor>): string { return actor.snapshot().tracks[1].id }

export function wireSnapshot(actor: ReturnType<typeof createActor>): WireProject {
  return serializeProject(actor.snapshot()) as WireProject
}
export function canonicalSnapshot(actor: ReturnType<typeof createActor>): string {
  return canonicalString(serializeProject(actor.snapshot()))
}

/** Flat view of every layer with its owning track id — the unit invariants and
 *  model commands target. */
export function layerIds(p: WireProject): Array<{ id: string; track: string; kind: string; start: number; end: number }> {
  const out: Array<{ id: string; track: string; kind: string; start: number; end: number }> = []
  for (const t of p.tracks) for (const l of t.layers) out.push({ id: l.id, track: t.id, kind: l.params.kind, start: l.t_start_us, end: l.t_end_us })
  return out
}
