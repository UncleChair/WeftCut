// apps/desktop/src/main/state/validate.ts
import type { Layer, LayerParams, Project, Uuid } from './model'
import { ValidationFailure, type ValidationError } from './errors'

function fail(err: ValidationError): never { throw new ValidationFailure(err) }

type OverlapClass = 'visual' | 'audio'
function layerOverlapClass(params: LayerParams): OverlapClass {
  return params.kind === 'Audio' ? 'audio' : 'visual'
}
/** Canonical unordered layer-pair key for the authorized-overlap map. */
function pairKey(a: Uuid, b: Uuid): string { return a < b ? `${a}|${b}` : `${b}|${a}` }

export function validate(project: Project): void {
  validateComposition(project)
  const authorized = validateTransitions(project) // also enforces transition rules
  const seenLayers = new Set<Uuid>()
  for (const track of project.tracks) validateTrack(project, track, authorized, seenLayers)
  validateGroups(project, seenLayers)
}

function validateComposition(p: Project): void {
  const c = p.composition
  if (c.width === 0 || c.height === 0) fail({ rule: 'InvalidCanvas', width: c.width, height: c.height })
  if (c.fps.num === 0 || c.fps.den === 0) fail({ rule: 'InvalidFps', num: c.fps.num, den: c.fps.den })
}

/** Returns authorized overlaps (pairKey → overlap µs) for the per-track check. */
function validateTransitions(p: Project): Map<string, number> {
  // layer id → {track, start, end}
  const idx = new Map<Uuid, { track: Uuid; start: number; end: number }>()
  for (const t of p.tracks) for (const l of t.layers) idx.set(l.id, { track: t.id, start: l.t_start_us, end: l.t_end_us })

  const authorized = new Map<string, number>()
  const seenIds = new Set<Uuid>()
  const asFrom = new Set<Uuid>()
  const asTo = new Set<Uuid>()
  for (const tr of p.transitions) {
    if (seenIds.has(tr.id)) fail({ rule: 'DuplicateTransitionId', transition: tr.id })
    seenIds.add(tr.id)
    if (tr.from_layer === tr.to_layer) fail({ rule: 'TransitionSelfReference', transition: tr.id, layer: tr.from_layer })
    const from = idx.get(tr.from_layer) ?? fail({ rule: 'TransitionLayerMissing', transition: tr.id, layer: tr.from_layer })
    const to = idx.get(tr.to_layer) ?? fail({ rule: 'TransitionLayerMissing', transition: tr.id, layer: tr.to_layer })
    if (from.track !== to.track) fail({ rule: 'TransitionCrossTrack', transition: tr.id, from: tr.from_layer, to: tr.to_layer })
    const fromLen = Math.max(from.end - from.start, 0)
    const toLen = Math.max(to.end - to.start, 0)
    if (tr.duration_us <= 0 || tr.duration_us > fromLen || tr.duration_us > toLen)
      fail({ rule: 'TransitionDurationOutOfRange', transition: tr.id, duration: tr.duration_us })
    const overlapStart = Math.max(from.start, to.start)
    const overlapEnd = Math.min(from.end, to.end)
    const overlap = Math.max(overlapEnd - overlapStart, 0)
    if (overlap !== tr.duration_us) fail({ rule: 'TransitionDurationMismatch', transition: tr.id, duration: tr.duration_us, overlap })
    if (asFrom.has(tr.from_layer)) fail({ rule: 'LayerInMultipleTransitions', layer: tr.from_layer })
    asFrom.add(tr.from_layer)
    if (asTo.has(tr.to_layer)) fail({ rule: 'LayerInMultipleTransitions', layer: tr.to_layer })
    asTo.add(tr.to_layer)
    authorized.set(pairKey(tr.from_layer, tr.to_layer), overlap)
  }
  return authorized
}

function checkSrcRange(p: Project, layer: Uuid, media: Uuid, srcIn: number, srcOut: number): void {
  if (!(media in p.media_pool)) fail({ rule: 'MissingMedia', layer, media })
  if (srcIn < 0 || srcIn >= srcOut) fail({ rule: 'InvalidSrcRange', layer, src_in: srcIn, src_out: srcOut })
  const dur = p.media_pool[media].metadata.duration_us
  if (dur !== null && dur !== undefined && srcOut > dur)
    fail({ rule: 'SrcRangeExceedsMedia', layer, src_in: srcIn, src_out: srcOut, media_duration: dur })
}

function validateLayerParams(p: Project, layer: Layer): void {
  // Out-of-range keyframes are intentionally NOT checked (validate.rs:495-509).
  const pa = layer.params
  if (pa.kind === 'VideoClip' || pa.kind === 'Audio') checkSrcRange(p, layer.id, pa.media, pa.src_in_us, pa.src_out_us)
  else if (pa.kind === 'ImageOverlay') { if (!(pa.media in p.media_pool)) fail({ rule: 'MissingMedia', layer: layer.id, media: pa.media }) }
}

function validateTrack(p: Project, track: Project['tracks'][number], authorized: Map<string, number>, seenLayers: Set<Uuid>): void {
  const sorted = [...track.layers].sort((x, y) => x.t_start_us - y.t_start_us)
  let prevVisual: Layer | null = null
  let prevAudio: Layer | null = null
  for (const layer of sorted) {
    if (seenLayers.has(layer.id)) fail({ rule: 'DuplicateLayerId', layer: layer.id })
    seenLayers.add(layer.id)
    if (layer.t_start_us >= layer.t_end_us) fail({ rule: 'InvalidLayerRange', layer: layer.id, t_start: layer.t_start_us, t_end: layer.t_end_us })
    validateLayerParams(p, layer)
    const cls = layerOverlapClass(layer.params)
    const prev = cls === 'visual' ? prevVisual : prevAudio
    if (prev && layer.t_start_us < prev.t_end_us) {
      const overlap = prev.t_end_us - layer.t_start_us
      const allowed = authorized.get(pairKey(prev.id, layer.id)) ?? 0
      if (allowed !== overlap)
        fail({ rule: 'LayerOverlap', track: track.id, a: prev.id, a_start: prev.t_start_us, a_end: prev.t_end_us, b: layer.id, b_start: layer.t_start_us, b_end: layer.t_end_us })
    }
    // Track the longest-reaching prior layer of this class (handles a long
    // clip starting earlier than a short one — validate.rs:365-383).
    if (cls === 'visual') prevVisual = prevVisual && prevVisual.t_end_us >= layer.t_end_us ? prevVisual : layer
    else prevAudio = prevAudio && prevAudio.t_end_us >= layer.t_end_us ? prevAudio : layer
  }
}

function validateGroups(p: Project, knownLayers: Set<Uuid>): void {
  const seenIds = new Set<Uuid>()
  const layerToGroup = new Map<Uuid, Uuid>()
  for (const g of p.groups) {
    if (seenIds.has(g.id)) fail({ rule: 'DuplicateGroupId', group: g.id })
    seenIds.add(g.id)
    if (g.members.length < 2) fail({ rule: 'GroupBelowMinSize', group: g.id, members: g.members.length })
    for (const m of g.members) {
      if (!knownLayers.has(m)) fail({ rule: 'GroupMemberMissing', group: g.id, layer: m })
      const first = layerToGroup.get(m)
      if (first !== undefined) fail({ rule: 'LayerInMultipleGroups', layer: m, first, second: g.id })
      layerToGroup.set(m, g.id)
    }
  }
}
