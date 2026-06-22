// apps/desktop/src/main/state/shadow.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject } from './model'
import { compareCanonical, tsActorHandles } from './shadow'

describe('shadow helpers', () => {
  it('tsActorHandles knows the Phase-2a vocabulary (incl. split + groups_create)', () => {
    expect(tsActorHandles('move_layer')).toBe(true)
    expect(tsActorHandles('add_layer')).toBe(true)
    expect(tsActorHandles('split_layer')).toBe(true)
    expect(tsActorHandles('groups_create')).toBe(true)
    expect(tsActorHandles('update_layer_params')).toBe(false) // Phase-2b op, not yet in the replay vocabulary
  })
  it('compareCanonical ignores key order but catches value differences', () => {
    expect(compareCanonical({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(compareCanonical({ a: 1 }, { a: 2 })).toBe(false)
  })
  it('blankProject sanity for shadow seeding', () => {
    expect(blankProject(seededGen(), 'x').tracks).toHaveLength(2)
  })
})
