import { describe, it, expect } from 'vitest'
import { mapChangeEvent } from './ts-actor-host'

describe('mapChangeEvent', () => {
  it('maps a User ChangeEvent to the Rust project:changed payload shape', () => {
    const out = mapChangeEvent({ op_id: 'op-1', actor: { kind: 'User' }, timestamp: '2026-06-23T00:00:00.000Z', summary: 'Added layer', affected: [{ kind: 'Layer', id: 'L1' }], new_snapshot: {} as never, diff_hint: { kind: 'Coarse' } })
    expect(out).toEqual({ op_id: 'op-1', actor_kind: 'user', client: null, summary: 'Added layer', timestamp: '2026-06-23T00:00:00.000Z', affected_count: 1 })
  })
  it('maps an Agent ChangeEvent client through', () => {
    const out = mapChangeEvent({ op_id: 'op-2', actor: { kind: 'Agent', client: 'mcp' }, timestamp: 't', summary: 's', affected: [], new_snapshot: {} as never, diff_hint: { kind: 'Coarse' } })
    expect(out.actor_kind).toBe('agent'); expect(out.client).toBe('mcp')
  })
})
