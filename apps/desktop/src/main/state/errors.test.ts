import { describe, it, expect } from 'vitest'
import {
  CommandFailure, isCommandFailure,
  tsErrorVariant, parseOracleErrorVariant,
} from './errors'

describe('error wrappers', () => {
  it('CommandFailure carries the typed union and is type-guardable', () => {
    const e = new CommandFailure({ error: 'LayerNotFound', layer: 'abc' })
    expect(isCommandFailure(e)).toBe(true)
    expect(e.err.error).toBe('LayerNotFound')
  })
})

describe('variant extraction (differential harness)', () => {
  it('parses a plain Rust Debug error', () => {
    expect(parseOracleErrorVariant('TrimEdgeOutOfRange { layer: x, new_t: 0 }'))
      .toEqual({ top: 'TrimEdgeOutOfRange' })
  })
  it('parses a payload-less Rust Debug error', () => {
    expect(parseOracleErrorVariant('NothingToUndo')).toEqual({ top: 'NothingToUndo' })
  })
  it('parses a nested ValidationFailed Rust Debug error', () => {
    expect(parseOracleErrorVariant('ValidationFailed(LayerOverlap { track: t, a: x })'))
      .toEqual({ top: 'ValidationFailed', inner: 'LayerOverlap' })
  })
  it('maps a TS CommandError to the same shape', () => {
    expect(tsErrorVariant({ error: 'TrimEdgeOutOfRange', layer: 'x', new_t: 0, cur_start: 0, cur_end: 1 }))
      .toEqual({ top: 'TrimEdgeOutOfRange' })
    expect(tsErrorVariant({ error: 'ValidationFailed', detail: { rule: 'LayerOverlap', track: 't', a: 'x', a_start: 0, a_end: 1, b: 'y', b_start: 0, b_end: 1 } }))
      .toEqual({ top: 'ValidationFailed', inner: 'LayerOverlap' })
  })
})
