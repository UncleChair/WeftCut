// apps/desktop/src/main/state/model.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject, SCHEMA_VERSION } from './model'

describe('blankProject', () => {
  it('mirrors Rust new_blank: A-roll, B-roll, then project_id', () => {
    const p = blankProject(seededGen(), 'test')
    expect(p.schema_version).toBe(SCHEMA_VERSION)
    expect(p.tracks).toHaveLength(2)
    expect(p.tracks[0].id).toBe('00000000-0000-0000-0000-000000000001')
    expect(p.tracks[0].role).toBe('ARoll')
    expect(p.tracks[0].removable).toBe(false)
    expect(p.tracks[1].id).toBe('00000000-0000-0000-0000-000000000002')
    expect(p.tracks[1].role).toBe('BRoll')
    expect(p.project_id).toBe('00000000-0000-0000-0000-000000000003')
    expect(p.media_pool).toEqual({})
    expect(p.settings.history_capacity).toBe(200)
  })
})
