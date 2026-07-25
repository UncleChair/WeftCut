import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject, type Project } from './model'
import { canonicalString } from './canonical'
import { parseProject, serializeProject, type GridRepair } from './serialize'
import { serializeProjectToJson } from './persistence'
import { validate } from './validate'
import { createActor } from './actor'
import { applyAddLayer, colorParams } from './mutations/add'
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
  it('rejects a wrong schema version', () => {
    expect(() => parseProject({ schema_version: 8 })).toThrow(/schema/i)
  })
})

// ── Load-time grid repair (spec D4: repair on load, reject on edit) ───────────
// `replaceState` runs the mutation validator and `project_open` goes through it,
// so a project already holding an off-grid endpoint must be REPAIRED here or it
// stops opening at all.
const RED = { r: 255, g: 0, b: 0, a: 255 }
type Wire = { tracks: Array<{ layers: Array<Record<string, unknown>> }>; transitions: Array<Record<string, unknown>>; markers: Array<Record<string, unknown>>; composition: Record<string, unknown> }

/** A saved project whose second clip starts 1 µs below frame 90 at 30/1 — the
 *  exact value the trim source-duration clamp used to persist. */
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

  it('replaceState accepts the repaired project and rejects the un-repaired one', () => {
    const g = seededGen()
    const actor = createActor({ initial: blankProject(g, 'x'), idGen: g })
    expect(() => actor.replaceState(parseProject(offGridWire(), silent))).not.toThrow()
    try {
      actor.replaceState(offGridWire() as unknown as Project)
      throw new Error('expected replaceState to reject the un-repaired project')
    } catch (e) {
      if (!isCommandFailure(e)) throw e
      expect(e.err).toEqual({ error: 'ValidationFailed', detail: { rule: 'OffGridLayerBoundary', layer: expect.any(String), field: 't_start_us', t: 2_999_999, fps: { num: 30, den: 1 }, grid: 'frame' } })
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
    expect(res).toEqual({ ok: false, error: { error: 'ValidationFailed', detail: { rule: 'OffGridLayerBoundary', layer, field: 't_end_us', t: 2_999_999, fps: { num: 30, den: 1 }, grid: 'frame' } } })
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
    p.transitions = [{ id: 'tr', from_layer: from, to_layer: to, duration_us: 1_000_000, kind: { kind: 'Crossfade' } }]
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
