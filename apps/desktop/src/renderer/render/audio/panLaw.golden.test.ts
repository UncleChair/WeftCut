// Cross-language golden for the pan law. The SAME fixture is asserted by
// native/eval/src/lib.rs::pan_law_golden_matches_fixture against the native
// pan_coeffs; a value passing one side and failing the other is pan-law drift.
import { describe, expect, it } from "vitest";
import fixture from "./panLawGolden.fixture.json";
import { panCoeff } from "../../eval";

interface Coeff { name: string; pan: number; channels: number; expect: number[] }
interface Apply { name: string; pan: number; channels: number; in: number[]; expect: number[] }

const fx = fixture as { coeff_cases: Coeff[]; apply_cases: Apply[] };

describe("pan law golden (cross-language)", () => {
  for (const c of fx.coeff_cases) {
    it(`coeff: ${c.name}`, () => {
      for (let i = 0; i < 4; i++) {
        expect(panCoeff(c.pan, c.channels, i)).toBeCloseTo(c.expect[i]!, 5);
      }
    });
  }
  for (const a of fx.apply_cases) {
    it(`apply: ${a.name}`, () => {
      const [ka, kb, kc, kd] = [0, 1, 2, 3].map((i) => panCoeff(a.pan, a.channels, i));
      const [l, r] = a.in as [number, number];
      expect(ka! * l + kb! * r).toBeCloseTo(a.expect[0]!, 5);
      expect(kc! * l + kd! * r).toBeCloseTo(a.expect[1]!, 5);
    });
  }
});
