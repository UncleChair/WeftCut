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

/** Normalize an MCP result for comparison: parse any content text-block that is
 *  itself JSON so non-semantic float formatting (Rust ryu `0.0` vs JS `0`, both
 *  the same Number once a client JSON.parses the text) doesn't fail the gate.
 *  Real differences survive — different numbers/keys/ids parse differently.
 *  Raw-text results (id-tool uuids) don't parse as JSON → kept verbatim. */
function resultKey(result: any): unknown {
  const content = (result?.content ?? []).map((b: any) => {
    if (b?.type === 'text' && typeof b.text === 'string') {
      try { return { type: 'text', json: canonicalize(JSON.parse(b.text)) } } catch { return b }
    }
    return b
  })
  return canonicalize({ ...result, content })
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
        if (ts.ok) expect(JSON.stringify(resultKey(ts.env.result)), `result ${where}`).toBe(JSON.stringify(resultKey(or.env.result)))
        else expect(errKey(ts.env), `error ${where}`).toEqual(errKey(or.env))
      }
    })
  }
})
