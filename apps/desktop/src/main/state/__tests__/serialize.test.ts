// apps/desktop/src/main/state/__tests__/serialize.test.ts
import { describe, it, expect } from 'vitest'
import { parseProject } from '../serialize'
import { SCHEMA_VERSION, blankProject } from '../model'
import { seededGen } from '../ids'

describe('parseProject structural conformance', () => {
  const good = JSON.parse(JSON.stringify({ ...blankProject(seededGen(), 'p') })) // round-trippable plain object

  it('accepts a well-formed project', () => {
    expect(() => parseProject(good)).not.toThrow()
  })
  it('rejects a non-object', () => {
    expect(() => parseProject(42)).toThrow(/not an object/)
  })
  it('rejects a wrong schema_version', () => {
    expect(() => parseProject({ ...good, schema_version: SCHEMA_VERSION - 1 })).toThrow(/schema_version/)
  })
  it('rejects a project missing required top-level fields', () => {
    const { composition, ...noComposition } = good
    expect(() => parseProject(noComposition)).toThrow(/composition/)
    const { tracks, ...noTracks } = good
    expect(() => parseProject(noTracks)).toThrow(/tracks/)
    const { media_pool, ...noPool } = good
    expect(() => parseProject(noPool)).toThrow(/media_pool/)
  })
  it('rejects a wrong field type', () => {
    expect(() => parseProject({ ...good, tracks: {} })).toThrow(/tracks/)
    expect(() => parseProject({ ...good, composition: 'x' })).toThrow(/composition/)
  })
})
