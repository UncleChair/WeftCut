import { describe, it, expect } from 'vitest'
import { CommandFailure, isCommandFailure } from './errors'

describe('error wrappers', () => {
  it('CommandFailure carries the typed union and is type-guardable', () => {
    const e = new CommandFailure({ error: 'LayerNotFound', layer: 'abc' })
    expect(isCommandFailure(e)).toBe(true)
    expect(e.err.error).toBe('LayerNotFound')
  })
})
