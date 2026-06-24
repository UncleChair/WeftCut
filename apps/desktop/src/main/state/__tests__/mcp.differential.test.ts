import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize } from '../canonical'
import { replayMcpSequence, mcpSequenceIsSupported } from '../replay'

const ROOT = join(__dirname, '../../../../fixtures/state-corpus')
const SEQ = join(ROOT, 'sequences-mcp')
const ORACLE = join(ROOT, 'oracle-mcp')

/** Compare an MCP error envelope by code + structured data only (prose message
 *  is non-asserted per the plan's error-gating decision; the underlying
 *  CommandError variant is gated by the state/prod differentials). */
function errKey(env: any): unknown {
  if (env?.ok !== false) return null
  return { code: env.error.code, data: env.error.data ?? null }
}

describe('Phase 3d-a differential: TS mcpCall adapter === Rust dispatch_tool oracle', () => {
  const files = readdirSync(SEQ).filter((f) => f.endsWith('.json'))
  const skipped = files.filter((f) => !mcpSequenceIsSupported(JSON.parse(readFileSync(join(SEQ, f), 'utf8'))))

  it('every mcp corpus sequence is in-vocabulary (no silent skips)', () => {
    expect(skipped.sort(), `unexpectedly skipped: ${skipped.join(', ')}`).toEqual([])
  })

  for (const f of files) {
    it(`matches the mcp oracle for ${f}`, () => {
      const seq = JSON.parse(readFileSync(join(SEQ, f), 'utf8'))
      const oraclePath = join(ORACLE, f)
      expect(existsSync(oraclePath), `missing oracle-mcp ${f}`).toBe(true)
      const oracle = JSON.parse(readFileSync(oraclePath, 'utf8'))
      const trace = replayMcpSequence(seq)
      expect(trace.steps.length, `step count for ${f}`).toBe(oracle.steps.length)
      for (let i = 0; i < trace.steps.length; i++) {
        const ts: any = trace.steps[i], or: any = oracle.steps[i]
        const where = `${f} @ step ${i} (op=${ts.op})`
        expect(JSON.stringify(ts.state), `state ${where}`).toBe(JSON.stringify(canonicalize(or.state)))
        expect(ts.ok, `ok ${where}`).toBe(or.ok)
        if (ts.ok) expect(JSON.stringify(canonicalize(ts.env.result)), `result ${where}`).toBe(JSON.stringify(canonicalize(or.env.result)))
        else expect(errKey(ts.env), `error ${where}`).toEqual(errKey(or.env))
      }
    })
  }
})
