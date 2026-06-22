// apps/desktop/src/main/state/__tests__/differential.phase1.test.ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize } from '../canonical'
import { parseOracleErrorVariant } from '../errors'
import { replaySequence, sequenceIsSupported } from '../replay'

const ROOT = join(__dirname, '../../../../fixtures/state-corpus')
const SEQ = join(ROOT, 'sequences')
const ORACLE = join(ROOT, 'oracle')

describe('Phase 1 differential: TS actor === Rust oracle (in-vocabulary corpus)', () => {
  const files = readdirSync(SEQ).filter((f) => f.endsWith('.json'))
  const supported: string[] = []
  const skipped: string[] = []
  for (const f of files) {
    const seq = JSON.parse(readFileSync(join(SEQ, f), 'utf8'))
    ;(sequenceIsSupported(seq) ? supported : skipped).push(f)
  }

  it(`includes a meaningful in-vocabulary subset (included=${supported.length}, skipped=${skipped.length})`, () => {
    // Visibility: print exactly which sequences are deferred to Phase 2.
    console.log('[differential.phase1] skipped (out of Phase-1 vocabulary):', skipped.sort().join(', '))
    expect(supported.length).toBeGreaterThanOrEqual(20)
  })

  for (const f of supported) {
    it(`matches the oracle for ${f}`, () => {
      const seq = JSON.parse(readFileSync(join(SEQ, f), 'utf8'))
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
          const want = parseOracleErrorVariant(String(or.error))
          const got = parseOracleErrorVariant(String(ts.error)) // ts.error already "Top(Inner)"
          expect(got, `error variant ${where}`).toEqual(want)
        }
      }
    })
  }
})
