import { describe, it, expect } from 'vitest'
import { createActor } from '../actor'
import { uuidV7Gen } from '../ids'
import { blankProject } from '../model'

const mk = () => { const g = uuidV7Gen(); return createActor({ initial: blankProject(g, 't'), idGen: g, clock: () => '2026-01-01T00:00:00.000Z' }) }

describe('command-path arg hardening', () => {
  it('add_color_layer rejects a non-number tStartUs instead of committing NaN', () => {
    const r = mk().command('add_color_layer', { tStartUs: 'soon', durationUs: 1_000_000 })
    expect(r.ok).toBe(false)
  })
  it('add_color_layer rejects a string color', () => {
    const r = mk().command('add_color_layer', { tStartUs: 0, color: '#fff' })
    expect(r.ok).toBe(false)
  })
  it('dry_run via specToDryRunOp rejects a non-number t_start_us', () => {
    const r = mk().mcpCall('dry_run', JSON.stringify({ operations: [{ kind: 'add_color_layer', track_id: '00000000-0000-7000-8000-000000000001', color: { r:0,g:0,b:0,a:255 }, t_start_us: 'x', t_end_us: 1 }] }))
    expect(r.ok).toBe(false)
  })
})
