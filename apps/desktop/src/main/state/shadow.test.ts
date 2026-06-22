// apps/desktop/src/main/state/shadow.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject } from './model'
import { compareCanonical, tsActorHandles } from './shadow'

describe('shadow helpers', () => {
  it('tsActorHandles knows the Phase-2b-vi vocabulary (incl. split + groups_create + params + role/settings)', () => {
    expect(tsActorHandles('move_layer')).toBe(true)
    expect(tsActorHandles('add_layer')).toBe(true)
    expect(tsActorHandles('split_layer')).toBe(true)
    expect(tsActorHandles('groups_create')).toBe(true)
    expect(tsActorHandles('update_layer_params')).toBe(true)
    expect(tsActorHandles('set_role_gain')).toBe(true)
    expect(tsActorHandles('update_role_flags')).toBe(true)
    expect(tsActorHandles('update_project_settings')).toBe(true)
    expect(tsActorHandles('unknown_future_op')).toBe(false)
  })
  it('compareCanonical ignores key order but catches value differences', () => {
    expect(compareCanonical({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(compareCanonical({ a: 1 }, { a: 2 })).toBe(false)
  })
  it('blankProject sanity for shadow seeding', () => {
    expect(blankProject(seededGen(), 'x').tracks).toHaveLength(2)
  })
})
