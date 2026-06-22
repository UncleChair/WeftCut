import { describe, it, expect } from 'vitest'
import { seededGen, type IdGen } from '../ids'
import { blankProject, type Project } from '../model'
import { applyAddTrack, applyAddLayer, colorParams } from './add'
import { applyDeleteTrack, applyMoveTrack } from './tracks'
import { isCommandFailure } from '../errors'

function base(): { p: Project; gen: IdGen } { const gen = seededGen(); return { p: blankProject(gen, 't'), gen } }
function expectCmd(fn: () => void, code: string) { try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) } }

describe('applyDeleteTrack', () => {
  it('removes an empty custom track', () => {
    const { p, gen } = base(); const t = applyAddTrack(p, gen, 'extra')
    applyDeleteTrack(p, t, false)
    expect(p.tracks.find((x) => x.id === t)).toBeUndefined()
  })
  it('rejects a reserved (non-removable) track', () => {
    const { p } = base()
    expectCmd(() => applyDeleteTrack(p, p.tracks[0].id, false), 'TrackNotRemovable')
  })
  it('rejects a non-empty track without force', () => {
    const { p, gen } = base(); const t = applyAddTrack(p, gen, 'extra')
    applyAddLayer(p, gen, t, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    expectCmd(() => applyDeleteTrack(p, t, false), 'TrackNotEmpty')
  })
  it('force-deletes a non-empty track', () => {
    const { p, gen } = base(); const t = applyAddTrack(p, gen, 'extra')
    applyAddLayer(p, gen, t, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1, 1), 0, 1_000_000)
    applyDeleteTrack(p, t, true)
    expect(p.tracks.find((x) => x.id === t)).toBeUndefined()
  })
  it('throws TrackNotFound for a missing track', () => {
    const { p } = base()
    expectCmd(() => applyDeleteTrack(p, 'ghost', false), 'TrackNotFound')
  })
})

describe('applyMoveTrack', () => {
  it('reorders a track to a new position', () => {
    const { p, gen } = base(); const t = applyAddTrack(p, gen, 'extra') // appended at idx 2
    applyMoveTrack(p, t, 0)
    expect(p.tracks[0].id).toBe(t)
  })
  it('throws TrackPositionOutOfRange when position >= len', () => {
    const { p } = base()
    expectCmd(() => applyMoveTrack(p, p.tracks[0].id, 9), 'TrackPositionOutOfRange')
  })
  it('throws TrackNotFound for a missing track', () => {
    const { p } = base()
    expectCmd(() => applyMoveTrack(p, 'ghost', 0), 'TrackNotFound')
  })
})
