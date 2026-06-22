// apps/desktop/src/main/state/__tests__/summary.differential.test.ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize } from '../canonical'
import { parseOracleErrorVariant } from '../errors'
import { replaySummaries, sequenceIsSupported } from '../replay'

const ROOT = join(__dirname, '../../../../fixtures/state-corpus')
const SEQ = join(ROOT, 'sequences')
const ORACLE = join(ROOT, 'oracle-summary')

describe('Phase 3a differential: TS buildProjectSummary === Rust oracle (FULL corpus)', () => {
  const files = readdirSync(SEQ).filter((f) => f.endsWith('.json'))

  for (const f of files) {
    it(`summary matches the oracle for ${f}`, () => {
      const seq = JSON.parse(readFileSync(join(SEQ, f), 'utf8'))
      expect(sequenceIsSupported(seq), `seq ${f} out of vocabulary`).toBe(true)
      const oraclePath = join(ORACLE, f)
      expect(existsSync(oraclePath), `missing oracle-summary ${f}`).toBe(true)
      const oracle = JSON.parse(readFileSync(oraclePath, 'utf8'))
      const trace = replaySummaries(seq)
      expect(trace.steps.length, `step count for ${f}`).toBe(oracle.steps.length)
      for (let i = 0; i < trace.steps.length; i++) {
        const ts = trace.steps[i], or = oracle.steps[i]
        const where = `${f} @ step ${i} (op=${ts.op})`
        expect(JSON.stringify(ts.summary), `summary ${where}`).toBe(JSON.stringify(canonicalize(or.summary)))
        expect(ts.ok, `ok ${where}`).toBe(or.ok)
        if (!ts.ok) {
          expect(parseOracleErrorVariant(String(ts.error)), `error ${where}`).toEqual(parseOracleErrorVariant(String(or.error)))
        }
      }
    })
  }
})
