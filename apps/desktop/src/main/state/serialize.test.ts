import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject, SCHEMA_VERSION, type LayerParams, type Project } from './model'
import { canonicalString } from './canonical'
import { parseProject, serializeProject, type GridRepair } from './serialize'
import { serializeProjectToJson } from './persistence'
import { validate } from './validate'
import { createActor } from './actor'
import { applyAddLayer, colorParams, textParamsDefault } from './mutations/add'
import { isCommandFailure } from './errors'

describe('serialize round-trip', () => {
  it('round-trips a blank project', () => {
    const p = blankProject(seededGen(), 'test')
    const wire = serializeProject(p)
    expect(canonicalString(serializeProject(parseProject(wire)))).toBe(canonicalString(wire))
  })
  it('sorts group.members and omits a null label', () => {
    const p = blankProject(seededGen(), 'test')
    p.groups = [{ id: 'g', members: ['00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000a'] }]
    const wire = serializeProject(p) as any
    expect(wire.groups[0].members).toEqual(['00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b'])
    expect('label' in wire.groups[0]).toBe(false)
  })
  it('rejects any version but the current one, in both directions', () => {
    // parseProject sees only current-shaped input by construction: the gate and
    // the migration chain (persistence.ts → migrate.ts) run ahead of it. So this
    // check is a post-condition on that walk, not the user-facing version error —
    // which is why it stays blunt in both directions.
    expect(() => parseProject({ schema_version: SCHEMA_VERSION - 1 })).toThrow(/schema_version/)
    expect(() => parseProject({ schema_version: SCHEMA_VERSION + 1 })).toThrow(/schema_version/)
  })
})

// ── Load-time grid repair (spec D4: repair on load, reject on edit) ───────────
// `replaceState` runs the mutation validator and `project_open` goes through it,
// so a project already holding an off-grid endpoint must be REPAIRED here or it
// stops opening at all.
const RED = { r: 255, g: 0, b: 0, a: 255 }
type Wire = { tracks: Array<{ layers: Array<Record<string, unknown>> }>; transitions: Array<Record<string, unknown>>; markers: Array<Record<string, unknown>>; composition: Record<string, unknown> }

/** A saved project whose second clip starts 1 µs below frame 90 at 30/1. */
function offGridWire(): Wire {
  const g = seededGen()
  const p = blankProject(g, 'legacy')
  const track = p.tracks[0].id
  applyAddLayer(p, g, track, colorParams(RED, 16, 9), 0, 2_000_000)
  applyAddLayer(p, g, track, colorParams(RED, 16, 9), 3_000_000, 5_000_000)
  const wire = serializeProject(p) as Wire
  wire.tracks[0].layers[1].t_start_us = 2_999_999
  return wire
}
const silent = { onGridRepair: () => {} }

describe('parseProject grid repair', () => {
  it('opens a project holding t_start_us = 2_999_999, repairs it to the frame boundary, and reports it', () => {
    const wire = offGridWire()
    const layerId = wire.tracks[0].layers[1].id as string
    const reported: GridRepair[][] = []
    const project = parseProject(wire, { onGridRepair: (r) => reported.push([...r]) })
    expect(reported).toEqual([[{ entity: 'Layer', id: layerId, field: 't_start_us', from: 2_999_999, to: 3_000_000 }]])
    expect(project.tracks[0].layers[1].t_start_us).toBe(3_000_000)
    // The validator that `replaceState` shares with every mutation now accepts it.
    expect(() => validate(project)).not.toThrow()
  })

  // ── The bounds half of the same asymmetry ──────────────────────────────────
  // `NegativeLayerStart` is a hard rule on the edit side, so without this repair
  // every project the pre-clamp `move_layer` wrote would refuse to OPEN.
  /** One clip straddling zero — what the pre-clamp `move_layer` wrote when a layer
   *  was dragged left past the origin. The head of the track is left EMPTY because
   *  that is the only arrangement the buggy move could actually persist: validate ran
   *  after the move, so the layer cannot have overlapped a neighbour where it landed. */
  function negativeStartWire(startUs: number, endUs: number): Wire {
    const g = seededGen()
    const p = blankProject(g, 'legacy')
    applyAddLayer(p, g, p.tracks[0].id, colorParams(RED, 16, 9), 6_000_000, 8_000_000)
    const wire = serializeProject(p) as Wire
    wire.tracks[0].layers[0].t_start_us = startUs
    wire.tracks[0].layers[0].t_end_us = endUs
    return wire
  }

  it('lifts a partially-negative t_start_us to 0 on load, in one repair row, and reports it', () => {
    const wire = negativeStartWire(-1_000_000, 2_000_000) // canonical at 30/1, still illegal
    const layerId = wire.tracks[0].layers[0].id as string
    const reported: GridRepair[][] = []
    const project = parseProject(wire, { onGridRepair: (r) => reported.push([...r]) })
    // ONE row, not a lift followed by a snap: the lift runs before the snap and 0 is
    // a lattice point on every grid, so the snap that follows is the identity.
    expect(reported).toEqual([[{ entity: 'Layer', id: layerId, field: 't_start_us', from: -1_000_000, to: 0 }]])
    expect(project.tracks[0].layers[0].t_start_us).toBe(0)
    expect(project.tracks[0].layers[0].t_end_us).toBe(2_000_000) // end untouched — the visible part is preserved exactly
    expect(() => validate(project)).not.toThrow()
    // Idempotent: reopening the repaired project reports nothing.
    const second: GridRepair[][] = []
    parseProject(JSON.parse(serializeProjectToJson(project)), { onGridRepair: (r) => second.push([...r]) })
    expect(second).toEqual([])
  })

  it('parks an ENTIRELY-negative layer past the track instead of colliding at the head', () => {
    // Lifting this one's start would collapse it onto [0, one frame) — straight into
    // the clip already sitting at the head of the track, so the "repair" would produce
    // a LayerOverlap and the project would stop opening. Parking keeps its duration
    // and cannot collide.
    const g = seededGen()
    const p = blankProject(g, 'legacy')
    applyAddLayer(p, g, p.tracks[0].id, colorParams(RED, 16, 9), 0, 2_000_000) // head of track
    applyAddLayer(p, g, p.tracks[0].id, colorParams(RED, 16, 9), 3_000_000, 5_000_000)
    const wire = serializeProject(p) as Wire
    wire.tracks[0].layers[1].t_start_us = -5_000_000
    wire.tracks[0].layers[1].t_end_us = -4_000_000  // 1 s, entirely before zero

    const project = parseProject(wire, silent)
    const parked = project.tracks[0].layers.find((l) => l.id === (wire.tracks[0].layers[1].id as string))!
    expect(parked.t_start_us).toBe(2_000_000)                     // past the head clip
    expect(parked.t_end_us - parked.t_start_us).toBe(1_000_000)   // duration intact
    expect(() => validate(project)).not.toThrow()
  })

  it('replaceState accepts the repaired project and rejects the un-repaired one', () => {
    const g = seededGen()
    const actor = createActor({ initial: blankProject(g, 'x'), idGen: g })
    expect(() => actor.replaceState(parseProject(offGridWire(), silent))).not.toThrow()
    try {
      actor.replaceState(offGridWire() as unknown as Project)
      throw new Error('expected replaceState to reject the un-repaired project')
    } catch (e) {
      if (!isCommandFailure(e)) throw e
      expect(e.err).toEqual({ error: 'ValidationFailed', detail: { rule: 'OffGridLayerBoundary', layer: expect.any(String), field: 't_start_us', t: 2_999_999, fps: { num: 30, den: 1 }, grid: 'frame', snap_to: 3_000_000 } })
    }
  })

  it('rejects the same off-grid value when a MUTATION submits it (reject on edit)', () => {
    const g = seededGen()
    const actor = createActor({ initial: blankProject(g, 'x'), idGen: g })
    const track = actor.snapshot().tracks[0].id
    const added = actor.dispatch('add_layer', { track, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 })
    expect(added.ok).toBe(true)
    const layer = added.ok ? (added.value as string) : ''
    // update_layer is the one envelope patch that stores raw µs — the backstop is
    // what stops it, and the failure is structured rather than a silent write.
    const res = actor.dispatch('update_layer', { layer, patch: { t_end_us: 2_999_999 } })
    expect(res).toEqual({ ok: false, error: { error: 'ValidationFailed', detail: { rule: 'OffGridLayerBoundary', layer, field: 't_end_us', t: 2_999_999, fps: { num: 30, den: 1 }, grid: 'frame', snap_to: 3_000_000 } } })
  })

  it('is idempotent: repaired → saved → reopened reports no second repair', () => {
    const repaired = parseProject(offGridWire(), silent)
    const reported: GridRepair[][] = []
    const reopened = parseProject(JSON.parse(serializeProjectToJson(repaired)), { onGridRepair: (r) => reported.push([...r]) })
    expect(reported).toEqual([])
    expect(canonicalString(serializeProject(reopened))).toBe(canonicalString(serializeProject(repaired)))
  })

  it('re-derives transition.duration_us from the repaired geometry', () => {
    // A duration is the geometric overlap, so moving an endpoint 1 µs changes what
    // it must be — leave it and the repaired project fails to open on
    // TransitionDurationMismatch instead.
    const g = seededGen()
    const p = blankProject(g, 'legacy')
    const track = p.tracks[0].id
    const from = applyAddLayer(p, g, track, colorParams(RED, 16, 9), 0, 3_000_000)
    const to = applyAddLayer(p, g, track, colorParams(RED, 16, 9), 2_000_000, 5_000_000)
    p.transitions = [{ id: 'tr', from_layer: from, to_layer: to, duration_us: 1_000_000, kind: { kind: 'Crossfade' }, extended_us: 0 }]
    const wire = serializeProject(p) as Wire
    wire.tracks[0].layers[0].t_end_us = 2_999_999
    wire.transitions[0].duration_us = 999_999

    const reported: GridRepair[][] = []
    const project = parseProject(wire, { onGridRepair: (r) => reported.push([...r]) })
    expect(reported[0]).toEqual([
      { entity: 'Layer', id: from, field: 't_end_us', from: 2_999_999, to: 3_000_000 },
      { entity: 'Transition', id: 'tr', field: 'duration_us', from: 999_999, to: 1_000_000 },
    ])
    expect(() => validate(project)).not.toThrow()
  })

  it('backfills a missing transition.extended_us with duration_us, leaving a present value alone', () => {
    // A file written before extended_us existed: its only reachable add borrowed
    // the outgoing tail by the FULL duration, so duration_us is the exact truth.
    const g = seededGen()
    const p = blankProject(g, 'legacy')
    const track = p.tracks[0].id
    const from = applyAddLayer(p, g, track, colorParams(RED, 16, 9), 0, 3_000_000)
    const to = applyAddLayer(p, g, track, colorParams(RED, 16, 9), 2_000_000, 5_000_000)
    p.transitions = [{ id: 'tr', from_layer: from, to_layer: to, duration_us: 1_000_000, kind: { kind: 'Crossfade' }, extended_us: 250_000 }]
    // Deep-clone: serializeProject is a shallow spread, so deleting on its
    // output directly would reach back into `p` and corrupt the second half.
    const wire = JSON.parse(JSON.stringify(serializeProject(p))) as Wire
    delete wire.transitions[0].extended_us
    const project = parseProject(wire, silent)
    expect(project.transitions[0].extended_us).toBe(1_000_000)
    expect(() => validate(project)).not.toThrow()
    // A present value is authored provenance — never overwritten.
    const wire2 = JSON.parse(JSON.stringify(serializeProject(p))) as Wire
    expect(parseProject(wire2, silent).transitions[0].extended_us).toBe(250_000)
  })

  it('the extended_us backfill reads the grid-repaired duration, not the stale stored one', () => {
    // Ordering guard: the grid repair re-derives duration_us from repaired
    // geometry, and the backfill copies THAT value — copying the stale one could
    // mint extended_us > duration_us and the project would refuse to open on
    // the structural rule.
    const g = seededGen()
    const p = blankProject(g, 'legacy')
    const track = p.tracks[0].id
    const from = applyAddLayer(p, g, track, colorParams(RED, 16, 9), 0, 3_000_000)
    const to = applyAddLayer(p, g, track, colorParams(RED, 16, 9), 2_000_000, 5_000_000)
    p.transitions = [{ id: 'tr', from_layer: from, to_layer: to, duration_us: 1_000_000, kind: { kind: 'Crossfade' }, extended_us: 0 }]
    const wire = serializeProject(p) as Wire
    wire.tracks[0].layers[0].t_end_us = 2_999_999 // repair snaps → duration re-derives to 1_000_000
    wire.transitions[0].duration_us = 999_999
    delete wire.transitions[0].extended_us
    const project = parseProject(wire, silent)
    expect(project.transitions[0].duration_us).toBe(1_000_000)
    expect(project.transitions[0].extended_us).toBe(1_000_000)
    expect(() => validate(project)).not.toThrow()
  })

  it('repairs composition.duration_us and marker times', () => {
    const g = seededGen()
    const p = blankProject(g, 'legacy')
    const wire = serializeProject(p) as Wire
    wire.composition.duration_us = 2_999_999
    wire.markers = [{ id: 'mk', t_us: 2_999_999, end_t_us: 4_000_001, label: 'm', color: RED, metadata: {} }]
    const reported: GridRepair[][] = []
    const project = parseProject(wire, { onGridRepair: (r) => reported.push([...r]) })
    expect(reported[0]).toEqual([
      { entity: 'Composition', id: null, field: 'duration_us', from: 2_999_999, to: 3_000_000 },
      { entity: 'Marker', id: 'mk', field: 't_us', from: 2_999_999, to: 3_000_000 },
      { entity: 'Marker', id: 'mk', field: 'end_t_us', from: 4_000_001, to: 4_000_000 },
    ])
    expect(() => validate(project)).not.toThrow()
  })

  it('widens a sub-frame span the snap collapsed, so the repair never manufactures InvalidLayerRange', () => {
    const g = seededGen()
    const p = blankProject(g, 'legacy')
    const wire = serializeProject(p) as Wire
    // A legacy layer shorter than one frame: both edges snap to frame 0.
    wire.tracks[0].layers = [{ id: 'sub', label: null, t_start_us: 1_000, t_end_us: 2_000, enabled: true, locked: false, metadata: {}, effects: [], params: colorParams(RED, 16, 9) }]
    const project = parseProject(wire, silent)
    expect(project.tracks[0].layers[0].t_start_us).toBe(0)
    expect(project.tracks[0].layers[0].t_end_us).toBe(33_333) // frame 1 at 30/1
    expect(() => validate(project)).not.toThrow()
  })

  it('leaves a degenerate-fps project alone (InvalidFps is the right report, not a snap)', () => {
    const g = seededGen()
    const p = blankProject(g, 'legacy')
    const wire = serializeProject(p) as Wire
    wire.composition.fps = { num: 0, den: 1 }
    wire.composition.duration_us = 2_999_999
    const reported: GridRepair[][] = []
    parseProject(wire, { onGridRepair: (r) => reported.push([...r]) })
    expect(reported).toEqual([])
    expect(wire.composition.duration_us).toBe(2_999_999)
  })
})

// ── Text box additive-field default ──────────────────────────────────────────
// `undefined` and `null` are different values for the box: nullability alone
// encodes the resize mode, so an absent `box_w` that survived the load pass
// would read as "wrap at width undefined" and blank a line that used to render.
describe('parseProject text box defaults', () => {
  /** A project saved before the box existed: a Text layer with none of the five
   *  fields on the wire. */
  function boxlessTextWire(): Wire {
    const g = seededGen()
    const p = blankProject(g, 'legacy')
    applyAddLayer(p, g, p.tracks[1].id, textParamsDefault('caption', p.composition), 0, 1_000_000)
    const wire = serializeProject(p) as Wire
    const params = wire.tracks[1].layers[0].params as Record<string, unknown>
    for (const k of ['box_w', 'box_h', 'valign', 'line_height', 'letter_spacing']) delete params[k]
    return wire
  }

  it('turns an absent box into an explicit null, and fills valign/leading/tracking', () => {
    const wire = boxlessTextWire()
    const params = parseProject(wire, silent).tracks[1].layers[0].params as Extract<LayerParams, { kind: 'Text' }>
    expect(params.box_w).toBeNull()
    expect(params.box_h).toBeNull()
    expect([params.valign, params.line_height, params.letter_spacing]).toEqual(['Middle', 0, 0])
  })

  it('leaves an authored box exactly as written', () => {
    const wire = boxlessTextWire()
    Object.assign(wire.tracks[1].layers[0].params as Record<string, unknown>, { box_w: 1600, box_h: 200, valign: 'Bottom', line_height: 72, letter_spacing: 3 })
    const params = parseProject(wire, silent).tracks[1].layers[0].params as Extract<LayerParams, { kind: 'Text' }>
    expect([params.box_w, params.box_h, params.valign, params.line_height, params.letter_spacing]).toEqual([1600, 200, 'Bottom', 72, 3])
  })

  it('does not grow box fields on a non-Text layer', () => {
    const g = seededGen()
    const p = blankProject(g, 'legacy')
    applyAddLayer(p, g, p.tracks[0].id, colorParams(RED, 16, 9), 0, 1_000_000)
    const parsed = parseProject(serializeProject(p) as Wire, silent)
    expect('box_w' in parsed.tracks[0].layers[0].params).toBe(false)
  })
})
