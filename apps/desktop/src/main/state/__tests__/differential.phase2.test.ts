// apps/desktop/src/main/state/__tests__/differential.phase2.test.ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize } from '../canonical'
import { parseOracleErrorVariant } from '../errors'
import { replaySequence, sequenceIsSupported } from '../replay'

const ROOT = join(__dirname, '../../../../fixtures/state-corpus')
const SEQ = join(ROOT, 'sequences')
const ORACLE = join(ROOT, 'oracle')

describe('Phase 2a differential: TS actor === Rust oracle (FULL corpus)', () => {
  const files = readdirSync(SEQ).filter((f) => f.endsWith('.json'))
  const skipped = files.filter((f) => !sequenceIsSupported(JSON.parse(readFileSync(join(SEQ, f), 'utf8'))))

  it('every committed corpus sequence is now in-vocabulary (no silent skips)', () => {
    // Phase 2a lights up split_layer + groups_create; nothing committed should remain skipped.
    expect(skipped.sort(), `unexpectedly skipped: ${skipped.join(', ')}`).toEqual([])
  })

  for (const f of files) {
    it(`matches the oracle for ${f}`, () => {
      const seq = JSON.parse(readFileSync(join(SEQ, f), 'utf8'))
      expect(sequenceIsSupported(seq), `seq ${f} out of vocabulary`).toBe(true)
      const oraclePath = join(ORACLE, f)
      expect(existsSync(oraclePath), `missing oracle ${f}`).toBe(true)
      const oracle = JSON.parse(readFileSync(oraclePath, 'utf8'))
      const trace = replaySequence(seq)
      expect(trace.steps.length, `step count for ${f}`).toBe(oracle.steps.length)
      for (let i = 0; i < trace.steps.length; i++) {
        const ts = trace.steps[i], or = oracle.steps[i]
        const where = `${f} @ step ${i} (op=${ts.op})`
        expect(JSON.stringify(ts.state), `state ${where}`).toBe(JSON.stringify(canonicalize(or.state)))
        expect(ts.ok, `ok ${where}`).toBe(or.ok)
        if (!ts.ok) {
          expect(parseOracleErrorVariant(String(ts.error)), `error ${where}`).toEqual(parseOracleErrorVariant(String(or.error)))
        }
      }
    })
  }
})
