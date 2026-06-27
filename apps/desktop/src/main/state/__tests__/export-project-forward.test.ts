import { describe, it, expect } from 'vitest'
import { injectProjectArgs, EXPORT_PROJECT_CHANNELS } from '../export-project-forward'
import { blankProject } from '../model'
import { uuidV7Gen } from '../ids'

describe('injectProjectArgs', () => {
  it('adds the wire-shape project and preserves existing args', () => {
    const p = blankProject(uuidV7Gen(), 'export-test')
    const out = injectProjectArgs({ outputPath: 'a.m4a', startUs: null, endUs: null }, p)
    expect(out.outputPath).toBe('a.m4a')
    expect(out.startUs).toBeNull()
    expect((out.project as { project_id: string }).project_id).toBe(p.project_id)
    expect((out.project as { schema_version: number }).schema_version).toBe(p.schema_version)
  })

  it('lists exactly the two audio-export channels', () => {
    expect([...EXPORT_PROJECT_CHANNELS].sort()).toEqual(
      ['ensure_export_audio_conform', 'export_project_audio_only'],
    )
  })
})
