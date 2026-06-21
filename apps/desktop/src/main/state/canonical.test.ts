import { describe, it, expect } from 'vitest'
import { canonicalize, canonicalString } from './canonical'

describe('canonicalize', () => {
  it('sorts object keys recursively but preserves array order', () => {
    const out = canonicalize({ b: 1, a: { d: 2, c: 3 }, list: [3, 1, 2] })
    expect(JSON.stringify(out)).toBe('{"a":{"c":3,"d":2},"b":1,"list":[3,1,2]}')
  })
  it('normalizes wall-clock fields to a sentinel', () => {
    const out = canonicalize({ metadata: { created_at: '2020-01-01T00:00:00Z', modified_at: '2021-06-06T12:00:00Z', name: 'x' } })
    expect((out as any).metadata.created_at).toBe('<TS>')
    expect((out as any).metadata.modified_at).toBe('<TS>')
    expect((out as any).metadata.name).toBe('x')
  })
  it('canonicalString is stable regardless of input key order', () => {
    expect(canonicalString({ y: 1, x: 2 })).toBe(canonicalString({ x: 2, y: 1 }))
  })
})
