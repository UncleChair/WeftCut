import { describe, it, expect } from 'vitest'
import { History } from '../history'
import { blankProject } from '../model'
import { uuidV7Gen } from '../ids'

describe('HistoryView checkpoints carry actor', () => {
  it('includes the checkpoint actor', () => {
    const idGen = uuidV7Gen()
    const h = new History(blankProject(idGen, 'x'), { kind: 'User' }, idGen())
    h.checkpoint('cp', { kind: 'Agent', client: 'mcp' }, idGen())
    const v = h.view(10)
    expect(v.checkpoints[0].actor).toEqual({ kind: 'Agent', client: 'mcp' })
  })
})
