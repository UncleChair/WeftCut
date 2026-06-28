// Cross-language golden vectors for the sampled envelope contract. The SAME
// fixture is asserted by `native/src/audio/envelope.rs`; a change that
// passes one side and fails the other is engine drift — exactly what this
// test exists to catch.

import { describe, expect, it } from "vitest";
import fixture from "./audioEnvelopeGolden.fixture.json";
import { type Envelope, evalEnvelope, sampleGain, samplePan } from "./envelope";
import type { AnimTrack } from "../animated";
import { panCoeffsAt } from "./panGraph";

interface Case {
  name: string;
  gain_db: AnimTrack<number>;
  fade_in_us: number;
  fade_out_us: number;
  span_us: number;
  samples: { t_us: number; expect: number }[];
}

describe("audio envelope golden vectors (cross-language)", () => {
  for (const c of (fixture as { cases: Case[] }).cases) {
    it(c.name, () => {
      const e: Envelope = sampleGain(
        c.gain_db,
        c.fade_in_us,
        c.fade_out_us,
        c.span_us,
      );
      for (const s of c.samples) {
        expect(evalEnvelope(e, s.t_us)).toBeCloseTo(s.expect, 5);
      }
    });
  }
});

interface PanCase {
  name: string;
  pan: AnimTrack<number>;
  span_us: number;
  samples: { t_us: number; expect: number }[];
}
interface CoeffCase {
  name: string;
  pan: AnimTrack<number>;
  channels: number;
  span_us: number;
  samples: { t_us: number; expect: number[] }[];
}

const fx = fixture as unknown as { pan_cases?: PanCase[]; pan_coeff_env_cases?: CoeffCase[] };

describe("audio pan golden vectors (cross-language)", () => {
  for (const c of fx.pan_cases ?? []) {
    it(`pan: ${c.name}`, () => {
      const e = samplePan(c.pan, c.span_us);
      for (const s of c.samples) expect(evalEnvelope(e, s.t_us)).toBeCloseTo(s.expect, 5);
    });
  }
  for (const c of fx.pan_coeff_env_cases ?? []) {
    it(`pan coeff env: ${c.name}`, () => {
      const e = samplePan(c.pan, c.span_us);
      for (const s of c.samples) {
        const got = panCoeffsAt(e, c.channels, s.t_us);
        for (let i = 0; i < 4; i++) expect(got[i]).toBeCloseTo(s.expect[i]!, 5);
      }
    });
  }
});
