// apps/desktop/src/main/state/mutations/trim.ts
import type { Layer, Project, Uuid } from '../model'
import { gridForLayerKind, snapDownOnGrid, snapOnGrid, snapUpOnGrid, type Grid } from '../snap'
import { applyDurationAutofit, locateLayer, shiftLayerKeyframes } from './helpers'
import { CommandFailure } from '../errors'
import { groupSiblingsExcluding, checkGroupLock } from './groups'

export type LayerEdge = 'In' | 'Out'
const INF = Math.floor(Number.MAX_SAFE_INTEGER / 4)

export function clampSigned(d: number, min: number, max: number): number {
  if (min > max) return 0 // bounds collapsed — no movement allowed
  return Math.min(Math.max(d, min), max)
}

/** The RAW µs constraints on a trim delta. `trimEdgeWindowUs` is the bound the
 *  mutation path clamps against — it lifts these onto the composition frame grid.
 *
 *  `sourceDurationUs` is the normalized media content duration for AV layers;
 *  it caps OUT trims so `src_out_us` never extends past source content.
 *
 *  LANDMINE: every `- 1` below is a STRICT-inequality exclusion (`t_start` must
 *  land strictly before `t_end`; `src_in` strictly before `src_out`), never a
 *  minimum duration — `trimEdgeWindowUs`' inward snap is what widens each of
 *  them to a whole frame. Delete them as µs-era relics and that snap lands both
 *  edges on the same frame, i.e. a zero-length layer. */
export function trimDeltaBounds(
  layer: Layer,
  edge: LayerEdge,
  _motifMaxDurUs: number | null,
  sourceDurationUs: number | null = null,
): { min: number; max: number } {
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
    let srcMin = -INF; let srcMax = INF
    if (pa.kind === 'VideoClip' || pa.kind === 'Audio') {
      srcMin = -(pa.src_out_us - pa.src_in_us - 1)
      if (sourceDurationUs != null) srcMax = sourceDurationUs - pa.src_out_us
    }
    return { min: Math.max(timelineMin, srcMin), max: srcMax }
  }
}

/** The absolute window the trimmed edge may land in, as canonical points of the
 *  LAYER'S OWN grid — the composition frame grid for a visual kind, the 48 kHz
 *  sample lattice for Audio (spec R2-D6): `trimDeltaBounds` snapped INWARD (ceil the
 *  low end, floor the high end). Because both ends come out of that grid, a clamp
 *  can only ever persist a canonical `t_start_us` / `t_end_us` — the endpoint
 *  invariant in `docs/data-model.md` (Timeline-field alignment).
 *
 *  Inward is the load-bearing half. A source-derived bound is arbitrary µs (a
 *  media duration is not a frame boundary), so the layer gives up to one quantum of
 *  media back rather than persisting an off-grid endpoint, and the strict µs
 *  exclusions become a one-quantum minimum duration — one composition frame for
 *  visual kinds, ONE SAMPLE (~20.83 µs) for audio, which is what makes sample-level
 *  audio trims reachable at all. `hi < lo` means no legal point is left —
 *  `applyTrimLayer` reports `TrimEdgeOutOfRange` instead of committing a sub-quantum
 *  sliver. `INF` stays a sentinel: an OUT trim with no source cap has no upper bound
 *  to put on the grid. */
export function trimEdgeWindowUs(
  layer: Layer,
  edge: LayerEdge,
  grid: Grid,
  sourceDurationUs: number | null = null,
): { lo: number; hi: number } {
  const b = trimDeltaBounds(layer, edge, null, sourceDurationUs)
  const edgeT = edge === 'In' ? layer.t_start_us : layer.t_end_us
  return {
    lo: snapUpOnGrid(Math.max(0, edgeT + b.min), grid),
    hi: b.max >= INF ? INF : snapDownOnGrid(edgeT + b.max, grid),
  }
}

function sourceDurationForLayer(p: Project, layer: Layer): number | null {
  const pa = layer.params
  if (pa.kind !== 'VideoClip' && pa.kind !== 'Audio') return null
  return p.media_pool[pa.media]?.metadata.duration_us ?? null
}

/** Trim one edge. Unless `escapeGroup`, every group sibling whose matching edge
 *  sits at the same t moves with it, clamped to the tightest member's window. */
export function applyTrimLayer(p: Project, id: Uuid, edge: LayerEdge, newTUs: number, escapeGroup: boolean): void {
  const fps = p.composition.fps
  const loc = locateLayer(p, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const [ti, li] = loc
  if (p.tracks[ti].locked) throw new CommandFailure({ error: 'TrackLocked', track: p.tracks[ti].id })
  const target = p.tracks[ti].layers[li]
  const snapped = snapOnGrid(newTUs, gridForLayerKind(target.params.kind, fps))
  const curStart = target.t_start_us, curEnd = target.t_end_us
  const curEdgeT = edge === 'In' ? curStart : curEnd

  // Aligned set: the target + every group sibling whose MATCHING edge sits at the
  // same t as the target's pre-trim edge.
  const aligned: Uuid[] = [id]
  if (!escapeGroup) {
    for (const sid of groupSiblingsExcluding(p, id)) {
      const sl = locateLayer(p, sid); if (!sl) continue
      const s = p.tracks[sl[0]].layers[sl[1]]
      const sEdgeT = edge === 'In' ? s.t_start_us : s.t_end_us
      if (sEdgeT === curEdgeT) aligned.push(sid)
    }
    checkGroupLock(p, id, aligned)
  }

  const requestedDelta = snapped - curEdgeT
  if (requestedDelta === 0) return // no-op early return

  // Clamp against every aligned member: intersect their grid windows so the
  // tightest member governs. The windows are absolute times yet share one delta
  // basis because every aligned member's matching edge sits at `curEdgeT` — that
  // is what "aligned" means. Both `snapped` and every window end are canonical, so
  // whichever the clamp picks keeps the moved edge on the grid.
  let lo = -INF
  let hi = INF
  for (const mid of aligned) {
    const ml = locateLayer(p, mid)!
    const m = p.tracks[ml[0]].layers[ml[1]]
    const w = trimEdgeWindowUs(m, edge, gridForLayerKind(m.params.kind, fps), sourceDurationForLayer(p, m))
    lo = Math.max(lo, w.lo)
    hi = Math.min(hi, w.hi)
  }
  const clamped = clampSigned(requestedDelta, lo - curEdgeT, hi - curEdgeT)
  if (clamped === 0) throw new CommandFailure({ error: 'TrimEdgeOutOfRange', layer: id, new_t: snapped, cur_start: curStart, cur_end: curEnd })

  for (const mid of aligned) {
    const ml = locateLayer(p, mid)!
    const m = p.tracks[ml[0]].layers[ml[1]]
    const params = m.params
    // Re-derive the delta on each member's OWN grid. Aligned members share one
    // `curEdgeT` (that is what "aligned" means), so at the six rates where the frame
    // lattice is an exact sublattice of 48 kHz this is exactly `clamped`. It differs
    // only when a video and an audio edge coincide at 29.97 / 59.94, where the shared
    // time is a frame boundary that is NOT a sample boundary: then the audio member
    // adjusts by ≤ half a sample so its endpoint stays canonical instead of the whole
    // trim being rejected by the grid backstop. `src_*` shifts by the SAME per-member
    // delta, so content stays glued to the edge.
    const delta = snapOnGrid(curEdgeT + clamped, gridForLayerKind(params.kind, fps)) - curEdgeT
    if (edge === 'In') {
      m.t_start_us += delta
      if (params.kind === 'VideoClip' || params.kind === 'Audio') params.src_in_us += delta
      shiftLayerKeyframes(params, -delta) // keyframes glued to content
    } else {
      m.t_end_us += delta
      if (params.kind === 'VideoClip' || params.kind === 'Audio') params.src_out_us += delta
    }
  }

  // Re-sort touched tracks on IN trims (t_start changed → order may shift).
  if (edge === 'In') {
    const touched = new Set<Uuid>(aligned.map((m) => p.tracks[locateLayer(p, m)![0]].id))
    const tracksById = new Map(p.tracks.map((t) => [t.id, t]))
    for (const tid of touched) {
      const t = tracksById.get(tid)!
      t.layers.sort((x, y) => x.t_start_us - y.t_start_us)
    }
  }
  applyDurationAutofit(p)
}
