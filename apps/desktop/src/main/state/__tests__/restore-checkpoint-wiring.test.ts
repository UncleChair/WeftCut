import { describe, it, expect } from 'vitest'
import { createActor } from '../actor'
import { uuidV7Gen } from '../ids'
import { blankProject } from '../model'
import { routeChannel } from '../router'
import { routeMcpTool } from '../../mcp/mutationTools'

describe('project_restore_checkpoint wiring', () => {
  it('renderer channel routes to command and MCP routes to ts', () => {
    expect(routeChannel('project_restore_checkpoint')).toEqual({ kind: 'command' })
    expect(routeMcpTool('restore_checkpoint')).toBe('ts')
  })

  it('command(project_restore_checkpoint) restores a checkpoint by id', () => {
    const idGen = uuidV7Gen()
    const actor = createActor({ initial: blankProject(idGen, 't'), idGen, clock: () => '2026-01-01T00:00:00.000Z' })
    // create a checkpoint via the gated MCP path, capture its id
    const made = actor.mcpCall('checkpoint', JSON.stringify({ label: 'cp1' }))
    expect(made.ok).toBe(true)
    const cpId = (made as { ok: true; result: { content: Array<{ text: string }> } }).result.content[0].text
    // mutate so state diverges from the checkpoint
    actor.command('add_track', { })
    const before = actor.snapshot().tracks.length
    // restore via the renderer command channel
    const r = actor.command('project_restore_checkpoint', { checkpointId: cpId })
    expect(r.ok).toBe(true)
    expect(actor.snapshot().tracks.length).toBe(before - 1)
  })

  it('command(project_restore_checkpoint) with a bad uuid rejects before mutating', () => {
    const idGen = uuidV7Gen()
    const actor = createActor({ initial: blankProject(idGen, 't'), idGen, clock: () => '2026-01-01T00:00:00.000Z' })
    const r = actor.command('project_restore_checkpoint', { checkpointId: 'not-a-uuid' })
    expect(r.ok).toBe(false)
  })
})
