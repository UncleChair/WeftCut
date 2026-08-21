import { SCHEMA_VERSION, defaultSettings, type Animated, type Group, type Project } from './model'
import { frameGrid, gridForLayerKind, snapOnGrid, snapUpOnGrid, type Grid } from './snap'
import { scaleTracksTwins } from './mutations/scaleLink'

function serializeGroup(g: Group): unknown {
  const out: Record<string, unknown> = { id: g.id, members: [...g.members].sort() }
  if (g.label !== undefined && g.label !== null) out.label = g.label // skip_serializing_if = None
  return out
}

/** Produce the on-disk/wire JSON shape. The model is already JSON-native, so
 *  this is mostly identity; the only non-identity rules are group member
 *  sorting and the `Group.label` omission (mirrors serde skip_serializing_if). */
export function serializeProject(p: Project): unknown {
  return { ...p, groups: p.groups.map(serializeGroup) }
}

/** One timeline field the load pass had to move: onto its own lattice (the
 *  composition frame grid, or the 48 kHz sample lattice for audio), or up to 0. */
export interface GridRepair {
  entity: 'Layer' | 'Composition' | 'Marker' | 'Transition'
  /** Entity id, or null for the composition (a singleton). */
  id: string | null
  field: string
  from: number
  to: number
}

export interface ParseProjectOptions {
  /** Called once, with every field the grid repair changed, when the load pass
   *  actually repaired something — so a silently-migrated project is visible
   *  rather than mysterious. Defaults to a `console.warn` one-liner; the live host
   *  passes an emitter that turns it into a LogBus row (see
   *  `workspace-orchestrator.ts`, which must CAPTURE these and emit only after
   *  `commitWorkspace` has rotated the per-workspace bus), or a no-op to silence it. */
  onGridRepair?: (repairs: readonly GridRepair[]) => void
}

/** Human summary of a repair set — shared by the console default and the LogBus row
 *  so the two can never describe the same migration differently. */
export function describeGridRepairs(repairs: readonly GridRepair[]): string {
  return repairs.map((r) => `${r.entity}${r.id ? `(${r.id})` : ''}.${r.field} ${r.from}→${r.to}`).join(', ')
}

function warnGridRepair(repairs: readonly GridRepair[]): void {
  console.warn(`[grid-repair] repaired ${repairs.length} timeline field(s) on load: ${describeGridRepairs(repairs)}`)
}

/** Pull every grid-bound timeline field of a WIRE project onto its own grid, in
 *  place, reporting what moved.
 *
 *  THE reason this is a load-time repair and not a validation rule: `replaceState`
 *  runs the mutation validator, and `project_open` goes through `replaceState`, so
 *  a hard off-grid rule alone would make every project that already holds an
 *  off-grid endpoint — written by a historical `set_composition { fps }`, or by a
 *  trim clamped against an arbitrary media duration — refuse to OPEN. Repair on
 *  load, reject on edit (spec D4).
 *
 *  KIND-KEYED, and that is load-bearing (spec § Two data-loss dependencies, #2):
 *  it asks the same `gridForLayerKind` the mutators and validate ask, so an Audio
 *  layer is repaired onto the 48 kHz lattice. A kind-BLIND version would snap
 *  sample-aligned audio back onto the composition frame grid on EVERY open,
 *  destroying every sync offset the user authored — silently, since a repair that
 *  "succeeds" looks like a no-op. It runs on the wire shape, so it reads
 *  `layer.params.kind` defensively rather than a typed union.
 *
 *  Idempotent by construction: every write is a snap, and a snapped value snaps to
 *  itself, so a repaired project that is saved and reopened reports nothing.
 *
 *  Wire-shaped and defensive (`typeof === 'number'`) because it runs BEFORE the
 *  cast to `Project`: a corrupt field is left for validate to reject with its own
 *  structured error rather than being coerced here. */
function repairGrid(o: Record<string, unknown>): GridRepair[] {
  const comp = o.composition as Record<string, unknown> | undefined
  const fps = comp?.fps as { num?: unknown; den?: unknown } | undefined
  const num = fps?.num
  const den = fps?.den
  // A degenerate rate has no grid to snap to; `InvalidFps` is the right report.
  if (comp === undefined || typeof num !== 'number' || typeof den !== 'number' || num <= 0 || den <= 0) return []
  const compGrid = frameGrid({ num, den })

  const repairs: GridRepair[] = []
  /** Snap `holder[field]` onto `grid`, recording the move. Returns the value now in
   *  place, or null when the field is absent/non-numeric (validate owns that shape). */
  const snapField = (entity: GridRepair['entity'], id: string | null, holder: Record<string, unknown>, field: string, grid: Grid): number | null => {
    const cur = holder[field]
    if (typeof cur !== 'number' || !Number.isFinite(cur)) return null
    const next = snapOnGrid(cur, grid)
    if (next !== cur) { holder[field] = next; repairs.push({ entity, id, field, from: cur, to: next }) }
    return next
  }
  /** Bring a layer that starts before zero back into representable time — the other
   *  half of the `NegativeLayerStart` rule (repair on load, reject on edit). A
   *  negative start is a BOUNDS defect, not a grid one (`-1_000_000` is frame -30 at
   *  30 fps, perfectly canonical), and it is what `move_layer` wrote before the delta
   *  clamp landed, so projects holding one exist and must still open.
   *
   *  Two cases, split because they carry different COLLISION risk — and a repair that
   *  manufactures a `LayerOverlap` is a project that will not open, the exact failure
   *  repair-on-load exists to prevent:
   *
   *  PARTIALLY negative (`start < 0 < end`) → lift the start to 0. Provably safe:
   *  `[0, end)` is a subset of the span the layer already occupied without
   *  overlapping anything, so it can collide with nothing. At most one layer per
   *  track can even be in this state — two disjoint spans cannot both straddle zero.
   *
   *  ENTIRELY negative (`end <= 0`) → shift the whole layer, duration intact, to past
   *  everything else on its track. Lifting its start would collapse it onto
   *  `[0, one quantum)`, and that CAN collide with whatever the track already holds
   *  at the head. Parking is collision-free by construction, and it beats dropping
   *  the layer because a drop cascades into `GroupMemberMissing` /
   *  `TransitionLayerMissing`. The layer never occupied a renderable microsecond
   *  either way; parked, it is at least visible and movable.
   *
   *  Runs BEFORE the snap, and writes already-snapped values, so one broken field
   *  reports one repair row and the snap that follows is the identity. Returns the
   *  next free park position so two parked layers do not stack. */
  const repairNegativeStart = (id: string | null, layer: Record<string, unknown>, grid: Grid, parkAt: number): number => {
    const start = layer.t_start_us
    if (typeof start !== 'number' || !Number.isFinite(start) || start >= 0) return parkAt
    const end = layer.t_end_us
    if (typeof end === 'number' && Number.isFinite(end) && end <= 0) {
      const at = snapUpOnGrid(parkAt, grid)
      const movedEnd = snapOnGrid(at + (end - start), grid)
      layer.t_start_us = at
      layer.t_end_us = movedEnd
      repairs.push({ entity: 'Layer', id, field: 't_start_us', from: start, to: at })
      repairs.push({ entity: 'Layer', id, field: 't_end_us', from: end, to: movedEnd })
      return movedEnd
    }
    layer.t_start_us = 0
    repairs.push({ entity: 'Layer', id, field: 't_start_us', from: start, to: 0 })
    return parkAt
  }
  /** Push an end that the snap collapsed onto its own start out to the next lattice
   *  point, so the repair itself can never manufacture an `InvalidLayerRange` /
   *  zero-span region out of a legacy sub-quantum entity. */
  const widenToOneQuantum = (entity: GridRepair['entity'], id: string | null, holder: Record<string, unknown>, field: string, startUs: number, grid: Grid): number => {
    const cur = holder[field] as number
    const next = snapUpOnGrid(startUs + 1, grid)
    holder[field] = next
    repairs.push({ entity, id, field, from: cur, to: next })
    return next
  }

  // Layer endpoints first: transition durations are re-derived from the repaired
  // geometry below, so they must read the final values.
  const geometry = new Map<string, { start: number; end: number }>()
  for (const track of (o.tracks as Array<{ layers?: unknown }> | undefined) ?? []) {
    const layers = (track?.layers as Array<Record<string, unknown>> | undefined) ?? []
    // Where an entirely-negative layer gets parked. Read from the RAW ends before any
    // repair runs, so a parked layer can never land on a live one; advanced as each is
    // placed. A negative end cannot raise it, which is what makes 0 the floor.
    let parkAt = 0
    for (const l of layers) {
      const e = l === null || typeof l !== 'object' ? null : l.t_end_us
      if (typeof e === 'number' && Number.isFinite(e) && e > parkAt) parkAt = e
    }
    for (const layer of layers) {
      if (layer === null || typeof layer !== 'object') continue
      const id = typeof layer.id === 'string' ? layer.id : null
      const kind = (layer.params as { kind?: unknown } | undefined)?.kind
      const grid = gridForLayerKind(typeof kind === 'string' ? kind : '', { num, den })
      parkAt = repairNegativeStart(id, layer, grid, parkAt)
      const start = snapField('Layer', id, layer, 't_start_us', grid)
      let end = snapField('Layer', id, layer, 't_end_us', grid)
      if (start !== null && end !== null && end <= start) end = widenToOneQuantum('Layer', id, layer, 't_end_us', start, grid)
      if (id !== null && start !== null && end !== null) geometry.set(id, { start, end })
    }
  }

  // A transition's duration is the geometric overlap of its participants, not a
  // grid time of its own (see validate.ts's TransitionDurationMismatch note), so
  // moving an endpoint by 1 µs changes what the duration must be. Re-derive it or
  // the repaired project fails to open on the mismatch rule instead.
  // A non-overlapping pair is left alone: that transition is structurally dead,
  // not off-grid, and validate/reconcile own it.
  for (const tr of (o.transitions as Array<Record<string, unknown>> | undefined) ?? []) {
    if (tr === null || typeof tr !== 'object') continue
    const from = geometry.get(tr.from_layer as string)
    const to = geometry.get(tr.to_layer as string)
    if (!from || !to || typeof tr.duration_us !== 'number') continue
    const overlap = Math.min(from.end, to.end) - Math.max(from.start, to.start)
    if (overlap > 0 && overlap !== tr.duration_us) {
      repairs.push({ entity: 'Transition', id: typeof tr.id === 'string' ? tr.id : null, field: 'duration_us', from: tr.duration_us, to: overlap })
      tr.duration_us = overlap
    }
  }

  // The composition duration is a FRAME count regardless of which kind reaches
  // furthest (validateComposition), so it snaps on the composition grid even when
  // the content that defines it is audio on the sample lattice.
  const snappedDuration = snapField('Composition', null, comp, 'duration_us', compGrid)
  // Repairing an audio endpoint can push it up to one sample PAST the stored
  // duration, so grow the duration to enclose the repaired content — the same
  // overflow guard `applyDurationAutofit` applies, and for the same reason: a
  // composition shorter than its content silently drops the tail. Grow-only, so a
  // deliberately pinned longer duration is never shortened here.
  if (snappedDuration !== null) {
    let maxEnd = 0
    for (const g of geometry.values()) if (g.end > maxEnd) maxEnd = g.end
    const needed = snapUpOnGrid(maxEnd, compGrid)
    if (needed > snappedDuration) {
      repairs.push({ entity: 'Composition', id: null, field: 'duration_us', from: snappedDuration, to: needed })
      comp.duration_us = needed
    }
  }

  // Markers stay sorted: the snap is monotonic, so a snapped `t_us` never crosses
  // its neighbours.
  for (const m of (o.markers as Array<Record<string, unknown>> | undefined) ?? []) {
    if (m === null || typeof m !== 'object') continue
    const id = typeof m.id === 'string' ? m.id : null
    const t = snapField('Marker', id, m, 't_us', compGrid)
    const end = snapField('Marker', id, m, 'end_t_us', compGrid)
    if (t !== null && end !== null && end <= t) widenToOneQuantum('Marker', id, m, 'end_t_us', t, compGrid)
  }

  return repairs
}

/** `Transform.scale_linked`: one DEFAULT and one REPAIR, both version-blind.
 *
 *  REPAIR — a `true` the tracks contradict is a lie the collapsed Scale UI would
 *  act on (it hides `scale_y` behind a single field), so the flag goes, not the
 *  divergence. This is the same `linked ⇒ twins` rule `enforceScaleLinkInvariant`
 *  applies to every mutation result — which does NOT run on load, so a loaded
 *  project needs it here. Only a hand-edited file can hold such a flag.
 *
 *  DEFAULT — an absent flag becomes `false`, so the UI never reads `undefined`.
 *  Deliberately NOT inferred from a twin check: "the two tracks happen to be
 *  equal" is not evidence that the user asked them to move as one, and linking is
 *  the destructive direction (it collapses one axis onto the other on the next
 *  edit). Inferring intent from data is a CONVERSION's job and would belong to a
 *  migration step, not to this pass (ADR 0047); v1 always writes the field, so
 *  absence means hand-edited, and the conservative answer is the honest one.
 *
 *  Wire-shaped and defensive like repairGrid (runs BEFORE the cast to Project):
 *  a transform missing its scale tracks is left for validate to reject; the twin
 *  predicate itself treats malformed entries as diverged. Idempotent. */
function normalizeScaleLinked(o: Record<string, unknown>): void {
  forEachWireTransform(o, (tr) => {
    if (tr.scale_linked === undefined) { tr.scale_linked = false; return }
    if (tr.scale_linked !== true) return
    if (!scaleTracksTwins(tr.scale_x as Animated<number>, tr.scale_y as Animated<number>)) tr.scale_linked = false
  })
}

/** `TextParams`' box/valign/leading fields (added WITHOUT a schema bump): absent
 *  → the Auto-width defaults. A pure default, never a repair — a stored box is
 *  authored data and is left exactly as written.
 *
 *  `undefined` and `null` are NOT interchangeable here, and that is the whole
 *  reason this walk exists: nullability alone encodes the resize mode, so
 *  `box_w !== null` means "wrap at this width". Absent passes that test too, and
 *  a renderer wrapping every line of every pre-existing text layer at width
 *  `undefined` is a blank frame where a caption used to be. See ADR 0049. */
function normalizeTextParams(o: Record<string, unknown>): void {
  forEachWireLayerParams(o, (params) => {
    if (params.kind !== 'Text') return
    if (params.box_w === undefined) params.box_w = null
    if (params.box_h === undefined) params.box_h = null
    if (params.valign === undefined) params.valign = 'Middle'
    if (params.line_height === undefined) params.line_height = 0
    if (params.letter_spacing === undefined) params.letter_spacing = 0
  })
}

/** Every layer's params object on the WIRE shape. THE definition of "what counts
 *  as a layer" for the normalize passes — both descend from here, so a second
 *  pass cannot disagree with the first about which layers it visits. */
function forEachWireLayerParams(o: Record<string, unknown>, fn: (params: Record<string, unknown>) => void): void {
  for (const track of (o.tracks as Array<{ layers?: unknown }> | undefined) ?? []) {
    for (const layer of (track?.layers as Array<Record<string, unknown>> | undefined) ?? []) {
      if (layer === null || typeof layer !== 'object') continue
      const p = layer.params
      if (p === null || typeof p !== 'object') continue
      fn(p as Record<string, unknown>)
    }
  }
}

/** Every transform object on the WIRE shape, for `normalizeScaleLinked`. */
function forEachWireTransform(o: Record<string, unknown>, fn: (transform: Record<string, unknown>) => void): void {
  forEachWireLayerParams(o, (params) => {
    const t = params.transform
    if (t === null || typeof t !== 'object') return
    fn(t as Record<string, unknown>)
  })
}

/** Validate + type a wire object as a Project, and normalize it.
 *
 *  Takes the CURRENT schema version as given: `parseProjectJson` (persistence.ts)
 *  refuses what it cannot read and runs the migration chain (migrate.ts) first,
 *  so the equality check below is a post-condition on that walk — it fires only
 *  if the chain returned something at the wrong version, or if a caller reached
 *  past the door. Which is why the version-blind pass here holds no CONVERSIONS:
 *  by the time it runs there is exactly one shape left to normalize (ADR 0047).
 *
 *  What it does normalize: DEFAULTS for additive fields, and VALIDITY REPAIRS.
 *  Beyond that a shallow structural check rejects a truncated/corrupt
 *  project.json (right version, missing/wrong required fields) with a clear error
 *  rather than letting `undefined` reach the actor. Shallow by design —
 *  field-level fidelity is proven by the round-trip gates, and an undeclared NEW
 *  field is carried through by the spread (acceptable; it can only be lost on the
 *  next save, never corrupts). */
export function parseProject(json: unknown, opts: ParseProjectOptions = {}): Project {
  if (json === null || typeof json !== 'object') throw new Error('parseProject: not an object')
  const o = json as Record<string, unknown>
  if (o.schema_version !== SCHEMA_VERSION) {
    throw new Error(`parseProject: unsupported schema_version ${String(o.schema_version)} (expected ${SCHEMA_VERSION})`)
  }
  const requireObject = (k: string) => {
    if (o[k] === null || typeof o[k] !== 'object' || Array.isArray(o[k])) throw new Error(`parseProject: ${k} must be an object`)
  }
  const requireArray = (k: string) => {
    if (!Array.isArray(o[k])) throw new Error(`parseProject: ${k} must be an array`)
  }
  const requireString = (k: string) => {
    if (typeof o[k] !== 'string') throw new Error(`parseProject: ${k} must be a string`)
  }
  // Top-level shape of Project (model.ts `Project`). Shallow presence/kind only.
  requireString('project_id')
  requireObject('metadata')
  requireObject('composition')
  requireObject('media_pool')
  requireArray('tracks')
  requireArray('markers')
  requireArray('transitions')
  requireArray('groups')
  requireObject('audio_roles')
  requireObject('settings')
  // Additive settings fields (prefer_proxies/proxy_overrides, added later WITHOUT
  // a schema bump) deserialize as absent on projects saved before they existed.
  // Backfill here, or a consumer that reads a field as non-optional (e.g.
  // get_project_settings → the renderer proxy store) hands `undefined` downstream
  // and a `settings.proxy_overrides[id]` read throws mid-render. Existing keys win.
  o.settings = { ...defaultSettings(), ...(o.settings as Record<string, unknown>) }
  // `scale_linked`: absent → false (a default), and a claimed link the tracks
  // contradict → false (a repair). Never inferred from the tracks — see the
  // function.
  normalizeScaleLinked(o)
  // Text box/valign/leading: absent → the Auto-width defaults, in THIS pass and
  // nowhere else, because absent is not the same value as null here — see the
  // function.
  normalizeTextParams(o)
  // Grid repair belongs in THIS pass, beside the additive-field default above:
  // one normalize site, so the validator that `replaceState` shares with
  // `project_open` only ever sees already-canonical input. A second repair site is
  // how blank-screen-on-open bugs happen here.
  const repairs = repairGrid(o)
  if (repairs.length > 0) (opts.onGridRepair ?? warnGridRepair)(repairs)
  // `Transition.extended_us` (added WITHOUT a schema bump): absent → the
  // transition's own duration. Exactly true for every extend-add an
  // extended_us-less build could write (its adds borrowed the outgoing tail by
  // the FULL duration); a pre-positioned add (MCP-only, layers hand-overlapped
  // first) would deserve 0, but no project containing one exists to load.
  // This is the one backfill site (docs/data-model.md § additive-field
  // backfill — one pass in one place): a second one would let
  // `replaceState` and `project_open` disagree, and a consumer reading the field
  // as required (remove/update routing) would see `undefined` and shrink NaN µs.
  // AFTER repairGrid deliberately: the repair re-derives duration_us from
  // repaired geometry, and the backfill must copy the FINAL value or a
  // shrinking repair would mint `extended_us > duration_us` — a project that
  // fails validate's structural check and refuses to open.
  for (const tr of (o.transitions as Array<Record<string, unknown>> | undefined) ?? []) {
    if (tr === null || typeof tr !== 'object') continue
    if (tr.extended_us === undefined && typeof tr.duration_us === 'number') tr.extended_us = tr.duration_us
  }
  return json as Project
}
