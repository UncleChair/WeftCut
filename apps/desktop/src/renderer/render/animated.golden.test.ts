import { describe, expect, it } from "vitest";
import type { AnimTrack } from "./animated";
import { resolveAnimated } from "./animated";
import fixture from "./animatedGolden.fixture.json";

// resolveAnimated is wasm-backed now (the shared weftcut-eval crate, loaded by
// the global test setup). This golden verifies the wasm reproduces the fixture
// (single source) — it no longer checks that two hand-mirrored engines agree.

interface Sample {
  t_us: number;
  expect: number;
}
interface Case {
  name: string;
  track: AnimTrack<number>;
  samples: Sample[];
}

// Same fixture is asserted by `state/animated.rs::golden_vectors_match_fixture`
// against the Rust engine. Both sides green = no engine drift.
describe("resolveAnimated golden vectors", () => {
  const cases = fixture.cases as unknown as Case[];
  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });
  for (const c of fixture.cases as unknown as Case[]) {
    it(c.name, () => {
      for (const s of c.samples) {
        expect(
          resolveAnimated(c.track, s.t_us, fixture.default),
          `t_us=${s.t_us}`,
        ).toBeCloseTo(s.expect, 6);
      }
    });
  }
});
