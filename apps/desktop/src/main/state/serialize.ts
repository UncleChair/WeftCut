import { SCHEMA_VERSION, defaultSettings, type Group, type Project } from './model'
import { snapFrameCeil, snapFrameRound } from './snap'

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

/** One field the load pass pulled back onto the composition frame grid. */
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
   *  rather than mysterious. Defaults to a `console.warn` one-liner; pass a
   *  status-log emitter to route it to the LogBus, or a no-op to silence it. */
  onGridRepair?: (repairs: readonly GridRepair[]) => void
}

function warnGridRepair(repairs: readonly GridRepair[]): void {
  console.warn(
    `[grid-repair] snapped ${repairs.length} off-grid timeline field(s) to the composition frame grid on load: ` +
    repairs.map((r) => `${r.entity}${r.id ? `(${r.id})` : ''}.${r.field} ${r.from}→${r.to}`).join(', '),
  )
}

/** Pull every grid-bound timeline field of a WIRE project onto the composition
 *  frame grid, in place, reporting what moved.
 *
 *  THE reason this is a load-time repair and not a validation rule: `replaceState`
 *  runs the mutation validator, and `project_open` goes through `replaceState`, so
 *  a hard off-grid rule alone would make every project that already holds an
 *  off-grid endpoint — written by a historical `set_composition { fps }`, or by a
 *  trim clamped against an arbitrary media duration — refuse to OPEN. Repair on
 *  load, reject on edit (spec D4).
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

  const repairs: GridRepair[] = []
  /** Snap `holder[field]`, recording the move. Returns the value now in place, or
   *  null when the field is absent/non-numeric (validate owns that shape). */
  const snapField = (entity: GridRepair['entity'], id: string | null, holder: Record<string, unknown>, field: string): number | null => {
    const cur = holder[field]
    if (typeof cur !== 'number' || !Number.isFinite(cur)) return null
    const next = snapFrameRound(cur, num, den)
    if (next !== cur) { holder[field] = next; repairs.push({ entity, id, field, from: cur, to: next }) }
    return next
  }
  /** Push an end that the snap collapsed onto its own start out to the next frame
   *  boundary, so the repair itself can never manufacture an `InvalidLayerRange` /
   *  zero-span region out of a legacy sub-frame entity. */
  const widenToOneFrame = (entity: GridRepair['entity'], id: string | null, holder: Record<string, unknown>, field: string, startUs: number): number => {
    const cur = holder[field] as number
    const next = snapFrameCeil(startUs + 1, num, den)
    holder[field] = next
    repairs.push({ entity, id, field, from: cur, to: next })
    return next
  }

  // Layer endpoints first: transition durations are re-derived from the repaired
  // geometry below, so they must read the final values.
  const geometry = new Map<string, { start: number; end: number }>()
  for (const track of (o.tracks as Array<{ layers?: unknown }> | undefined) ?? []) {
    for (const layer of (track?.layers as Array<Record<string, unknown>> | undefined) ?? []) {
      if (layer === null || typeof layer !== 'object') continue
      const id = typeof layer.id === 'string' ? layer.id : null
      const start = snapField('Layer', id, layer, 't_start_us')
      let end = snapField('Layer', id, layer, 't_end_us')
      if (start !== null && end !== null && end <= start) end = widenToOneFrame('Layer', id, layer, 't_end_us', start)
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

  snapField('Composition', null, comp, 'duration_us')

  // Markers stay sorted: `snapFrameRound` is monotonic, so a snapped `t_us` never
  // crosses its neighbours.
  for (const m of (o.markers as Array<Record<string, unknown>> | undefined) ?? []) {
    if (m === null || typeof m !== 'object') continue
    const id = typeof m.id === 'string' ? m.id : null
    const t = snapField('Marker', id, m, 't_us')
    const end = snapField('Marker', id, m, 'end_t_us')
    if (t !== null && end !== null && end <= t) widenToOneFrame('Marker', id, m, 'end_t_us', t)
  }

  return repairs
}

/** Validate + type a wire object as a Project. The load guard is the schema
 *  version (project.rs:17-22 rejects others); beyond that, a shallow structural
 *  check rejects a truncated/corrupt project.json (right version, missing/wrong
 *  required fields) with a clear error rather than letting `undefined` reach the
 *  actor. Shallow by design — field-level fidelity is proven by the differential
 *  + round-trip gates, and an undeclared NEW Rust field is carried through by the
 *  spread (acceptable; it can only be lost on the next save, never corrupts). */
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
  // Top-level shape of Project (model.ts:98-102). Shallow presence/kind only.
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
  // Rust's #[serde(default)] used to backfill them on load; the TS parse path must
  // do the same, or a consumer that reads a field as non-optional (e.g.
  // get_project_settings → the renderer proxy store) hands `undefined` downstream
  // and a `settings.proxy_overrides[id]` read throws mid-render. Existing keys win.
  o.settings = { ...defaultSettings(), ...(o.settings as Record<string, unknown>) }
  // Grid repair belongs in THIS pass, beside the additive-field backfill above:
  // one normalize site, so the validator that `replaceState` shares with
  // `project_open` only ever sees already-canonical input. A second repair site is
  // how blank-screen-on-open bugs happen here.
  const repairs = repairGrid(o)
  if (repairs.length > 0) (opts.onGridRepair ?? warnGridRepair)(repairs)
  return json as Project
}
