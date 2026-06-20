// Cross-language golden vectors for snap_frame_round. The SAME fixture is
// asserted by `native/src/state/time.rs::golden_vectors_match_fixture` against
// the Rust i128 implementation; a value that passes one side and fails the
// other is snap-math drift — exactly what this test exists to catch (see
// memory: snap_math_drift). Exact `toBe`: f64 (TS) and i128 (Rust) agree
// bit-for-bit on the frame grid up to hour-scale timelines.

import { describe, expect, it } from "vitest";
import fixture from "./snapFrameGolden.fixture.json";
import { snapFrameRound } from "./frames";

// snapFrameRound is wasm-backed now (the shared weftcut-eval crate, loaded by
// the global test setup). This golden verifies the wasm reproduces the fixture
// (single source) — it no longer checks that two hand-mirrored copies agree.

interface Case {
  name: string;
  fps_num: number;
  fps_den: number;
  samples: { t_us: number; expect: number }[];
}

describe("snap_frame_round golden vectors (cross-language)", () => {
  for (const c of (fixture as { cases: Case[] }).cases) {
    it(c.name, () => {
      for (const s of c.samples) {
        expect(snapFrameRound(s.t_us, c.fps_num, c.fps_den)).toBe(s.expect);
      }
    });
  }
});
