import { describe, it, expect, afterEach } from 'vitest'
import { isPausedUnderTsActor, MUTATION_TOOLS } from './mutationTools'

afterEach(() => { delete process.env['WEFTCUT_TS_ACTOR'] })

describe('isPausedUnderTsActor', () => {
  it('pauses a category-A mutation tool only when the flag is on', () => {
    const tool = [...MUTATION_TOOLS][0]
    process.env['WEFTCUT_TS_ACTOR'] = '1'
    expect(isPausedUnderTsActor(tool)).toBe(true)
    delete process.env['WEFTCUT_TS_ACTOR']
    expect(isPausedUnderTsActor(tool)).toBe(false)
  })
  it('never pauses a non-mutation tool', () => {
    process.env['WEFTCUT_TS_ACTOR'] = '1'
    expect(isPausedUnderTsActor('list_motifs')).toBe(false)
  })
})
