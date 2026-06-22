// apps/desktop/src/main/state/replay.test.ts
import { describe, it, expect } from 'vitest'
import { replaySequence, sequenceIsSupported, SUPPORTED_OPS } from './replay'

const smoke = {
  name: '_smoke',
  commands: [
    { op: 'add_layer', track: '@A', kind: 'color', t_start_us: 0, t_end_us: 1_000_000, ref: 'L1' },
    { op: 'duplicate_layer', layer: '@L1', t_offset_us: 2_000_000 },
  ],
}

describe('TS replay driver', () => {
  it('supports the smoke + split + groups_create vocabulary; rejects a Phase-2b op', () => {
    expect(sequenceIsSupported(smoke)).toBe(true)
    expect(sequenceIsSupported({ name: 's', commands: [{ op: 'split_layer', layer: '@L1', at_t_us: 1 }] })).toBe(true)
    expect(sequenceIsSupported({ name: 'g', commands: [{ op: 'groups_create', layers: ['@L1', '@L2'] }] })).toBe(true)
    expect(sequenceIsSupported({ name: 'u', commands: [{ op: 'update_layer_params', layer: '@L1' }] })).toBe(false)
    expect(SUPPORTED_OPS.has('move_layer')).toBe(true)
    expect(SUPPORTED_OPS.has('split_layer')).toBe(true)
    expect(SUPPORTED_OPS.has('groups_create')).toBe(true)
    expect(SUPPORTED_OPS.has('update_layer_params')).toBe(false)
  })
  it('produces a 2-step trace and is deterministic (run twice identical)', () => {
    const a = JSON.stringify(replaySequence(smoke))
    const b = JSON.stringify(replaySequence(smoke))
    expect(a).toBe(b)
    expect(replaySequence(smoke).steps).toHaveLength(2)
    expect(replaySequence(smoke).steps.every((s) => s.ok)).toBe(true)
  })
})
