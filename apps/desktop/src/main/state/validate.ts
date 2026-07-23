// apps/desktop/src/main/state/validate.ts
import type { Layer, LayerParams, Project, Transition, Uuid } from './model'
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

// ── Per-transition invariant — ONE predicate, TWO callers ─────────────────────
// validateTransitions fails on it; reconcileTransitions drops on it. Keeping the
// logic in a single function is the design's anti-drift guarantee (Policy B,
// spec § Edit-interaction policy): validate and reconcile can never disagree
// about what a healthy transition looks like.

/** layer id → {track, start, end, kind} geometry snapshot for the predicate. */
type TransitionLayerIndex = Map<Uuid, { track: Uuid; start: number; end: number; kind: LayerParams['kind'] }>
function buildTransitionLayerIndex(p: Project): TransitionLayerIndex {
  const idx: TransitionLayerIndex = new Map()
  for (const t of p.tracks) for (const l of t.layers) idx.set(l.id, { track: t.id, start: l.t_start_us, end: l.t_end_us, kind: l.params.kind })
  return idx
}

/** The invariant an ordinary layer edit (trim/move/split/delete/track op) can
 *  break: participants exist, same track, visual-only, duration in range,
 *  overlap exactly equals duration. Structural corruption (duplicate transition
 *  id, self-reference, LayerInMultipleTransitions) is deliberately NOT here —
 *  no layer edit can produce those, so they stay validate-only failures; a
 *  reconcile that silently swallowed them would mask real bugs. */
function transitionInvariantError(tr: Transition, idx: TransitionLayerIndex): ValidationError | null {
  const from = idx.get(tr.from_layer)
  if (!from) return { rule: 'TransitionLayerMissing', transition: tr.id, layer: tr.from_layer }
  const to = idx.get(tr.to_layer)
  if (!to) return { rule: 'TransitionLayerMissing', transition: tr.id, layer: tr.to_layer }
  if (from.track !== to.track) return { rule: 'TransitionCrossTrack', transition: tr.id, from: tr.from_layer, to: tr.to_layer }
  // Visual participants only (audio crossfade is a named fast-follow). Backstop
  // for applyAddTransition's mutation-level check — no path sneaks in a
  // semantically dead audio transition (deserialize, replace_state, ...).
  if (from.kind === 'Audio') return { rule: 'TransitionUnsupportedLayerKind', transition: tr.id, layer: tr.from_layer }
  if (to.kind === 'Audio') return { rule: 'TransitionUnsupportedLayerKind', transition: tr.id, layer: tr.to_layer }
  const fromLen = Math.max(from.end - from.start, 0)
  const toLen = Math.max(to.end - to.start, 0)
  if (tr.duration_us <= 0 || tr.duration_us > fromLen || tr.duration_us > toLen)
    return { rule: 'TransitionDurationOutOfRange', transition: tr.id, duration: tr.duration_us }
  const overlapStart = Math.max(from.start, to.start)
  const overlapEnd = Math.min(from.end, to.end)
  const overlap = Math.max(overlapEnd - overlapStart, 0)
  if (overlap !== tr.duration_us) return { rule: 'TransitionDurationMismatch', transition: tr.id, duration: tr.duration_us, overlap }
  return null
}

/** Returns authorized overlaps (pairKey → overlap µs) for the per-track check. */
function validateTransitions(p: Project): Map<string, number> {
  const idx = buildTransitionLayerIndex(p)
  const authorized = new Map<string, number>()
  const seenIds = new Set<Uuid>()
  const asFrom = new Set<Uuid>()
  const asTo = new Set<Uuid>()
  for (const tr of p.transitions) {
    if (seenIds.has(tr.id)) fail({ rule: 'DuplicateTransitionId', transition: tr.id })
    seenIds.add(tr.id)
    if (tr.from_layer === tr.to_layer) fail({ rule: 'TransitionSelfReference', transition: tr.id, layer: tr.from_layer })
    const invariantErr = transitionInvariantError(tr, idx)
    if (invariantErr !== null) fail(invariantErr)
    if (asFrom.has(tr.from_layer)) fail({ rule: 'LayerInMultipleTransitions', layer: tr.from_layer })
    asFrom.add(tr.from_layer)
    if (asTo.has(tr.to_layer)) fail({ rule: 'LayerInMultipleTransitions', layer: tr.to_layer })
    asTo.add(tr.to_layer)
    // Predicate passed ⇒ geometric overlap === duration_us.
    authorized.set(pairKey(tr.from_layer, tr.to_layer), tr.duration_us)
  }
  return authorized
}

export interface DroppedTransition { id: Uuid; from_layer: Uuid; to_layer: Uuid; reason: ValidationError }

/** Reconcile-on-commit (Policy B): remove every transition whose invariant no
 *  longer holds. The actor runs this inside commit's produce() — AFTER the
 *  mutation apply, BEFORE validate — so ordinary edits stay transition-blind
 *  and the removal lands in the SAME history snapshot (one undo restores the
 *  edit and the transition together). Deliberately does NOT shrink the outgoing
 *  layer back: the user's edit defines the new shape (only the explicit
 *  applyRemoveTransition shrinks). Returns primitive drop info (never draft
 *  references — immer revokes them) for the actor's status-log rows. */
export function reconcileTransitions(p: Project): DroppedTransition[] {
  if (p.transitions.length === 0) return []
  const idx = buildTransitionLayerIndex(p)
  const dropped: DroppedTransition[] = []
  const kept: Transition[] = []
  for (const tr of p.transitions) {
    const reason = transitionInvariantError(tr, idx)
    if (reason === null) kept.push(tr)
    else dropped.push({ id: tr.id, from_layer: tr.from_layer, to_layer: tr.to_layer, reason })
  }
  if (dropped.length > 0) p.transitions = kept
  return dropped
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
