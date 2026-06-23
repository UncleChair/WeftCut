// apps/desktop/src/main/state/__tests__/commands.differential.test.ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize } from '../canonical'
import { parseOracleErrorVariant } from '../errors'
import { replayProductionSequence, productionSequenceIsSupported } from '../replay'

const ROOT = join(__dirname, '../../../../fixtures/state-corpus')
const SEQ = join(ROOT, 'sequences-prod')
const ORACLE = join(ROOT, 'oracle-prod')

describe('Phase 3c-ii-a differential: TS production adapter === Rust dispatch oracle', () => {
  const files = readdirSync(SEQ).filter((f) => f.endsWith('.json'))
  const skipped = files.filter((f) => !productionSequenceIsSupported(JSON.parse(readFileSync(join(SEQ, f), 'utf8'))))

  it('every production corpus sequence is in-vocabulary (no silent skips)', () => {
    expect(skipped.sort(), `unexpectedly skipped: ${skipped.join(', ')}`).toEqual([])
  })

  for (const f of files) {
    it(`matches the prod oracle for ${f}`, () => {
      const seq = JSON.parse(readFileSync(join(SEQ, f), 'utf8'))
      const oraclePath = join(ORACLE, f)
      expect(existsSync(oraclePath), `missing oracle-prod ${f}`).toBe(true)
      const oracle = JSON.parse(readFileSync(oraclePath, 'utf8'))
      const trace = replayProductionSequence(seq)
      expect(trace.steps.length, `step count for ${f}`).toBe(oracle.steps.length)
      for (let i = 0; i < trace.steps.length; i++) {
        const ts = trace.steps[i], or = oracle.steps[i]
        const where = `${f} @ step ${i} (op=${ts.op})`
        expect(JSON.stringify(ts.state), `state ${where}`).toBe(JSON.stringify(canonicalize(or.state)))
        expect(ts.ok, `ok ${where}`).toBe(or.ok)
        if (!ts.ok) expect(parseOracleErrorVariant(String(ts.error)), `error ${where}`).toEqual(parseOracleErrorVariant(String(or.error)))
      }
    })
  }
})
