// Independently re-derived structural invariants over the serialized wire
// project. DELIBERATELY does NOT import src/main/state/validate.ts — asserting
// against the production validator would be tautological. The rules below are a
// fresh statement of the same domain laws (linear-NLE overlap; group
// well-formedness), written so a mutation that forgot to call validate, or two
// mutations that interact to break a law, surfaces here. Duration-autofit is
// deliberately NOT here — it is per-operation behavior, not a state invariant
// (see checkAllInvariants).
import type { WireProject, WireLayer } from './harness'

export class InvariantError extends Error {}
function fail(msg: string): never { throw new InvariantError(msg) }

function overlapClass(kind: string): 'audio' | 'visual' { return kind === 'Audio' ? 'audio' : 'visual' }
function pairKey(a: string, b: string): string { return a < b ? `${a}|${b}` : `${b}|${a}` }

export function invUniqueLayerIds(p: WireProject): void {
  const seen = new Set<string>()
  for (const t of p.tracks) for (const l of t.layers) {
    if (seen.has(l.id)) fail(`duplicate layer id ${l.id}`)
    seen.add(l.id)
  }
}

export function invLayerRanges(p: WireProject): void {
  for (const t of p.tracks) for (const l of t.layers)
    if (l.t_start_us >= l.t_end_us) fail(`layer ${l.id} has empty/inverted range [${l.t_start_us}, ${l.t_end_us})`)
}

export function invNoUnauthorizedOverlap(p: WireProject): void {
  // Authorized overlap per layer-pair = the geometric overlap of the two
  // transition-linked layers (independently recomputed, not read from validate).
  const idx = new Map<string, WireLayer>()
  for (const t of p.tracks) for (const l of t.layers) idx.set(l.id, l)
  const authorized = new Map<string, number>()
  for (const tr of p.transitions) {
    const a = idx.get(tr.from_layer), b = idx.get(tr.to_layer)
    if (!a || !b) continue
    authorized.set(pairKey(tr.from_layer, tr.to_layer), Math.max(Math.min(a.t_end_us, b.t_end_us) - Math.max(a.t_start_us, b.t_start_us), 0))
  }
  for (const t of p.tracks) {
    for (const cls of ['visual', 'audio'] as const) {
      const lane = t.layers.filter((l) => overlapClass(l.params.kind) === cls).sort((x, y) => x.t_start_us - y.t_start_us)
      // Track the longest-reaching prior layer (a long clip can start before a
      // short one yet still overlap a later layer).
      let prev: WireLayer | null = null
      for (const l of lane) {
        if (prev && l.t_start_us < prev.t_end_us) {
          const overlap = prev.t_end_us - l.t_start_us
          if ((authorized.get(pairKey(prev.id, l.id)) ?? 0) !== overlap)
            fail(`unauthorized ${cls} overlap on track ${t.id}: ${prev.id} & ${l.id} (${overlap}µs)`)
        }
        prev = prev && prev.t_end_us >= l.t_end_us ? prev : l
      }
    }
  }
}

const TRANSITION_DIRECTIONS = new Set(['left', 'right', 'up', 'down'])

/** Independently re-derived transition laws (linear-NLE authorized overlap;
 *  Policy B). reconcileTransitions runs inside EVERY commit, so no command
 *  sequence — however hostile — may leave a surviving transition violating
 *  any of these. Fresh statement of the domain rules, NOT a validate.ts import. */
export function invTransitionsWellFormed(p: WireProject): void {
  const loc = new Map<string, { track: string; layer: WireLayer }>()
  for (const t of p.tracks) for (const l of t.layers) loc.set(l.id, { track: t.id, layer: l })
  const seen = new Set<string>()
  const asFrom = new Set<string>(), asTo = new Set<string>()
  for (const tr of p.transitions) {
    if (seen.has(tr.id)) fail(`duplicate transition id ${tr.id}`)
    seen.add(tr.id)
    if (tr.from_layer === tr.to_layer) fail(`transition ${tr.id} is self-referencing (${tr.from_layer})`)
    const from = loc.get(tr.from_layer)
    if (!from) fail(`transition ${tr.id} references missing from_layer ${tr.from_layer}`)
    const to = loc.get(tr.to_layer)
    if (!to) fail(`transition ${tr.id} references missing to_layer ${tr.to_layer}`)
    if (from.track !== to.track) fail(`transition ${tr.id} spans tracks (${from.track} → ${to.track})`)
    // Visual participants only — audio crossfade is a named fast-follow.
    if (overlapClass(from.layer.params.kind) !== 'visual') fail(`transition ${tr.id} has audio from_layer ${tr.from_layer}`)
    if (overlapClass(to.layer.params.kind) !== 'visual') fail(`transition ${tr.id} has audio to_layer ${tr.to_layer}`)
    const fromLen = from.layer.t_end_us - from.layer.t_start_us
    const toLen = to.layer.t_end_us - to.layer.t_start_us
    if (tr.duration_us <= 0 || tr.duration_us > fromLen || tr.duration_us > toLen)
      fail(`transition ${tr.id} duration ${tr.duration_us}µs out of range (fromLen ${fromLen}µs, toLen ${toLen}µs)`)
    const overlap = Math.min(from.layer.t_end_us, to.layer.t_end_us) - Math.max(from.layer.t_start_us, to.layer.t_start_us)
    if (overlap !== tr.duration_us) fail(`transition ${tr.id} duration ${tr.duration_us}µs !== geometric overlap ${overlap}µs`)
    // Borrowed-tail provenance stays inside the window: a counter outside
    // [0, duration] would make remove return material the transition never
    // borrowed (or move the incoming layer left instead of right).
    if (!(tr.extended_us >= 0 && tr.extended_us <= tr.duration_us))
      fail(`transition ${tr.id} extended_us ${tr.extended_us}µs outside [0, ${tr.duration_us}]`)
    if (asFrom.has(tr.from_layer)) fail(`layer ${tr.from_layer} is from_layer in two transitions`)
    asFrom.add(tr.from_layer)
    if (asTo.has(tr.to_layer)) fail(`layer ${tr.to_layer} is to_layer in two transitions`)
    asTo.add(tr.to_layer)
    // Kind union shape (spec § Data model): direction rides INSIDE kind,
    // present iff the kind is directional.
    if (tr.kind.kind === 'Crossfade') {
      if (tr.kind.direction !== undefined) fail(`transition ${tr.id} is Crossfade but carries direction '${tr.kind.direction}'`)
    } else if (tr.kind.kind === 'Wipe' || tr.kind.kind === 'Slide') {
      if (tr.kind.direction === undefined || !TRANSITION_DIRECTIONS.has(tr.kind.direction))
        fail(`transition ${tr.id} is ${tr.kind.kind} with invalid direction '${String(tr.kind.direction)}'`)
    } else fail(`transition ${tr.id} has unknown kind '${tr.kind.kind}'`)
  }
}

export function invGroupsWellFormed(p: WireProject): void {
  const known = new Set<string>()
  for (const t of p.tracks) for (const l of t.layers) known.add(l.id)
  const seenG = new Set<string>(), member = new Map<string, string>()
  for (const g of p.groups) {
    if (seenG.has(g.id)) fail(`duplicate group id ${g.id}`)
    seenG.add(g.id)
    if (g.members.length < 2) fail(`group ${g.id} below min size (${g.members.length})`)
    for (const m of g.members) {
      if (!known.has(m)) fail(`group ${g.id} references missing layer ${m}`)
      const first = member.get(m)
      if (first) fail(`layer ${m} in two groups (${first}, ${g.id})`)
      member.set(m, g.id)
    }
  }
}

export function checkAllInvariants(p: WireProject): void {
  invUniqueLayerIds(p)
  invLayerRanges(p)
  invNoUnauthorizedOverlap(p)
  invTransitionsWellFormed(p)
  // NOTE: duration-autofit is a per-operation behavior (add/move/trim/delete/fit
  // autofit; update_layer intentionally does NOT), NOT a universal state invariant
  // — so it is not checked here. See the update_layer intent example in
  // intent.examples.test.ts.
  invGroupsWellFormed(p)
}
