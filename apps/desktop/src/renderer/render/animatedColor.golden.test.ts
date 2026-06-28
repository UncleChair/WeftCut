import { describe, expect, it } from "vitest";
import type { AnimTrack } from "./animated";
import { resolveAnimatedColor } from "./animated";
import type { Rgba } from "../ipc";
import fixture from "./animatedColorGolden.fixture.json";

// resolveAnimatedColor is wasm-backed (the shared weftcut-eval crate, loaded by
// the global test setup). This golden verifies the wasm preview reproduces the
// SAME fixture as the native `state/animated.rs::golden_color_vectors_match_fixture`
// — both green ⇒ native↔wasm color parity (no OkLab/premult drift across the
// boundary). The fixture itself is externally anchored to Chromium oklab.

interface Sample {
  t_us: number;
  expect: Rgba;
}
interface Case {
  name: string;
  track: AnimTrack<Rgba>;
  samples: Sample[];
}

describe("resolveAnimatedColor golden vectors", () => {
  const cases = fixture.cases as unknown as Case[];
  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });
  for (const c of cases) {
    it(c.name, () => {
      for (const s of c.samples) {
        const got = resolveAnimatedColor(c.track, s.t_us, fixture.default as Rgba);
        const ctx = `${c.name} t_us=${s.t_us}`;
        // Per-channel within ±1 (last-ULP rounding slack vs the external anchor).
        expect(Math.abs(got.r - s.expect.r), `${ctx} r`).toBeLessThanOrEqual(1);
        expect(Math.abs(got.g - s.expect.g), `${ctx} g`).toBeLessThanOrEqual(1);
        expect(Math.abs(got.b - s.expect.b), `${ctx} b`).toBeLessThanOrEqual(1);
        expect(Math.abs(got.a - s.expect.a), `${ctx} a`).toBeLessThanOrEqual(1);
      }
    });
  }
});
