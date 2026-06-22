// apps/desktop/src/main/state/mutations/trim.ts
import type { Layer, Project, Uuid } from '../model'
import { snapFrameRound } from '../snap'
import { applyDurationAutofit, locateLayer, shiftLayerKeyframes } from './helpers'
import { CommandFailure } from '../errors'

export type LayerEdge = 'In' | 'Out'
const INF = Math.floor(Number.MAX_SAFE_INTEGER / 4)

export function clampSigned(d: number, min: number, max: number): number {
  if (min > max) return 0 // bounds collapsed — no movement allowed
  return Math.min(Math.max(d, min), max)
}

/** mutations.rs:1121-1222. motifMaxDurUs is null for all Phase-1 kinds → the
 *  motif-cap branches collapse to ±INF; only timeline + src bounds remain. */
export function trimDeltaBounds(layer: Layer, edge: LayerEdge, _motifMaxDurUs: number | null): { min: number; max: number } {
  const dur = layer.t_end_us - layer.t_start_us
  const pa = layer.params
  if (edge === 'In') {
    const timelineMin = -layer.t_start_us
    const timelineMax = dur - 1
    let srcMin = -INF, srcMax = INF
    if (pa.kind === 'VideoClip' || pa.kind === 'Audio') { srcMin = -pa.src_in_us; srcMax = pa.src_out_us - pa.src_in_us - 1 }
    return { min: Math.max(timelineMin, srcMin), max: Math.min(timelineMax, srcMax) }
  } else {
    const timelineMin = -(dur - 1)
    let srcMin = -INF; const srcMax = INF
    if (pa.kind === 'VideoClip' || pa.kind === 'Audio') srcMin = -(pa.src_out_us - pa.src_in_us - 1)
    return { min: Math.max(timelineMin, srcMin), max: srcMax }
  }
}

/** Port of mutations.rs:881-1062 (Phase-1 scope: aligned = [id], no motif cap). */
export function applyTrimLayer(p: Project, id: Uuid, edge: LayerEdge, newTUs: number, escapeGroup: boolean): void {
  const fpsN = p.composition.fps.num, fpsD = p.composition.fps.den
  const snapped = snapFrameRound(newTUs, fpsN, fpsD)
  const loc = locateLayer(p, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const [ti, li] = loc
  if (p.tracks[ti].locked) throw new CommandFailure({ error: 'TrackLocked', track: p.tracks[ti].id })
  const target = p.tracks[ti].layers[li]
  const curStart = target.t_start_us, curEnd = target.t_end_us
  const curEdgeT = edge === 'In' ? curStart : curEnd

  // Aligned set: just the target in Phase 1 (groups deferred). escapeGroup is a no-op here.
  const aligned: Uuid[] = [id]
  void escapeGroup

  const requestedDelta = snapped - curEdgeT
  if (requestedDelta === 0) return // no-op early return (mutations.rs:931-933)

  // Clamp against every aligned member (just the target in P1).
  let clamped = requestedDelta
  for (const mid of aligned) {
    const ml = locateLayer(p, mid)!
    const m = p.tracks[ml[0]].layers[ml[1]]
    const b = trimDeltaBounds(m, edge, null)
    clamped = clampSigned(clamped, b.min, b.max)
  }
  if (clamped === 0) throw new CommandFailure({ error: 'TrimEdgeOutOfRange', layer: id, new_t: snapped, cur_start: curStart, cur_end: curEnd })

  for (const mid of aligned) {
    const ml = locateLayer(p, mid)!
    const m = p.tracks[ml[0]].layers[ml[1]]
    if (edge === 'In') {
      m.t_start_us += clamped
      if (m.params.kind === 'VideoClip' || m.params.kind === 'Audio') m.params.src_in_us += clamped
      shiftLayerKeyframes(m.params, -clamped) // keyframes glued to content
    } else {
      m.t_end_us += clamped
      if (m.params.kind === 'VideoClip' || m.params.kind === 'Audio') m.params.src_out_us += clamped
    }
  }

  // Re-sort touched tracks on IN trims (t_start changed → order may shift).
  if (edge === 'In') {
    const touched = new Set<Uuid>(aligned.map((m) => p.tracks[locateLayer(p, m)![0]].id))
    for (const tid of touched) {
      const t = p.tracks.find((x) => x.id === tid)!
      t.layers.sort((x, y) => x.t_start_us - y.t_start_us)
    }
  }
  applyDurationAutofit(p)
}
