// Cross-language golden vectors for snap_frame_round. The SAME fixture is
// asserted by `native/src/state/time.rs::golden_vectors_match_fixture` against
// the Rust i128 implementation; a value that passes one side and fails the
// other is snap-math drift — exactly what this test exists to catch (see
// memory: snap_math_drift). Exact `toBe`: f64 (TS) and i128 (Rust) agree
// bit-for-bit on the frame grid up to hour-scale timelines.

import { beforeAll, describe, expect, it } from "vitest";
import fixture from "./snapFrameGolden.fixture.json";
import { snapFrameRound } from "./frames";
import { initEval } from "./eval";

// snapFrameRound is now wasm-backed (the shared weftcut-eval crate); load it
// before asserting. The golden now verifies the wasm reproduces the fixture
// (single source), not that two hand-mirrored copies agree.
beforeAll(async () => {
  await initEval();
});

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
