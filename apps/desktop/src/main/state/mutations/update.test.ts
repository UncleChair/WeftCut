// src/main/state/mutations/update.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type LayerParams, type Project } from '../model'
import { applyUpdateLayer } from './update'
import { isCommandFailure } from '../errors'

function color(id: string, t0: number, t1: number): Layer {
  const params: LayerParams = { kind: 'Color', color: { mode: 'Static', value: { r: 0, g: 0, b: 0, a: 255 } }, width: 1, height: 1 }
  return { id, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}
function one(): Project { const p = blankProject(seededGen(), 't'); p.tracks[0].layers = [color('a', 0, 1_000_000)]; return p }
function expectCmd(fn: () => void, code: string) { try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) } }

describe('applyUpdateLayer', () => {
  it('applies only the provided fields (label/times/flags)', () => {
    const p = one()
    applyUpdateLayer(p, 'a', { label: 'hi', t_end_us: 2_000_000, enabled: false })
    const l = p.tracks[0].layers[0]
    expect(l.label).toBe('hi'); expect(l.t_end_us).toBe(2_000_000); expect(l.enabled).toBe(false)
    expect(l.t_start_us).toBe(0); expect(l.locked).toBe(false) // untouched
  })
  it('treats null/absent patch fields as "do not touch"', () => {
    const p = one()
    applyUpdateLayer(p, 'a', { label: null, t_start_us: null })
    const l = p.tracks[0].layers[0]
    expect(l.label).toBeNull(); expect(l.t_start_us).toBe(0) // unchanged
  })
  it('does NOT autofit composition.duration_us on a t_end change (mutations.rs:332-362)', () => {
    const p = one(); p.composition.duration_us = 1_000_000; p.composition.duration_pinned = false
    applyUpdateLayer(p, 'a', { t_end_us: 5_000_000 })
    expect(p.composition.duration_us).toBe(1_000_000) // unchanged — update_layer never autofits
  })
  it('throws LayerNotFound for a missing layer', () => {
    expectCmd(() => applyUpdateLayer(one(), 'ghost', { enabled: false }), 'LayerNotFound')
  })
  it('throws TrackLocked when the layer is on a locked track (ungated by corpus)', () => {
    const p = one(); p.tracks[0].locked = true
    expectCmd(() => applyUpdateLayer(p, 'a', { t_end_us: 2_000_000 }), 'TrackLocked')
  })
})
