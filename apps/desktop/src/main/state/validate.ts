// apps/desktop/src/main/state/validate.ts
import type { Layer, LayerParams, Project, Transition, Uuid } from './model'
import { ValidationFailure, type ValidationError } from './errors'
import { frameGrid, gridForLayerKind, isCanonicalOnGrid, snapOnGrid, type Grid } from './snap'

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
  validateMarkers(project)
}

// ── Frame-grid backstop ───────────────────────────────────────────────────────
// The endpoint invariant is STRUCTURAL, not per-mutation: every mutator snaps,
// and these rules are what make "a committed project holds no off-grid timeline
// time" true even for a mutator that forgot (docs/data-model.md § Timeline-field
// alignment).
//
// Legacy off-grid data does NOT reach here: `replaceState` shares this validator
// with `project_open`, so a hard rule alone would make an already-written
// off-grid project unopenable. `parseProject` repairs on load instead, in one
// pass, so validate only ever sees canonical input.

/** The grid a layer's timeline endpoints must land on. Delegates to the ONE lookup
 *  in `snap.ts` — the mutation snaps and `serialize.ts`'s load repair ask the same
 *  function, which is what stops the three sites from disagreeing about where audio
 *  lives (spec § Two data-loss dependencies).
 *
 *  Deliberately still NOT `i >= 0`: a negative canonical time passes this predicate
 *  and is caught by `NegativeLayerStart` instead. Bounds and lattice stay separate
 *  rules because they have different fixes — folding them together would report
 *  "off grid" for a time that is exactly on it. */
const layerEndpointGrid = gridForLayerKind

/** Strip the `Grid` down to its wire shape for the error payload: `fps` carries the
 *  lattice rational, `grid` names which lattice it is. Built here rather than
 *  spreading the `Grid` so the extra field can never leak in unnoticed.
 *
 *  `snap_to` is computed HERE, at the one site that already holds the `Grid`, rather
 *  than by the MCP layer that reports it — which keeps the error self-describing for
 *  every consumer (status log, renderer, tests) and keeps the wasm-backed leaf out of
 *  `mcp-commands.ts`'s otherwise pure module graph. */
function offGridBoundary(layer: Uuid, field: 't_start_us' | 't_end_us', t: number, grid: Grid): ValidationError {
  return { rule: 'OffGridLayerBoundary', layer, field, t, fps: { num: grid.num, den: grid.den }, grid: grid.domain, snap_to: snapOnGrid(t, grid) }
}

function validateComposition(p: Project): void {
  const c = p.composition
  if (c.width === 0 || c.height === 0) fail({ rule: 'InvalidCanvas', width: c.width, height: c.height })
  if (c.fps.num === 0 || c.fps.den === 0) fail({ rule: 'InvalidFps', num: c.fps.num, den: c.fps.den })
  // The composition duration is a FRAME count even when the content reaching
  // furthest is audio on the sample lattice — `applyDurationAutofit` rounds the
  // high-water mark UP to the enclosing frame, so a sub-frame audio tail still fits
  // inside the composition rather than pushing its duration off grid.
  const compGrid = frameGrid(c.fps)
  if (!isCanonicalOnGrid(c.duration_us, compGrid))
    fail({ rule: 'OffGridTime', entity: 'Composition', id: null, field: 'duration_us', t: c.duration_us, fps: c.fps, snap_to: snapOnGrid(c.duration_us, compGrid) })
}

/** Marker times are on the composition grid (`snapMarkerTimes` is the mutation
 *  side). Checked last so this rule never pre-empts an existing structural one. */
function validateMarkers(p: Project): void {
  const grid = frameGrid(p.composition.fps)
  for (const m of p.markers) {
    if (!isCanonicalOnGrid(m.t_us, grid))
      fail({ rule: 'OffGridTime', entity: 'Marker', id: m.id, field: 't_us', t: m.t_us, fps: p.composition.fps, snap_to: snapOnGrid(m.t_us, grid) })
    if (m.end_t_us !== null && m.end_t_us !== undefined && !isCanonicalOnGrid(m.end_t_us, grid))
      fail({ rule: 'OffGridTime', entity: 'Marker', id: m.id, field: 'end_t_us', t: m.end_t_us, fps: p.composition.fps, snap_to: snapOnGrid(m.end_t_us, grid) })
  }
}

// ── Per-transition invariant — ONE predicate, TWO callers ─────────────────────
// validateTransitions fails on it; reconcileTransitions drops on it. Keeping the
// logic in a single function is the design's anti-drift guarantee (Policy B,
// ADR 0035 § Ordinary edits reconcile transitions on commit): validate and
// reconcile can never disagree about what a healthy transition looks like.

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
  // This equality IS the transition's frame-grid rule, and there is deliberately
  // no `isCanonicalOn(tr.duration_us)` beside it: a duration is a DISTANCE
  // between two canonical boundaries, and at fractional rates a distance is not
  // itself a canonical time (a 1-frame transition at 30000/1001 is 33_367 µs at
  // cut frame 0 and 33_366 µs at cut frame 1). Both participants' endpoints are
  // grid-checked below, so overlap === duration_us already forces the duration to
  // be a whole number of frames — asserting canonicality on top would be false at
  // every fractional rate.
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
  // Out-of-range keyframes are intentionally NOT checked.
  // Neither are OFF-GRID keyframe times, and for a sharper reason: content-glued
  // rebases (`trim.ts` shiftLayerKeyframes, `split.ts` shiftKeyframes) move keys by
  // a DELTA, and the difference of two canonical times is not canonical at
  // fractional rates. Re-snapping to satisfy a rule here would run
  // `normalizeKeyframes`' dedupe-last-wins over the shifted set and SILENTLY MERGE
  // two keys that landed on one frame — authored data lost. The visible cost of
  // leaving it is a ≤ half-frame offset on an interpolated value.
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
    // Bounds BEFORE lattice: a negative start is usually also off-grid, and
    // "off grid" is the less actionable of the two reports (the caller's mistake was
    // the sign, not the quantum). `t_end` needs no companion rule — start >= 0 and
    // start < end together force it positive.
    if (layer.t_start_us < 0) fail({ rule: 'NegativeLayerStart', layer: layer.id, t_start: layer.t_start_us })
    const grid = layerEndpointGrid(layer.params.kind, p.composition.fps)
    if (!isCanonicalOnGrid(layer.t_start_us, grid))
      fail(offGridBoundary(layer.id, 't_start_us', layer.t_start_us, grid))
    if (!isCanonicalOnGrid(layer.t_end_us, grid))
      fail(offGridBoundary(layer.id, 't_end_us', layer.t_end_us, grid))
    validateLayerParams(p, layer)
    const cls = layerOverlapClass(layer.params)
    const prev = cls === 'visual' ? prevVisual : prevAudio
    // Half-open `[t_start, t_end)`, which is what makes this correct at the audio
    // lattice's 20.83 µs quantum for free: two audio layers whose edges differ by
    // ONE SAMPLE do not overlap, and abutting ones (start === prev end) do not
    // either. No sample-aware special case is wanted here — a tolerance would be
    // the bug, not the fix.
    if (prev && layer.t_start_us < prev.t_end_us) {
      const overlap = prev.t_end_us - layer.t_start_us
      const allowed = authorized.get(pairKey(prev.id, layer.id)) ?? 0
      if (allowed !== overlap)
        fail({ rule: 'LayerOverlap', track: track.id, a: prev.id, a_start: prev.t_start_us, a_end: prev.t_end_us, b: layer.id, b_start: layer.t_start_us, b_end: layer.t_end_us })
    }
    // Track the longest-reaching prior layer of this class (handles a long
    // clip starting earlier than a short one).
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
