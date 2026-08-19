import { describe, it, expect } from 'vitest'
import { createDeferredLog, DEFERRED_LOG_CAPACITY, type DeferredLog } from './deferredLog'
import type { McpLogEntryInput } from './mcp/withLog'

function row(message: string): McpLogEntryInput {
  return { level: 'info', category: { kind: 'Mcp' }, source: { kind: 'System' }, message }
}

/** Flush and report what the replay saw, in the order it saw it. */
function drain(queue: DeferredLog): string[] {
  const replayed: string[] = []
  queue.flush((entry) => { replayed.push(entry.message) })
  return replayed
}

describe('deferredLog', () => {
  // Asserted against the literal, not the export: 50 is a fixed value of the
  // spec, so comparing the export to itself would gate nothing.
  it('holds the 50 entries the spec fixes', () => {
    expect(DEFERRED_LOG_CAPACITY).toBe(50)
  })

  it('replays in the order entries were produced', () => {
    const queue = createDeferredLog()
    queue.push(row('bind'))
    queue.push(row('connected'))
    queue.push(row('disconnected'))

    expect(drain(queue)).toEqual(['bind', 'connected', 'disconnected'])
  })

  it('drops the oldest entry once past the bound', () => {
    const queue = createDeferredLog()
    const overflow = 10
    for (let i = 0; i < DEFERRED_LOG_CAPACITY + overflow; i += 1) queue.push(row(`row-${i}`))

    const replayed = drain(queue)
    expect(replayed).toHaveLength(DEFERRED_LOG_CAPACITY)
    expect(replayed[0]).toBe(`row-${overflow}`)
    expect(replayed.at(-1)).toBe(`row-${DEFERRED_LOG_CAPACITY + overflow - 1}`)
  })

  // The app that never opens a workspace is the one this bound exists for: every
  // MCP request it serves produces rows with nowhere to go.
  it('stays bounded when no workspace ever opens', () => {
    const queue = createDeferredLog()
    for (let i = 0; i < 10_000; i += 1) queue.push(row(`row-${i}`))

    expect(queue.size).toBe(DEFERRED_LOG_CAPACITY)
  })

  it('leaves nothing behind to replay twice', () => {
    const queue = createDeferredLog()
    queue.push(row('bind'))

    expect(drain(queue)).toEqual(['bind'])
    expect(queue.size).toBe(0)
    expect(drain(queue)).toEqual([])
  })

  // The real emit reaches the same pre-workspace branch that fills this queue,
  // so a re-entrant push must not be replayed by the flush it arrived in.
  it('defers an entry produced during the replay to the next flush', () => {
    const queue = createDeferredLog()
    queue.push(row('bind'))

    const replayed: string[] = []
    queue.flush((entry) => {
      replayed.push(entry.message)
      if (entry.message === 'bind') queue.push(row('re-entrant'))
    })

    expect(replayed).toEqual(['bind'])
    expect(queue.size).toBe(1)
    expect(drain(queue)).toEqual(['re-entrant'])
  })
})
