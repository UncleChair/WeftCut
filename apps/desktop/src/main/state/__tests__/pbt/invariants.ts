// Independently re-derived structural invariants over the serialized wire
// project. DELIBERATELY does NOT import src/main/state/validate.ts — asserting
// against the production validator would be tautological. The rules below are a
// fresh statement of the same domain laws (ADR 0005 autofit; linear-NLE overlap;
// group well-formedness), written so a mutation that forgot to call validate, or
// two mutations that interact to break a law, surfaces here.
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

export function invDurationAutofit(p: WireProject): void {
  if (p.composition.duration_pinned) return
  let maxEnd = -1
  for (const t of p.tracks) for (const l of t.layers) if (l.t_end_us > maxEnd) maxEnd = l.t_end_us
  if (maxEnd < 0) return // no layers: autofit baseline is unconstrained here
  if (p.composition.duration_us !== maxEnd)
    fail(`unpinned duration ${p.composition.duration_us} != max layer end ${maxEnd}`)
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
  invDurationAutofit(p)
  invGroupsWellFormed(p)
}
