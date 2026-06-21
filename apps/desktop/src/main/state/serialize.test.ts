import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject } from './model'
import { canonicalString } from './canonical'
import { parseProject, serializeProject } from './serialize'

describe('serialize round-trip', () => {
  it('round-trips a blank project', () => {
    const p = blankProject(seededGen(), 'test')
    const wire = serializeProject(p)
    expect(canonicalString(serializeProject(parseProject(wire)))).toBe(canonicalString(wire))
  })
  it('sorts group.members and omits a null label', () => {
    const p = blankProject(seededGen(), 'test')
    p.groups = [{ id: 'g', members: ['00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000a'] }]
    const wire = serializeProject(p) as any
    expect(wire.groups[0].members).toEqual(['00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b'])
    expect('label' in wire.groups[0]).toBe(false)
  })
  it('rejects a wrong schema version', () => {
    expect(() => parseProject({ schema_version: 8 })).toThrow(/schema/i)
  })
})
