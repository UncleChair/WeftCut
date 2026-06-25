import { describe, it, expect, vi } from 'vitest'
import { createActor } from '../actor'
import { uuidV7Gen } from '../ids'
import { blankProject } from '../model'

describe('actor change broadcast fault isolation', () => {
  it('a throwing subscriber does not starve later subscribers', () => {
    const idGen = uuidV7Gen()
    const actor = createActor({ initial: blankProject(idGen, 't'), idGen, clock: () => '2026-01-01T00:00:00.000Z' })
    const thrower = vi.fn(() => { throw new Error('subscriber boom') })
    const after = vi.fn()
    actor.subscribe(thrower)
    actor.subscribe(after)
    // Any recorded mutation broadcasts a ChangeEvent.
    actor.dispatch('add_track', { label: 'X' })
    expect(thrower).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledTimes(1) // would be 0 before the fix
  })
})
