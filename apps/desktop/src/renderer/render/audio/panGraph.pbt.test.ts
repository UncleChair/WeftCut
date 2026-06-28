// Twin-PBT: pins the TS coefficient-lerp outer loop (panCoeffsAt) to an
// independent reference re-derived from the spec in docs/audio.md. The Rust twin
// pan_coeffs_at is pinned to the SAME spec by a proptest in
// native/src/audio/envelope.rs — together they guarantee cross-language parity
// without an in-process bridge. The leaf law (panCoeff) is shared WASM and cannot
// drift, so only the outer loop is fuzzed here.
import { describe, it } from 'vitest'
import fc from 'fast-check'
import { panCoeffsAt } from './panGraph'
import { panCoeff } from '../../eval'

const PBT_SEED = 0x5747_4354
const RUNS = Number(process.env.WEFTCUT_PBT_RUNS ?? 200)

function reference(values: number[], stepUs: number, channels: number, tUs: number): number[] {
  const coeff = (p: number) => [0, 1, 2, 3].map((k) => panCoeff(p, channels, k))
  const last = values.length - 1
  if (last <= 0) return coeff(values[0] ?? 0)
  const pos = Math.max(tUs, 0) / stepUs
  const i = Math.min(Math.floor(pos), last)
  if (i >= last) return coeff(values[last]!)
  const a = coeff(values[i]!), b = coeff(values[i + 1]!), frac = pos - i
  return a.map((av, k) => av + (b[k]! - av) * frac)
}

describe('twin-PBT: panCoeffsAt matches the independent reference', () => {
  it('agrees for all envelopes / channels / query times', () => {
    fc.assert(fc.property(
      fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 1, maxLength: 8 }),
      fc.constantFrom(10_000, 20_000),
      fc.constantFrom(1, 2),
      fc.integer({ min: -50_000, max: 200_000 }),
      (values, stepUs, channels, tUs) => {
        const got = panCoeffsAt({ values, stepUs } as any, channels, tUs)
        const exp = reference(values, stepUs, channels, tUs)
        for (let k = 0; k < 4; k++) if (Math.abs((got[k] ?? 0) - (exp[k] ?? 0)) > 1e-6) return false
        return true
      },
    ), { seed: PBT_SEED, numRuns: RUNS })
  })
})
