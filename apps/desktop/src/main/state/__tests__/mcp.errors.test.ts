// apps/desktop/src/main/state/__tests__/mcp.errors.test.ts
//
// `mapCommandError`'s STRUCTURED arms. A CommandError reaching an agent as bare
// prose is a dead end — it has to re-derive the fix or give up — so the arms that
// carry machine-usable `data` are the ones worth pinning. The grid + bounds rules
// are the strongest case: their fix is a single corrected number that the actor
// already computed, so the retry is mechanical.
import { describe, it, expect } from 'vitest'
import { mapCommandError, dryRunErrorString } from '../mcp-commands'
import type { CommandError } from '../errors'

const validationFailed = (detail: Extract<CommandError, { error: 'ValidationFailed' }>['detail']): CommandError =>
  ({ error: 'ValidationFailed', detail })

describe('mapCommandError — grid and bounds rules are self-correcting', () => {
  it('echoes snap_to for an off-grid layer boundary on the composition frame grid', () => {
    const out = mapCommandError(validationFailed({
      rule: 'OffGridLayerBoundary', layer: 'L1', field: 't_end_us',
      t: 2_999_999, fps: { num: 30, den: 1 }, grid: 'frame', snap_to: 3_000_000,
    }))
    expect(out.code).toBe('invalid_params')
    expect(out.data).toEqual({
      error: 'OffGridLayerBoundary', layer: 'L1', field: 't_end_us',
      requested_us: 2_999_999, snap_to_us: 3_000_000, grid: 'frame', rate: [30, 1],
      options: [{ action: 'retry_snapped', field: 't_end_us', t_us: 3_000_000 }],
    })
    expect(out.message).toContain('3000000')
  })

  it('names the AUDIO lattice rather than reporting 48000/1 as a frame rate', () => {
    // Without this the message reads as an absurd 48 000 fps composition, which is
    // the one way a caller could misread the two-lattice model (spec R2-D6).
    const out = mapCommandError(validationFailed({
      rule: 'OffGridLayerBoundary', layer: 'A1', field: 't_start_us',
      t: 33_367, fps: { num: 48_000, den: 1 }, grid: 'sample', snap_to: 33_375,
    }))
    expect(out.message).toContain('48000 Hz audio sample lattice')
    expect(out.message).not.toContain('fps')
    expect((out.data as { grid: string }).grid).toBe('sample')
    expect((out.data as { snap_to_us: number }).snap_to_us).toBe(33_375)
  })

  it('echoes snap_to for an off-grid composition duration and marker time', () => {
    const comp = mapCommandError(validationFailed({
      rule: 'OffGridTime', entity: 'Composition', id: null, field: 'duration_us',
      t: 2_999_999, fps: { num: 30, den: 1 }, snap_to: 3_000_000,
    }))
    expect(comp.data).toMatchObject({ error: 'OffGridTime', entity: 'Composition', id: null, snap_to_us: 3_000_000 })
    const marker = mapCommandError(validationFailed({
      rule: 'OffGridTime', entity: 'Marker', id: 'MK', field: 't_us',
      t: 2_999_999, fps: { num: 30, den: 1 }, snap_to: 3_000_000,
    }))
    expect(marker.data).toMatchObject({ error: 'OffGridTime', entity: 'Marker', id: 'MK', snap_to_us: 3_000_000 })
  })

  it('tells a caller that timeline time starts at zero', () => {
    const out = mapCommandError(validationFailed({ rule: 'NegativeLayerStart', layer: 'L1', t_start: -5_000_000 }))
    expect(out.data).toEqual({
      error: 'NegativeLayerStart', layer: 'L1', requested_us: -5_000_000,
      options: [{ action: 'retry_clamped', t_start_us: 0 }],
    })
  })

  it('leaves every other validation rule on the generic path', () => {
    // The enrichment is opt-in per rule; a rule whose fix is not a single number
    // gains nothing from a `data` block and must not grow a misleading one.
    const out = mapCommandError(validationFailed({ rule: 'DuplicateLayerId', layer: 'L1' }))
    expect(out).toEqual({ code: 'invalid_params', message: 'ValidationFailed' })
  })
})

describe('dryRunErrorString', () => {
  it('carries the corrected value into dry-run prose', () => {
    // A dry run is exactly where an agent is still able to fix the op cheaply.
    expect(dryRunErrorString(validationFailed({
      rule: 'OffGridLayerBoundary', layer: 'L1', field: 't_end_us',
      t: 2_999_999, fps: { num: 30, den: 1 }, grid: 'frame', snap_to: 3_000_000,
    }))).toBe('validation failed: OffGridLayerBoundary (t_end_us 2999999 µs → send 3000000)')
  })

  it('falls back to the rule name for everything else', () => {
    expect(dryRunErrorString(validationFailed({ rule: 'DuplicateLayerId', layer: 'L1' })))
      .toBe('validation failed: DuplicateLayerId')
  })
})
